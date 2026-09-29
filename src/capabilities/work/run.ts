// work/run.ts — the managed command runner behind `run`, `run_status` and
// `run_cancel` (bob#211, slice 1 of bob#210).
//
// WHY THIS EXISTS. A local-model builder with raw `bash` ran commands with no
// deadline (pi's bash has no default timeout) and, to stop them, reached for a
// pattern kill that matched its own runtime. This runner owns execution instead:
//   * every command has an effective deadline, even when the caller names none;
//   * it owns the process group of every job it starts, and cancels only those,
//     by the recorded group id — never by a name or a command line;
//   * the command's OUTCOME and the CLEANUP of its group are reported as two
//     separate, closed enumerations, and only a verified clean exit 0 is success.
//
// REUSE (bob#211 acceptance: "reuse pi's primitives by import"). pi 0.84.3
// exports `getShellConfig` (which shell, which argv) and `truncateTail` /
// `formatSize` from its package root; this module imports and uses them
// (`PI_PRIMITIVES` pins the identity for a test). pi does NOT export its
// process-tree kill or its child wait (utils/shell.js `killProcessTree`,
// utils/child-process.js `waitForChildProcess`), and its `exports` map forbids
// a deep import. The group signal/probe is bob's own (src/shell/process-group.ts,
// shared with the tps-mail consumer). The wait is deliberately NOT pi's:
// `waitForChildProcess` keeps reading while a detached descendant writes to the
// inherited pipe, and this runner must stop draining at a bound, not at EOF.
//
// LIMITS (stated where a reader meets them — the tool descriptions, the role
// soul and every result's closing line): a process-group backend, the same
// user, not a sandbox. A descendant that leaves the job's process group is
// beyond a group kill; `cleanup_state` reports only what was verified.

import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { formatSize, getShellConfig, truncateTail } from "@earendil-works/pi-coding-agent";
import {
  type GroupOps,
  isOwnedGroupId,
  NODE_GROUP_OPS,
  probeGroup,
} from "../../shell/process-group.js";
import { redactSecrets } from "../observatory/sanitize.js";

// The primitives this runner takes from pi and from bob's shell, by identity, so
// a test can assert the reuse is an import and not a copy.
export const PI_PRIMITIVES = Object.freeze({ getShellConfig, truncateTail, formatSize });
export const GROUP_PRIMITIVES = Object.freeze({ NODE_GROUP_OPS, probeGroup });

// --- limits (fixed in slice 1; no bob.yaml path can change them) -------------

// The deadline a command gets when the caller names none, and the ceiling a
// named one is capped at. Slice 1 has no run budget to clamp to; that clamp
// lands with the supervisor-owned deadline (bob#210 slice 4).
export const DEFAULT_TIMEOUT_S = 600;
export const MAX_TIMEOUT_S = 3600;
// SIGTERM → wait this long for the group to empty → SIGKILL.
export const KILL_GRACE_MS = 3000;
// After SIGKILL, how long to keep probing for the group before giving up.
export const REAP_LIMIT_MS = 2000;
// After the job's group is gone, how long the output pipes may stay open before
// draining stops. A pipe still open then is held by a process OUTSIDE the group.
export const DRAIN_GRACE_MS = 500;
// Jobs one bob run may have running at once.
export const MAX_LIVE_JOBS = 8;
// The most bytes of one job's output kept on disk; the rest is counted, not kept.
export const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
// The excerpt the model sees: a tail of at most this many bytes and lines.
export const EXCERPT_MAX_BYTES = 16 * 1024;
export const EXCERPT_MAX_LINES = 400;
// Extra bytes read before the excerpt window and redacted with it, so a secret
// that straddles the cut is redacted whole before the cut is made.
export const REDACTION_MARGIN_BYTES = 8 * 1024;
// A finished run's job records are kept this long after the run ended, then the
// next boot sweep deletes them. Output captures are deleted when the run ends.
export const REGISTRY_RETENTION_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 20;

// The closing line of every result: what this tool is not.
export const LIMITS_TEXT =
  "Limits: process-group backend running as the same user; NOT a sandbox or containment. " +
  "Descendants that leave the job's process group may survive, and cleanup_state reports only what was verified. " +
  "Cancellation covers only jobs this tool started.";

// --- the two orthogonal enumerations ------------------------------------------

// What happened to the COMMAND.
export type Outcome = "exited" | "timed_out" | "signalled" | "cancelled" | "no_exit_status";
// What the tool VERIFIED about the job's process group afterwards.
export type CleanupState =
  | "group_empty" // no process remained in the group; the tool signalled nothing
  | "group_killed" // the tool signalled the group and verified it empty
  | "escaped_or_unverified" // something may survive (see README)
  | "verify_unavailable"; // the tool could not check at all
export type CancelReason = "run_cancel" | "run_end" | "abort" | "boot_reap";
export type TimeoutSource = "default" | "requested" | "clamped";

type Phase = "running" | "exited" | "timing_out" | "cancelling" | "finished";

// A refusal the model gets as a tool error: actor + state + remedy.
export class RunRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRefusal";
  }
}

// --- the on-disk registry ------------------------------------------------------

// One record per job, in the run's own state directory, keyed by process group:
// `<runDir>/jobs/pg-<pgid>.<run_id>.json`. It carries a digest of the command,
// never the command (a command line can carry a secret).
export interface RegistryEntry {
  v: 1;
  run_id: string;
  pgid: number;
  supervisor_pid: number;
  started_at: string;
  deadline_at: string;
  timeout_s: number;
  command_sha256: string;
  cwd: string;
  background: boolean;
  output_ref: string;
  // `ps -o lstart=` of the group leader, taken after spawn. The boot sweep
  // signals a dead run's group only when its leader still matches this.
  leader_start: string | null;
  state: "running" | "finished";
  outcome?: Outcome;
  exit_code?: number | null;
  signal?: string | null;
  escalated?: boolean;
  cleanup_state?: CleanupState;
  output_complete?: boolean;
  cancel_reason?: CancelReason;
  finished_at?: string;
  reaped_by?: { pid: number; at: string; signalled: boolean; note: string };
}

// What `run`, `run_status` and `run_cancel` report for one job.
export interface JobReport {
  run_id: string;
  state: "running" | "finished";
  outcome: Outcome | null;
  exit_code: number | null;
  signal: string | null;
  escalated: boolean;
  cleanup_state: CleanupState | null;
  success: boolean;
  effective_timeout_s: number;
  timeout_source: TimeoutSource;
  background: boolean;
  pgid: number;
  elapsed_s: number;
  output_ref: string;
  output_complete: boolean;
  output_bytes: number;
  output_dropped_bytes: number;
  output_excerpt: string;
  output_excerpt_truncated: boolean;
  redactions: number;
  cancel_reason: CancelReason | null;
}

interface Job {
  runId: string;
  pgid: number;
  child: ChildProcess;
  background: boolean;
  startedAt: number;
  deadlineAt: number;
  timeoutS: number;
  timeoutSource: TimeoutSource;
  commandSha: string;
  cwd: string;
  capturePath: string;
  entryPath: string;
  captureFd: number | null;
  captureBytes: number;
  droppedBytes: number;
  captureFailed: boolean;
  stdoutEnded: boolean;
  stderrEnded: boolean;
  drainCut: boolean;
  phase: Phase;
  outcome: Outcome | null;
  exitCode: number | null;
  exitSignal: string | null;
  escalated: boolean;
  cleanup: CleanupState | null;
  cancelReason: CancelReason | null;
  finishedAt: number | null;
  leaderStart: string | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  eof: Promise<void>;
  done: Promise<void>;
  resolveDone: () => void;
}

export interface JobManagerOptions {
  // Where run directories live. Default: <os tmpdir>/bob-work-<uid>, an
  // owner-only directory outside any workspace. Tests pass a scratch dir.
  stateRoot?: string;
  defaultTimeoutS?: number;
  maxTimeoutS?: number;
  killGraceMs?: number;
  reapLimitMs?: number;
  drainGraceMs?: number;
  maxLiveJobs?: number;
  captureMaxBytes?: number;
  groupOps?: GroupOps;
  // Test seam: rewrite the leader's exit report as the OS gave it (code, signal).
  observeExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => { code: number | null; signal: NodeJS.Signals | null };
  log?: (msg: string) => void;
}

export interface StartRequest {
  command?: unknown;
  cwd?: unknown;
  timeout_s?: unknown;
  background?: unknown;
}

// --- helpers -------------------------------------------------------------------

export function defaultStateRoot(): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `bob-work-${uid}`);
}

// The canonical form of a path that may not exist yet: the realpath of its
// nearest existing ancestor plus the rest. (On macOS the temp dir is reached
// through the /var → /private/var symlink; comparisons must see through it.)
function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// An owner-only directory: a real directory (not a symlink), owned by this user,
// with no group or world bits. Created when `create` is set and it is missing.
function ensurePrivateDir(path: string, create: boolean): void {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new RunRefusal(
          `run refused: the job state directory ${path} could not be created (${(err as NodeJS.ErrnoException).code ?? "error"}). The run tool keeps job output there; check the temp directory is writable.`,
        );
      }
    }
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new RunRefusal(
      `run refused: the job state directory ${path} is not a plain directory (a symlink or a file is there). Remove it; the run tool recreates it owner-only.`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) {
    throw new RunRefusal(
      `run refused: the job state directory ${path} is owned by uid ${st.uid}, not this user (${uid}). Another account created it; remove it so the run tool can recreate it owner-only.`,
    );
  }
  if ((st.mode & 0o077) !== 0) {
    throw new RunRefusal(
      `run refused: the job state directory ${path} has mode ${(st.mode & 0o777).toString(8)}, readable by other users. Run chmod 700 on it (or remove it); the run tool keeps job output owner-only.`,
    );
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((r) => {
    timer = setTimeout(r, ms);
  });
  return { promise, cancel: () => timer && clearTimeout(timer) };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The group leader's start time, as `ps` prints it (1 s resolution), in a fixed
// locale and zone so two readings compare as strings. Null when `ps` cannot say.
export function readLeaderStart(pid: number, timeoutMs = 2000): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: timeoutMs, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
      (err, stdout) => {
        if (err) return done(null);
        const s = String(stdout).trim();
        done(s === "" ? null : s);
      },
    );
  });
}

// How many NON-zombie processes are in group `pgid`, from `ps` (synchronous, for
// the exit path). Null when `ps` cannot say.
function liveGroupMembers(pgid: number): number | null {
  const r = spawnSync("ps", ["-A", "-o", "pgid=,stat="], {
    encoding: "utf8",
    timeout: 2000,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  let live = 0;
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (m && Number(m[1]) === pgid && !m[2].startsWith("Z")) live += 1;
  }
  return live;
}

// Remove terminal control sequences and stray control characters, keeping tab,
// newline and carriage return, so an excerpt is plain text.
function plainText(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escapes is the point
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

export interface Excerpt {
  text: string;
  truncated: boolean;
  redactions: number;
  bytes: number;
}

// The tail of a capture file, redacted BEFORE it is cut. The window read is the
// excerpt size plus a margin; when it does not start at the top of the file, the
// partial first line is dropped, so a secret straddling the window start is not
// half-shown. The redactor runs over the whole window, then pi's truncateTail
// makes the cut — so a secret straddling the excerpt cut is already replaced.
export function readExcerpt(
  path: string,
  opts: { maxBytes?: number; maxLines?: number; marginBytes?: number } = {},
): Excerpt {
  const maxBytes = opts.maxBytes ?? EXCERPT_MAX_BYTES;
  const maxLines = opts.maxLines ?? EXCERPT_MAX_LINES;
  const margin = opts.marginBytes ?? REDACTION_MARGIN_BYTES;
  // Read-only, never through a symlink, and only a regular file. The runner
  // passes a capture it created exclusively in its own mkdtemp'd run directory.
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch {
    return { text: "", truncated: false, redactions: 0, bytes: 0 };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { text: "", truncated: false, redactions: 0, bytes: 0 };
    const size = st.size;
    const start = Math.max(0, size - (maxBytes + margin));
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    let text = buf.subarray(0, off).toString("utf8");
    const headCut = start > 0;
    if (headCut) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const red = redactSecrets(plainText(text));
    const tail = truncateTail(red.text, { maxBytes, maxLines });
    return {
      text: tail.content,
      truncated: headCut || tail.truncated,
      redactions: red.redactions,
      bytes: size,
    };
  } finally {
    closeSync(fd);
  }
}

// --- the manager ---------------------------------------------------------------

// One manager per bob run (pi extension instance). It owns the jobs it started,
// their registry records and their output captures.
export class JobManager {
  readonly stateRoot: string;
  // The run's own directory, created on the first `run` by mkdtemp under the
  // state root: a fresh, unpredictable name, mode 0700. Null until then.
  private dirs: { run: string; jobs: string; out: string } | null = null;
  private readonly jobs = new Map<string, Job>();
  private seq = 0;
  private ended = false;
  private readonly defaultTimeoutS: number;
  private readonly maxTimeoutS: number;
  private readonly killGraceMs: number;
  private readonly reapLimitMs: number;
  private readonly drainGraceMs: number;
  private readonly maxLiveJobs: number;
  private readonly captureMaxBytes: number;
  private readonly groupOps: GroupOps;
  private readonly observeExit: NonNullable<JobManagerOptions["observeExit"]>;
  private readonly log: (msg: string) => void;

  constructor(opts: JobManagerOptions = {}) {
    this.stateRoot = opts.stateRoot ?? defaultStateRoot();
    this.defaultTimeoutS = opts.defaultTimeoutS ?? DEFAULT_TIMEOUT_S;
    this.maxTimeoutS = opts.maxTimeoutS ?? MAX_TIMEOUT_S;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    this.reapLimitMs = opts.reapLimitMs ?? REAP_LIMIT_MS;
    this.drainGraceMs = opts.drainGraceMs ?? DRAIN_GRACE_MS;
    this.maxLiveJobs = opts.maxLiveJobs ?? MAX_LIVE_JOBS;
    this.captureMaxBytes = opts.captureMaxBytes ?? CAPTURE_MAX_BYTES;
    this.groupOps = opts.groupOps ?? NODE_GROUP_OPS;
    this.observeExit = opts.observeExit ?? ((code, signal) => ({ code, signal }));
    this.log = opts.log ?? ((m: string) => console.error(m));
    liveManagers().add(this);
  }

  // --- validation ----------------------------------------------------------

  // The deadline is never absent: an omitted timeout gets the default, a
  // non-positive or non-numeric one is refused by name, a larger one is capped.
  resolveTimeout(raw: unknown): { seconds: number; source: TimeoutSource } {
    if (raw === undefined || raw === null) {
      return { seconds: this.defaultTimeoutS, source: "default" };
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new RunRefusal(
        `run refused: timeout_s must be a number of seconds greater than 0; got ${JSON.stringify(raw)}. Omit timeout_s for the ${this.defaultTimeoutS} s default, or pass a positive number (at most ${this.maxTimeoutS}).`,
      );
    }
    if (raw > this.maxTimeoutS) return { seconds: this.maxTimeoutS, source: "clamped" };
    return { seconds: raw, source: "requested" };
  }

  private resolveCwd(ctxCwd: string | undefined, raw: unknown): string {
    if (typeof ctxCwd !== "string" || ctxCwd === "") {
      throw new RunRefusal(
        "run refused: pi supplied no tool execution context cwd, so there is no workspace to run in. This is a wiring fault in the session, not in the command.",
      );
    }
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      throw new RunRefusal(
        `run refused: cwd must be a string path; got ${typeof raw}. Omit it to run in the workspace.`,
      );
    }
    const dir = raw === undefined || raw === null || raw === "" ? ctxCwd : resolve(ctxCwd, raw);
    let ok = false;
    try {
      ok = statSync(dir).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new RunRefusal(
        `run refused: cwd ${JSON.stringify(raw ?? ctxCwd)} (resolved to ${dir}) is not an existing directory. Pass an existing directory, relative to the workspace, or omit cwd.`,
      );
    }
    return dir;
  }

  private ensureRunDir(workspaces: string[]): { run: string; jobs: string; out: string } {
    for (const w of workspaces) {
      if (isInside(w, this.stateRoot)) {
        throw new RunRefusal(
          `run refused: the job state directory ${this.stateRoot} is inside the workspace ${w}, where captured output would become a committable stray file. Run bob with a temp directory (TMPDIR) outside the workspace.`,
        );
      }
    }
    if (this.dirs !== null) return this.dirs;
    // The tool's own base: owner-only, verified (not a symlink, this user's,
    // no group/world bits) before anything is created under it.
    ensurePrivateDir(this.stateRoot, true);
    // The run's directory: mkdtemp picks a fresh, unpredictable name and
    // creates it 0700 — never a predictable path, never an existing entry.
    let run: string;
    try {
      run = mkdtempSync(join(this.stateRoot, "run-"));
    } catch (err) {
      throw new RunRefusal(
        `run refused: a private run directory could not be created under ${this.stateRoot} (${(err as NodeJS.ErrnoException).code ?? "error"}). Nothing was started; check the temp directory is writable.`,
      );
    }
    ensurePrivateDir(run, false);
    const dirs = { run, jobs: join(run, "jobs"), out: join(run, "out") };
    mkdirSync(dirs.jobs, { mode: 0o700 });
    mkdirSync(dirs.out, { mode: 0o700 });
    writeJsonAtomic(join(run, "run.json"), {
      v: 1,
      supervisor_pid: process.pid,
      started_at: new Date().toISOString(),
    });
    this.dirs = dirs;
    return dirs;
  }

  // The run's own directory, or null before the first `run` created it.
  get runDir(): string | null {
    return this.dirs?.run ?? null;
  }

  // --- start -----------------------------------------------------------------

  async start(req: StartRequest, ctxCwd: string | undefined): Promise<Job> {
    if (this.ended) {
      throw new RunRefusal(
        "run refused: this bob run has ended and its jobs were cancelled; no new job can start in it.",
      );
    }
    if (process.platform === "win32") {
      throw new RunRefusal(
        "run refused: the run tool's process-group backend needs a POSIX host; this host is win32.",
      );
    }
    if (typeof req.command !== "string" || req.command.trim() === "") {
      throw new RunRefusal("run refused: command must be a non-empty string.");
    }
    const command = req.command;
    const timeout = this.resolveTimeout(req.timeout_s);
    const cwd = this.resolveCwd(ctxCwd, req.cwd);
    const live = [...this.jobs.values()].filter((j) => j.phase !== "finished");
    if (live.length >= this.maxLiveJobs) {
      throw new RunRefusal(
        `run refused: this run already has ${live.length} running job${live.length === 1 ? "" : "s"} (${live.map((j) => j.runId).join(", ")}), the most one run may hold. Wait for one to finish (run_status) or stop one (run_cancel), then retry.`,
      );
    }
    const dirs = this.ensureRunDir(ctxCwd === undefined ? [cwd] : [ctxCwd, cwd]);

    const shell = PI_PRIMITIVES.getShellConfig();
    if (shell.commandTransport === "stdin") {
      throw new RunRefusal(
        `run refused: the resolved shell (${shell.shell}) takes its command on stdin, which the run tool does not support.`,
      );
    }

    this.seq += 1;
    const runId = `run-${this.seq}`;
    const capturePath = join(dirs.out, `${runId}.log`);
    // Exclusive creation, owner-only, never through an existing entry: O_EXCL
    // refuses anything already at the path (a file, a dangling or live
    // symlink), and O_NOFOLLOW refuses a symlink outright.
    let captureFd: number;
    try {
      captureFd = openSync(
        capturePath,
        fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW,
        0o600,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      const why =
        code === "EEXIST" || code === "ELOOP"
          ? "something already occupies that path in this run's private directory"
          : "the file system refused it";
      throw new RunRefusal(
        `run refused: the capture file ${capturePath} could not be created exclusively (${code}); ${why}. Nothing was started, and nothing was written through it. Retry: the next job gets a new capture path.`,
      );
    }

    let child: ChildProcess;
    try {
      // Detached: the child leads its own session and process group
      // (pgid = its pid), as pi's bash tool starts Unix commands. stdin is
      // closed, as in pi's bash; the environment is bob's own (pi's bash also
      // prepends pi's tool bin directory to PATH through a helper it does not
      // export).
      child = spawn(shell.shell, [...shell.args, command], {
        cwd,
        detached: true,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      closeSync(captureFd);
      rmSync(capturePath, { force: true });
      throw new RunRefusal(
        `run could not start ${shell.shell}: ${(err as Error).message}. Nothing was started.`,
      );
    }
    if (child.pid === undefined) {
      const code = await new Promise<string>((done) => {
        const t = setTimeout(() => done("no pid"), 1000);
        child.once("error", (e: NodeJS.ErrnoException) => {
          clearTimeout(t);
          done(e.code ?? e.message);
        });
      });
      closeSync(captureFd);
      rmSync(capturePath, { force: true });
      throw new RunRefusal(
        `run could not start ${shell.shell} (${code}). Nothing was started; check the shell exists and the workspace is accessible.`,
      );
    }

    const startedAt = Date.now();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    let resolveEof!: () => void;
    const eof = new Promise<void>((r) => {
      resolveEof = r;
    });
    const job: Job = {
      runId,
      pgid: child.pid,
      child,
      background: req.background === true,
      startedAt,
      deadlineAt: startedAt + timeout.seconds * 1000,
      timeoutS: timeout.seconds,
      timeoutSource: timeout.source,
      commandSha: createHash("sha256").update(command).digest("hex"),
      cwd,
      capturePath,
      entryPath: join(dirs.jobs, `pg-${child.pid}.${runId}.json`),
      captureFd,
      captureBytes: 0,
      droppedBytes: 0,
      captureFailed: false,
      stdoutEnded: child.stdout === null,
      stderrEnded: child.stderr === null,
      drainCut: false,
      phase: "running",
      outcome: null,
      exitCode: null,
      exitSignal: null,
      escalated: false,
      cleanup: null,
      cancelReason: null,
      finishedAt: null,
      leaderStart: null,
      deadlineTimer: null,
      eof,
      done,
      resolveDone,
    };
    this.jobs.set(runId, job);

    const onData = (chunk: Buffer) => this.capture(job, chunk);
    const checkEof = () => {
      if (job.stdoutEnded && job.stderrEnded) resolveEof();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.once("end", () => {
      job.stdoutEnded = true;
      checkEof();
    });
    child.stderr?.once("end", () => {
      job.stderrEnded = true;
      checkEof();
    });
    checkEof();
    child.on("error", () => {
      // After a successful spawn this is a failed kill() on the handle; the group
      // probes decide cleanup, so there is nothing to record here.
    });
    child.once("exit", (code, signal) => this.onLeaderExit(job, code, signal));

    // The deadline: a timer of the tool's own, independent of the child's I/O.
    job.deadlineTimer = setTimeout(
      () => void this.onDeadline(job),
      Math.max(0, job.deadlineAt - Date.now()),
    );

    this.writeEntry(job);
    const leaderStart = await readLeaderStart(job.pgid);
    if (leaderStart !== null && job.phase !== "finished") {
      job.leaderStart = leaderStart;
      this.writeEntry(job);
    }
    return job;
  }

  private capture(job: Job, chunk: Buffer): void {
    if (job.captureFd === null || job.captureFailed) {
      job.droppedBytes += chunk.length;
      return;
    }
    const room = this.captureMaxBytes - job.captureBytes;
    if (room <= 0) {
      job.droppedBytes += chunk.length;
      return;
    }
    let data = chunk;
    if (chunk.length > room) {
      job.droppedBytes += chunk.length - room;
      data = chunk.subarray(0, room);
    }
    try {
      let off = 0;
      while (off < data.length) {
        const n = writeSync(job.captureFd, data, off, data.length - off);
        if (n <= 0) throw new Error("short write");
        off += n;
      }
      job.captureBytes += data.length;
    } catch {
      job.captureFailed = true;
      job.droppedBytes += data.length;
    }
  }

  // --- the three ways a job ends ---------------------------------------------

  private onLeaderExit(job: Job, rawCode: number | null, rawSignal: NodeJS.Signals | null): void {
    const seen = this.observeExit(rawCode, rawSignal);
    job.exitCode = seen.code;
    job.exitSignal = seen.signal;
    // A deadline, a cancel or the run end already owns this job's completion; the
    // exit status is recorded, the outcome it set stands.
    if (job.phase !== "running") return;
    job.phase = "exited";
    job.outcome =
      seen.code !== null ? "exited" : seen.signal !== null ? "signalled" : "no_exit_status";
    // Anything the command left in its group is still this job's: end it.
    void this.complete(job);
  }

  private async onDeadline(job: Job): Promise<void> {
    if (job.phase !== "running") return;
    job.phase = "timing_out";
    job.outcome = "timed_out";
    await this.complete(job);
  }

  // Cancel one job. The report is always the job's REAL terminal outcome: a job
  // whose exit the tool had already observed is reported as it ended (never as
  // cancelled), and a second cancel is idempotent.
  async cancel(
    runId: unknown,
    reason: CancelReason = "run_cancel",
  ): Promise<{ job: Job; note: "cancelled" | "already_finished" | "already_cancelled" }> {
    const job = this.get(runId, "run_cancel");
    const note = await this.cancelJob(job, reason);
    return { job, note };
  }

  private async cancelJob(
    job: Job,
    reason: CancelReason,
  ): Promise<"cancelled" | "already_finished" | "already_cancelled"> {
    if (job.phase === "cancelling") {
      await job.done;
      return "already_cancelled";
    }
    if (job.phase === "finished") {
      return job.outcome === "cancelled" ? "already_cancelled" : "already_finished";
    }
    if (job.phase !== "running") {
      await job.done;
      return "already_finished";
    }
    // Give an exit that already happened one turn of the event loop to be
    // observed before deciding this is a cancellation.
    await new Promise<void>((r) => setImmediate(r));
    if ((job.phase as Phase) !== "running") return this.cancelJob(job, reason);
    job.phase = "cancelling";
    job.outcome = "cancelled";
    job.cancelReason = reason;
    await this.complete(job);
    return "cancelled";
  }

  // End the job's group (a group already empty is left alone), stop draining at
  // a bound, record the cleanup that was verified, and finish the record.
  private async complete(job: Job): Promise<void> {
    if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
    job.deadlineTimer = null;
    let cleanup: CleanupState;
    try {
      const t = await this.terminateGroup(job.pgid);
      job.escalated = job.escalated || t.escalated;
      cleanup = t.cleanup;
    } catch {
      cleanup = "verify_unavailable";
    }
    const drained = await this.drain(job);
    // The group is gone but the output pipe is still open: a process OUTSIDE the
    // group holds it. That is a survivor, so the cleanup is not clean.
    if (!drained && (cleanup === "group_empty" || cleanup === "group_killed")) {
      cleanup = "escaped_or_unverified";
    }
    job.cleanup = cleanup;
    this.finalize(job);
  }

  // Draining is bounded: it waits for EOF at most drainGraceMs after the group
  // is gone, then stops — it never waits for EOF itself.
  private async drain(job: Job): Promise<boolean> {
    if (job.stdoutEnded && job.stderrEnded) return true;
    const wait = sleep(this.drainGraceMs);
    const ended = await Promise.race([job.eof.then(() => true), wait.promise.then(() => false)]);
    wait.cancel();
    if (!ended) {
      job.drainCut = true;
      job.child.stdout?.destroy();
      job.child.stderr?.destroy();
    }
    return ended;
  }

  // SIGTERM the group, wait up to the grace, SIGKILL, wait up to the reap limit.
  // Only a group this tool started is ever signalled: the id comes from the job.
  private async terminateGroup(
    pgid: number,
  ): Promise<{ escalated: boolean; cleanup: CleanupState }> {
    const first = probeGroup(pgid);
    if (first === "unknown") return { escalated: false, cleanup: "verify_unavailable" };
    if (first === "empty") return { escalated: false, cleanup: "group_empty" };
    if (first === "unsignallable") return { escalated: false, cleanup: "escaped_or_unverified" };
    this.groupOps.signal(pgid, "SIGTERM");
    if (await this.waitGroupEmpty(pgid, this.killGraceMs)) {
      return { escalated: false, cleanup: "group_killed" };
    }
    this.groupOps.signal(pgid, "SIGKILL");
    if (await this.waitGroupEmpty(pgid, this.reapLimitMs)) {
      return { escalated: true, cleanup: "group_killed" };
    }
    const last = probeGroup(pgid);
    return {
      escalated: true,
      cleanup:
        last === "empty"
          ? "group_killed"
          : last === "unknown"
            ? "verify_unavailable"
            : "escaped_or_unverified",
    };
  }

  private async waitGroupEmpty(pgid: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      if (probeGroup(pgid) === "empty") return true;
      if (Date.now() >= until) return false;
      const s = sleep(POLL_MS);
      await s.promise;
    }
  }

  private finalize(job: Job): void {
    job.phase = "finished";
    job.finishedAt = Date.now();
    if (job.captureFd !== null) {
      try {
        closeSync(job.captureFd);
      } catch {
        // already closed
      }
      job.captureFd = null;
    }
    try {
      this.writeEntry(job);
    } catch (err) {
      this.log(
        `work: could not record ${job.runId} (pgid ${job.pgid}) as finished: ${(err as Error).message}`,
      );
    }
    job.resolveDone();
  }

  private outputComplete(job: Job): boolean {
    return (
      job.phase === "finished" &&
      job.stdoutEnded &&
      job.stderrEnded &&
      !job.drainCut &&
      !job.captureFailed &&
      job.droppedBytes === 0
    );
  }

  private writeEntry(job: Job): void {
    const entry: RegistryEntry = {
      v: 1,
      run_id: job.runId,
      pgid: job.pgid,
      supervisor_pid: process.pid,
      started_at: new Date(job.startedAt).toISOString(),
      deadline_at: new Date(job.deadlineAt).toISOString(),
      timeout_s: job.timeoutS,
      command_sha256: job.commandSha,
      cwd: job.cwd,
      background: job.background,
      output_ref: job.capturePath,
      leader_start: job.leaderStart,
      state: job.phase === "finished" ? "finished" : "running",
    };
    if (job.phase === "finished") {
      entry.outcome = job.outcome ?? "no_exit_status";
      entry.exit_code = job.exitCode;
      entry.signal = job.exitSignal;
      entry.escalated = job.escalated;
      entry.cleanup_state = job.cleanup ?? "verify_unavailable";
      entry.output_complete = this.outputComplete(job);
      if (job.cancelReason !== null) entry.cancel_reason = job.cancelReason;
      entry.finished_at = new Date(job.finishedAt ?? Date.now()).toISOString();
    }
    writeJsonAtomic(job.entryPath, entry);
  }

  // --- reports ---------------------------------------------------------------

  get(runId: unknown, tool = "run_status"): Job {
    const job = typeof runId === "string" ? this.jobs.get(runId) : undefined;
    if (job) return job;
    const owned = [...this.jobs.keys()];
    throw new RunRefusal(
      `${tool} refused: no job ${JSON.stringify(runId)} in this bob run. ${
        owned.length > 0
          ? `This run owns ${owned.join(", ")}; call run_status with no run_id to list them.`
          : "This run has started no jobs."
      } A run_id from an earlier bob run cannot be queried or cancelled.`,
    );
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  report(job: Job, withExcerpt = true): JobReport {
    const finished = job.phase === "finished";
    const excerpt = withExcerpt
      ? readExcerpt(job.capturePath)
      : { text: "", truncated: false, redactions: 0, bytes: job.captureBytes };
    const cleanup = finished ? (job.cleanup ?? "verify_unavailable") : null;
    const outcome = finished ? (job.outcome ?? "no_exit_status") : null;
    const success =
      finished &&
      outcome === "exited" &&
      job.exitCode === 0 &&
      (cleanup === "group_empty" || cleanup === "group_killed");
    const end = job.finishedAt ?? Date.now();
    return {
      run_id: job.runId,
      state: finished ? "finished" : "running",
      outcome,
      exit_code: job.exitCode,
      signal: job.exitSignal,
      escalated: job.escalated,
      cleanup_state: cleanup,
      success,
      effective_timeout_s: job.timeoutS,
      timeout_source: job.timeoutSource,
      background: job.background,
      pgid: job.pgid,
      elapsed_s: Math.round((end - job.startedAt) / 100) / 10,
      output_ref: job.capturePath,
      output_complete: this.outputComplete(job),
      output_bytes: job.captureBytes,
      output_dropped_bytes: job.droppedBytes,
      output_excerpt: excerpt.text,
      output_excerpt_truncated: excerpt.truncated,
      redactions: excerpt.redactions,
      cancel_reason: job.cancelReason,
    };
  }

  // --- run end ---------------------------------------------------------------

  // The run is ending (pi's session_shutdown): cancel every job it still owns,
  // log each one's cleanup, delete the output captures.
  async endRun(): Promise<JobReport[]> {
    if (this.ended) return [];
    this.ended = true;
    liveManagers().delete(this);
    const live = [...this.jobs.values()].filter((j) => j.phase !== "finished");
    await Promise.all(live.map((job) => this.cancelJob(job, "run_end")));
    const reports = live.map((job) => this.report(job, false));
    for (const r of reports) {
      this.log(
        `work: run end: ${r.run_id} (process group ${r.pgid}) outcome=${r.outcome} cleanup_state=${r.cleanup_state}`,
      );
    }
    this.closeRunDir();
    return reports;
  }

  // The process is exiting (no event loop left): SIGKILL every group this run
  // still owns, check briefly, record and log. Synchronous by necessity.
  endRunSync(): void {
    if (this.ended) return;
    this.ended = true;
    liveManagers().delete(this);
    for (const job of this.jobs.values()) {
      if (job.phase === "finished") continue;
      if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
      if (job.phase === "running") {
        job.outcome = "cancelled";
        job.cancelReason = "run_end";
      }
      const first = probeGroup(job.pgid);
      let cleanup: CleanupState;
      if (first === "members") {
        this.groupOps.signal(job.pgid, "SIGKILL");
        job.escalated = true;
        let empty = false;
        for (let i = 0; i < 10 && !empty; i++) {
          sleepSync(20);
          empty = probeGroup(job.pgid) === "empty";
        }
        // The leader is this process's child, and with no event loop left nobody
        // reaps it: it stays a ZOMBIE member of the group until this process
        // exits. So a non-empty probe is checked against `ps`: a group whose
        // only members are zombies is dead. Anything else — or no answer — is
        // not verified clean.
        if (!empty && liveGroupMembers(job.pgid) === 0) empty = true;
        cleanup = empty ? "group_killed" : "escaped_or_unverified";
      } else {
        cleanup =
          first === "empty"
            ? "group_empty"
            : first === "unknown"
              ? "verify_unavailable"
              : "escaped_or_unverified";
      }
      job.cleanup = cleanup;
      job.drainCut = true;
      job.phase = "finished";
      job.finishedAt = Date.now();
      if (job.captureFd !== null) {
        try {
          closeSync(job.captureFd);
        } catch {
          // already closed
        }
        job.captureFd = null;
      }
      try {
        this.writeEntry(job);
      } catch {
        // best effort at exit
      }
      this.log(
        `work: run end (process exit): ${job.runId} (process group ${job.pgid}) outcome=${job.outcome} cleanup_state=${cleanup}`,
      );
      job.resolveDone();
    }
    this.closeRunDir();
  }

  private closeRunDir(): void {
    const dirs = this.dirs;
    if (dirs === null) return;
    try {
      rmSync(dirs.out, { recursive: true, force: true });
      writeJsonAtomic(join(dirs.run, "ended.json"), {
        v: 1,
        ended_at: new Date().toISOString(),
        supervisor_pid: process.pid,
      });
    } catch (err) {
      this.log(`work: could not close the run directory ${dirs.run}: ${(err as Error).message}`);
    }
  }

  // --- boot sweep ------------------------------------------------------------

  // Jobs left by a bob run whose supervisor died (its run-end sweep never ran):
  // find them in the registry, cancel each by its recorded process group when
  // the group's leader still matches the record, report every one, delete the
  // dead run's output captures, and delete run records past the retention bound.
  async bootSweep(now = Date.now()): Promise<BootReap[]> {
    const reaped: BootReap[] = [];
    try {
      lstatSync(this.stateRoot);
    } catch {
      return reaped; // nothing was ever recorded here
    }
    try {
      ensurePrivateDir(this.stateRoot, false);
    } catch (err) {
      this.log(`work: boot sweep skipped: ${(err as Error).message}`);
      return reaped;
    }
    let names: string[] = [];
    try {
      names = readdirSync(this.stateRoot);
    } catch {
      return reaped;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    for (const name of names) {
      if (!/^run-[A-Za-z0-9-]+$/.test(name)) continue;
      const dir = join(this.stateRoot, name);
      if (dir === this.dirs?.run) continue;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) {
        continue;
      }
      const meta = readJson(join(dir, "run.json"));
      const sup = meta?.supervisor_pid;
      if (typeof sup !== "number" || !Number.isSafeInteger(sup) || sup <= 0) continue;
      if (isPidAlive(sup)) continue;

      const jobsDir = join(dir, "jobs");
      let files: string[] = [];
      try {
        files = readdirSync(jobsDir).filter((f) => /^pg-\d+\.run-\d+\.json$/.test(f));
      } catch {
        files = [];
      }
      const pending = files
        .map((f) => ({ path: join(jobsDir, f), entry: readJson(join(jobsDir, f)) }))
        .filter((e) => e.entry !== null && e.entry.state === "running");
      const results = await Promise.all(
        pending.map((e) => this.reapEntry(e.path, e.entry as unknown as RegistryEntry, sup)),
      );
      reaped.push(...results);

      rmSync(join(dir, "out"), { recursive: true, force: true });
      const endedPath = join(dir, "ended.json");
      const ended = readJson(endedPath);
      let endedAt = typeof ended?.ended_at === "string" ? Date.parse(ended.ended_at) : Number.NaN;
      if (Number.isNaN(endedAt)) {
        endedAt = now;
        try {
          writeJsonAtomic(endedPath, {
            v: 1,
            ended_at: new Date(now).toISOString(),
            reaped_by: process.pid,
          });
        } catch {
          // best effort
        }
      }
      if (now - endedAt > REGISTRY_RETENTION_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return reaped;
  }

  private async reapEntry(
    path: string,
    entry: RegistryEntry,
    supervisor: number,
  ): Promise<BootReap> {
    const pgid = entry.pgid;
    let cleanup: CleanupState;
    let outcome: Outcome = "no_exit_status";
    let signalled = false;
    let escalated = false;
    let note: string;
    if (!isOwnedGroupId(pgid)) {
      cleanup = "verify_unavailable";
      note = "the record names no usable process group id; nothing was signalled";
    } else {
      const probe = probeGroup(pgid);
      if (probe === "empty") {
        cleanup = "group_empty";
        note = "its process group was already empty";
      } else if (probe === "unknown") {
        cleanup = "verify_unavailable";
        note = "its process group could not be probed; nothing was signalled";
      } else if (probe === "unsignallable") {
        cleanup = "escaped_or_unverified";
        note = "its process group has a member this user may not signal";
      } else {
        const leader = await readLeaderStart(pgid);
        if (entry.leader_start && leader !== null && leader === entry.leader_start) {
          const t = await this.terminateGroup(pgid);
          cleanup = t.cleanup;
          escalated = t.escalated;
          signalled = true;
          outcome = "cancelled";
          note = "cancelled by its recorded process group";
        } else {
          cleanup = "escaped_or_unverified";
          note =
            "its process group exists but its leader does not match the record (gone, or started at another time), so it was NOT signalled";
        }
      }
    }
    const at = new Date().toISOString();
    const updated: RegistryEntry = {
      ...entry,
      state: "finished",
      outcome,
      exit_code: null,
      signal: null,
      escalated,
      cleanup_state: cleanup,
      output_complete: false,
      finished_at: at,
      reaped_by: { pid: process.pid, at, signalled, note },
    };
    if (signalled) updated.cancel_reason = "boot_reap";
    try {
      writeJsonAtomic(path, updated);
    } catch {
      // the log line below still reports it
    }
    this.log(
      `work: boot sweep: ${entry.run_id} (process group ${pgid}) left by bob pid ${supervisor}, which is gone: outcome=${outcome} cleanup_state=${cleanup} — ${note}`,
    );
    return {
      run_id: entry.run_id,
      pgid,
      supervisor_pid: supervisor,
      outcome,
      cleanup_state: cleanup,
      signalled,
      note,
    };
  }
}

export interface BootReap {
  run_id: string;
  pgid: number;
  supervisor_pid: number;
  outcome: Outcome;
  cleanup_state: CleanupState;
  signalled: boolean;
  note: string;
}

// --- process exit ----------------------------------------------------------------

// Every manager still live in this process. pi loads an extension with a fresh
// module instance per session, so the set (and the one exit hook) live on
// globalThis rather than in module scope.
const LIVE_KEY = Symbol.for("@tpsdev-ai/bob/work/live-managers");

interface LiveRegistry {
  managers: Set<JobManager>;
}

function liveManagers(): Set<JobManager> {
  const g = globalThis as unknown as Record<symbol, LiveRegistry | undefined>;
  let reg = g[LIVE_KEY];
  if (!reg) {
    const created: LiveRegistry = { managers: new Set() };
    reg = created;
    g[LIVE_KEY] = created;
    process.once("exit", () => {
      for (const m of [...created.managers]) {
        try {
          m.endRunSync();
        } catch {
          // best effort at exit
        }
      }
    });
  }
  return reg.managers;
}
