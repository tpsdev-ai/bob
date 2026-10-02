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

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
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
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
// A live run refreshes its run record this often. Where no sub-second process
// identity exists (see readProcIdentity), a live pid counts as the run's
// supervisor only while that record is fresher than HEARTBEAT_STALE_MS, so a
// reused pid cannot hold a dead run's directory forever.
export const HEARTBEAT_MS = 60 * 1000;
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
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
export type CancelReason = "run_cancel" | "run_end" | "abort" | "boot_reap" | "record_failed";
export type TimeoutSource = "default" | "requested" | "clamped";

type Phase = "running" | "exited" | "timing_out" | "cancelling" | "finished";

// A refusal the model gets as a tool error: actor + state + remedy.
export class RunRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRefusal";
  }
}

// --- process identity ---------------------------------------------------------

// A process pinned finer than its pid: the kernel boot, the start time in clock
// ticks since boot, and the process group and session from the SAME /proc
// record (Linux). A pid can be reused, even within one second; a pid AND its
// start tick cannot in practice — the pid space would have to wrap within one
// clock tick.
export interface ProcIdentity {
  boot: string;
  start: string;
  pgid: number;
  sid: number;
}

// What a read of a process's identity can say:
//   a ProcIdentity  — the process, pinned;
//   null            — the process is GONE: /proc has no such pid (ENOENT/ESRCH),
//                     or only a zombie is left;
//   "unreadable"    — the process may exist but its record could not be read or
//                     parsed (EACCES, EPERM, an unexpected format …): the tool
//                     CANNOT TELL, which is never the same as "gone" or
//                     "replaced";
//   "unsupported"   — this platform gives no sub-second start time, so no
//                     identity can be pinned — and the boot sweep then signals
//                     nothing.
export type IdentityRead = ProcIdentity | null | "unreadable" | "unsupported";
export type IdentityReader = (pid: number) => IdentityRead;

let linuxBootId: string | null | undefined;

export function readProcIdentity(pid: number): IdentityRead {
  if (process.platform !== "linux") return "unsupported";
  if (linuxBootId === undefined) {
    try {
      linuxBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      linuxBootId = null;
    }
  }
  if (linuxBootId === null) return "unsupported";
  return identityFromProc(pid, linuxBootId, (path) => readFileSync(path, "utf8"));
}

// The /proc/<pid>/stat half of readProcIdentity, with the read injectable so the
// error classification is testable on any platform.
export function identityFromProc(
  pid: number,
  boot: string,
  readStat: (path: string) => string,
): ProcIdentity | null | "unreadable" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let stat: string;
  try {
    stat = readStat(`/proc/${pid}/stat`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? null : "unreadable";
  }
  // "pid (comm) state ppid pgrp session ..." — comm may hold spaces or parens,
  // so the fields are counted from the LAST ")".
  const close = stat.lastIndexOf(")");
  if (close < 0) return "unreadable";
  const f = stat.slice(close + 2).split(" ");
  const state = f[0];
  if (state === "Z" || state === "X" || state === "x") return null;
  const pgid = Number(f[2]);
  const sid = Number(f[3]);
  const start = f[19];
  if (!Number.isSafeInteger(pgid) || !Number.isSafeInteger(sid) || !/^\d+$/.test(start ?? "")) {
    return "unreadable";
  }
  return { boot, start, pgid, sid };
}

export function sameIdentity(a: ProcIdentity, b: ProcIdentity): boolean {
  return a.boot === b.boot && a.start === b.start && a.pgid === b.pgid && a.sid === b.sid;
}

function isIdentity(v: unknown): v is ProcIdentity {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.boot === "string" &&
    typeof o.start === "string" &&
    typeof o.pgid === "number" &&
    typeof o.sid === "number"
  );
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
  // The group leader's pinned identity (readProcIdentity), taken right after
  // spawn and before this record is first written. Null where the platform
  // gives none: the boot sweep never signals a group it cannot pin.
  leader_identity: ProcIdentity | null;
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
  // Bytes of an unterminated final line held back because the capture is not
  // complete (it may be a fragment of a secret the redactor cannot recognize).
  output_tail_withheld_bytes: number;
  // The capture file is gone (removed by something outside the tool).
  output_missing: boolean;
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
  leaderIdentity: ProcIdentity | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  eof: Promise<void>;
  done: Promise<void>;
  resolveDone: () => void;
}

export interface JobManagerOptions {
  stateRoot?: string;
  defaultTimeoutS?: number;
  maxTimeoutS?: number;
  killGraceMs?: number;
  reapLimitMs?: number;
  drainGraceMs?: number;
  maxLiveJobs?: number;
  captureMaxBytes?: number;
  groupOps?: GroupOps;
  // Seam: the process identity reader (default readProcIdentity).
  readIdentity?: IdentityReader;
  // Seam: the durable record writer (default: a 0600 temp file renamed into place).
  writeRecord?: (path: string, value: unknown) => void;
  // Test seam: rewrite the leader's exit report as the OS gave it (code, signal).
  observeExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => { code: number | null; signal: NodeJS.Signals | null };
  // Seam: the file-system calls of the cwd pin (default NODE_DIR_PIN_OPS). A test
  // makes one of them fail to see the refusal.
  dirPinOps?: DirPinOps;
  // Test seams, SYNCHRONOUS on purpose: `start` must not yield between its
  // live-job limit check and the job's registration, so these are called only
  // when set and never awaited. `beforePin` runs after the cwd is resolved and
  // confined, before the pin opens; `beforeSpawn` runs after the pin is verified,
  // before the re-check that precedes the spawn. A test swaps a path component
  // in one of them to prove the checks refuse it. Production passes neither.
  beforePin?: (resolvedCwd: string) => void;
  beforeSpawn?: (resolvedCwd: string) => void;
  log?: (msg: string) => void;
}

export interface StartRequest {
  command?: unknown;
  cwd?: unknown;
  timeout_s?: unknown;
  background?: unknown;
}

// --- helpers -------------------------------------------------------------------

export function defaultStateRoot({
  platform = process.platform,
  env = process.env,
  home = homedir(),
}: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): string {
  if (env.BOB_STATE_DIR !== undefined) {
    if (!isAbsolute(env.BOB_STATE_DIR)) {
      throw new RunRefusal("run refused: BOB_STATE_DIR must be an absolute path.");
    }
    return resolve(env.BOB_STATE_DIR);
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "bob");
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"), "bob");
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

// `child` is `root` or below it, for two paths that are ALREADY canonical (no
// symlink, no "." or ".." segment). A path escapes only through a whole ".."
// segment: a name that merely starts with two dots (`..cache`) is inside.
function isInsideCanonical(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// `child` is `parent` or below it, for paths that may not exist yet (both are
// canonicalised first; see canonicalPath).
function isInside(parent: string, child: string): boolean {
  return isInsideCanonical(canonicalPath(parent), canonicalPath(child));
}

const errCode = (err: unknown): string =>
  (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? "error";

// --- the cwd pin (bob#224) ------------------------------------------------------
//
// A child's working directory is named by a STRING: Node has no fchdir and no way
// to hand a child a directory descriptor as its cwd, and the child's own chdir
// re-resolves that string. So `run` cannot make the directory a command starts in
// BE the one it checked; it narrows the window in which they can differ:
//   1. resolve the cwd and the workspace through symlinks (realpath), record the
//      workspace root's device + inode, and confine the one to the other
//      (resolveCwd);
//   2. open the resolved path (O_DIRECTORY | O_NOFOLLOW) and hold it open:
//      the PIN. While it is held the inode stays allocated (on a local POSIX file
//      system), so no other directory can take its device + inode;
//   3. immediately after pinning, and again immediately before the spawn,
//      re-resolve the cwd (realpath): it must still be the same canonical path,
//      inside the originally checked canonical workspace, a no-follow stat of
//      it must still be a directory with the pin's device + inode, and the
//      workspace root must still match the device + inode recorded in step 1;
//   4. release the pin, then spawn: no pin step runs after the spawn.
// Any step that cannot establish its fact (a failed realpath, stat, open, fstat
// or close) refuses: unknown is never taken as inside.
//
// Inside one re-check the realpath and no-follow stat are separate calls. If a
// component is replaced between them so that the no-follow stat no longer finds
// a directory with the pin's device + inode (or the workspace root no longer
// matches its recorded device + inode), the comparison refuses it (run.test.ts
// drives that interval with a different directory at the final component). A
// swap that still leads the path to the pinned directory, for example a symlink
// back to it or the pinned directory moved under the replacement, is not
// detected there; the OS-specific directory-descriptor boundary described in the
// capability README would cover it. After the last re-check and before the
// child's own chdir, a component can still be replaced.

// The file-system calls the pin makes, as a seam (like GroupOps) so a test can
// make one of them fail — a realpath or stat that errors, an fstat that throws
// after the open, a close that throws before or after it closes — and see the
// refusal, what it says about the descriptor, and that nothing starts.
// Production uses NODE_DIR_PIN_OPS.
// Device and inode are bigints, compared at full 64-bit precision: not every
// integer above Number.MAX_SAFE_INTEGER is representable as a number, so two
// distinct device or inode values can compare equal as numbers (some network,
// overlay and snapshot file systems report such values).
export interface DirStat {
  dev: bigint;
  ino: bigint;
  isDirectory(): boolean;
}
export interface DirPinOps {
  realpath(path: string): string;
  // A no-follow stat: a symlink reports itself, never its target.
  lstat(path: string): DirStat;
  open(path: string, flags: number): number;
  fstat(fd: number): DirStat;
  close(fd: number): void;
}
export const NODE_DIR_PIN_OPS: DirPinOps = Object.freeze({
  realpath: (p: string) => realpathSync(p),
  lstat: (p: string) => lstatSync(p, { bigint: true }),
  open: (p: string, flags: number) => openSync(p, flags),
  fstat: (fd: number) => fstatSync(fd, { bigint: true }),
  close: (fd: number) => closeSync(fd),
});

interface DirPin {
  fd: number;
  dev: bigint;
  ino: bigint;
}

// resolveCwd records the workspace root's device and inode. Each re-check compares
// them, detecting a replacement while the original inode remains allocated.
interface WorkspacePin {
  dev: bigint;
  ino: bigint;
}

type PinStage = "when it was pinned" | "immediately before the spawn";

// The cwd must still be the checked canonical path and the directory pinned at
// open: the same canonical path, inside the checked canonical workspace, and
// (no-follow) the pinned device + inode; and the workspace root must still match
// the device + inode recorded when the cwd was resolved. Throws a RunRefusal naming
// the failed check or mismatch.
function assertStillPinned(
  ops: DirPinOps,
  dir: string,
  workspace: string,
  workspacePin: WorkspacePin,
  pin: DirPin,
  stage: PinStage,
): void {
  let real: string;
  try {
    real = ops.realpath(dir);
  } catch (err) {
    throw new RunRefusal(
      `run refused: the working directory ${dir} could not be re-resolved ${stage} (${errCode(err)}): resolving it failed, so whether it is still the checked canonical path and the directory pinned at open is unknown. Nothing was started.`,
    );
  }
  if (!isInsideCanonical(workspace, real)) {
    throw new RunRefusal(
      `run refused: the working directory ${dir} now resolves outside the workspace ${workspace} (to ${real}), ${stage}; it resolved inside that workspace when it was checked. Nothing was started.`,
    );
  }
  if (real !== dir) {
    throw new RunRefusal(
      `run refused: the working directory ${dir} now resolves to ${real}, ${stage}, not to the canonical path that was checked. Nothing was started; retry once the directory is stable.`,
    );
  }
  let st: DirStat;
  try {
    st = ops.lstat(real);
  } catch (err) {
    throw new RunRefusal(
      `run refused: the working directory ${dir} could not be re-checked ${stage} (${errCode(err)}). Nothing was started.`,
    );
  }
  if (!st.isDirectory() || st.dev !== pin.dev || st.ino !== pin.ino) {
    throw new RunRefusal(
      `run refused: the working directory ${dir} does not match its pin ${stage}: a no-follow stat of it is not a directory with the pinned device and inode. Nothing was started; retry once the directory is stable.`,
    );
  }
  let wst: DirStat;
  try {
    wst = ops.lstat(workspace);
  } catch (err) {
    throw new RunRefusal(
      `run refused: the workspace ${workspace} could not be re-checked ${stage} (${errCode(err)}). Nothing was started.`,
    );
  }
  if (!wst.isDirectory() || wst.dev !== workspacePin.dev || wst.ino !== workspacePin.ino) {
    throw new RunRefusal(
      `run refused: the workspace ${workspace} no longer has the device and inode it had when the cwd was checked ${stage}, so the workspace root was replaced. Nothing was started; retry once the directory is stable.`,
    );
  }
}

// Open and verify the pin. On a failure after the open, closing the descriptor is
// ATTEMPTED before the refusal is thrown, and the refusal says how that close
// went: "closed" only when the close returned, "unknown" when it failed (a failed
// close may or may not have released the descriptor; this code cannot tell).
function pinDirectory(
  ops: DirPinOps,
  dir: string,
  workspace: string,
  workspacePin: WorkspacePin,
): DirPin {
  let fd: number;
  try {
    // O_NOFOLLOW: the final component must be the real directory, not a symlink
    // swapped in after resolveCwd canonicalised it. O_RDONLY: Node offers no
    // search-only open, so a directory without read permission is refused even
    // though a command could start in it (the safe direction; see the README).
    fd = ops.open(dir, fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW);
  } catch (err) {
    const code = errCode(err);
    const remedy =
      code === "EACCES"
        ? "run opens the directory for reading to pin it, so a directory without read permission is refused even though a command could start in it; if this one lacks read permission, make it readable (chmod u+r) or pass another directory"
        : "check that it exists and is a real directory, not a symlink";
    throw new RunRefusal(
      `run refused: the working directory ${dir} could not be opened to pin its identity (${code}). Nothing was started; ${remedy}.`,
    );
  }
  let failure: RunRefusal;
  try {
    let st: DirStat;
    try {
      st = ops.fstat(fd);
    } catch (err) {
      throw new RunRefusal(
        `run refused: the working directory ${dir} was opened to pin its identity, but its identity could not be read (${errCode(err)}). Nothing was started; retry.`,
      );
    }
    const pin: DirPin = { fd, dev: st.dev, ino: st.ino };
    // The pin must be the checked canonical path and the directory pinned at open: re-resolve now it is open.
    assertStillPinned(ops, dir, workspace, workspacePin, pin, "when it was pinned");
    return pin;
  } catch (err) {
    failure =
      err instanceof RunRefusal
        ? err
        : new RunRefusal(
            `run refused: pinning the working directory ${dir} failed (${errCode(err)}). Nothing was started.`,
          );
  }
  // Still refusing, whatever the close does: nothing is started either way. A
  // failed close is REPORTED, never suppressed, so the refusal never claims a
  // closure that did not happen.
  const closeFailed = closePin(ops, fd);
  throw new RunRefusal(
    `${failure.message} ${closeFailed ?? "The descriptor that pinned it was closed."}`,
  );
}

// Close a pin's descriptor. Null when the close returned; otherwise the sentence a
// refusal carries: the close failed, so whether the descriptor is still open is
// unknown (a failed close may or may not have released it).
function closePin(ops: DirPinOps, fd: number): string | null {
  try {
    ops.close(fd);
    return null;
  } catch (err) {
    return `Closing the descriptor that pinned it then failed (${errCode(err)}), so whether that descriptor is still open is unknown.`;
  }
}

// Release the pin, BEFORE the spawn, after the final re-check. `recheck` holds
// that re-check's failure, if it failed. Throws when either failed, and reports
// BOTH: a failed close is never dropped because the re-check already refused,
// and a release that fails leaves the descriptor's state unknown, which the
// refusal says. Nothing is started in any of these cases.
function releasePin(
  ops: DirPinOps,
  dir: string,
  pin: DirPin,
  recheck: { err: unknown } | null,
): void {
  const closeFailed = closePin(ops, pin.fd);
  if (recheck === null) {
    if (closeFailed === null) return;
    throw new RunRefusal(
      `run refused: the working directory ${dir} passed its final re-check. ${closeFailed} Nothing was started: a release that fails refuses before the spawn; retry.`,
    );
  }
  if (closeFailed === null) throw recheck.err;
  const first =
    recheck.err instanceof Error ? recheck.err.message : `run refused: ${String(recheck.err)}.`;
  throw new RunRefusal(`${first} ${closeFailed}`);
}

// An owner-only directory: a real directory (not a symlink), owned by this user,
// with no group or world bits. Created when `create` is set and it is missing.
function ensurePrivateDir(path: string, create: boolean): void {
  if (create) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      mkdirSync(path, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new RunRefusal(
          `run refused: the job state directory ${path} could not be created (${(err as NodeJS.ErrnoException).code ?? "error"}). Check that the parent directory is writable.`,
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
      `run refused: the job state directory ${path} has mode ${(st.mode & 0o777).toString(8)}, with group or world permissions. Run chmod 700 on it.`,
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
  // Bytes of an unterminated final line withheld (only when `complete` is false).
  withheld: number;
  // The capture could not be read as a regular file: the no-follow open failed,
  // or what it opened is not a regular file.
  missing: boolean;
}

const NO_EXCERPT = { text: "", truncated: false, redactions: 0, bytes: 0, withheld: 0 };

// The tail of a capture file, redacted BEFORE it is cut. The window read is the
// excerpt size plus a margin; when it does not start at the top of the file, the
// partial first line is dropped, so a secret straddling the window start is not
// half-shown. The redactor runs over the whole window, then pi's truncateTail
// makes the cut — so a secret straddling the excerpt cut is already replaced.
//
// `complete: false` (a running job, a capture that hit its cap, a drain that was
// cut): the capture may end in the MIDDLE of a line — a token cut there is a
// fragment no redaction rule recognizes — so the unterminated final line is
// withheld before redaction. Only a complete capture shows it.
export function readExcerpt(
  path: string,
  opts: { maxBytes?: number; maxLines?: number; marginBytes?: number; complete?: boolean } = {},
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
    return { ...NO_EXCERPT, missing: true };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ...NO_EXCERPT, missing: true };
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
    let withheld = 0;
    if (opts.complete === false) {
      const last = text.lastIndexOf("\n");
      const kept = last >= 0 ? text.slice(0, last + 1) : "";
      withheld = Buffer.byteLength(text.slice(kept.length), "utf8");
      text = kept;
    }
    const red = redactSecrets(plainText(text));
    const tail = truncateTail(red.text, { maxBytes, maxLines });
    return {
      text: tail.content,
      truncated: headCut || tail.truncated,
      redactions: red.redactions,
      bytes: size,
      withheld,
      missing: false,
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
  private readonly dirPinOps: DirPinOps;
  private readonly beforePin: JobManagerOptions["beforePin"];
  private readonly beforeSpawn: JobManagerOptions["beforeSpawn"];
  private readonly readIdentity: IdentityReader;
  private readonly writeRecord: (path: string, value: unknown) => void;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
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
    this.dirPinOps = opts.dirPinOps ?? NODE_DIR_PIN_OPS;
    this.beforePin = opts.beforePin;
    this.beforeSpawn = opts.beforeSpawn;
    this.readIdentity = opts.readIdentity ?? readProcIdentity;
    this.writeRecord = opts.writeRecord ?? writeJsonAtomic;
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

  // The cwd, resolved through symlinks, and the canonical workspace it was
  // confined to (kept: the pin re-checks against THIS root, not a re-resolved one).
  private resolveCwd(
    ctxCwd: string | undefined,
    raw: unknown,
  ): { dir: string; workspace: string; workspacePin: WorkspacePin } {
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
    // The existence check reports the FAILED CHECK, never a cause it did not
    // observe: a stat that cannot run is "could not be checked" with its errno,
    // and only a stat that returns a non-directory says "is not a directory".
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch (err) {
      throw new RunRefusal(
        `run refused: cwd ${JSON.stringify(raw ?? ctxCwd)} (resolved to ${dir}) could not be checked (${errCode(err)}). Pass an existing directory, relative to the workspace, or omit cwd.`,
      );
    }
    if (!st.isDirectory()) {
      throw new RunRefusal(
        `run refused: cwd ${JSON.stringify(raw ?? ctxCwd)} (resolved to ${dir}) is not a directory. Pass a directory, relative to the workspace, or omit cwd.`,
      );
    }
    // Containment: the directory must stay inside the workspace. Both paths are
    // resolved through symlinks (realpath) first, so a symlink inside the
    // workspace that points outside it is refused. A path that cannot be
    // resolved is refused: whether it is inside is then unknown.
    let workspace: string;
    try {
      workspace = this.dirPinOps.realpath(ctxCwd);
    } catch (err) {
      throw new RunRefusal(
        `run refused: the workspace ${ctxCwd} could not be resolved through its symlinks (${errCode(err)}), so no cwd can be confined to it. Nothing was started.`,
      );
    }
    // Record the workspace root's identity, not just its string. Each re-check
    // compares its device and inode with these values.
    let workspacePin: WorkspacePin;
    try {
      const wst = this.dirPinOps.lstat(workspace);
      if (!wst.isDirectory()) {
        throw new RunRefusal(
          `run refused: the workspace ${ctxCwd} (resolved to ${workspace}) is not a directory, so no cwd can be confined to it. Nothing was started.`,
        );
      }
      workspacePin = { dev: wst.dev, ino: wst.ino };
    } catch (err) {
      if (err instanceof RunRefusal) throw err;
      throw new RunRefusal(
        `run refused: the workspace ${ctxCwd} (resolved to ${workspace}) could not be checked (${errCode(err)}), so no cwd can be confined to it. Nothing was started.`,
      );
    }
    let resolved: string;
    try {
      resolved = this.dirPinOps.realpath(dir);
    } catch (err) {
      throw new RunRefusal(
        `run refused: cwd ${JSON.stringify(raw ?? ctxCwd)} (resolved to ${dir}) could not be resolved through its symlinks (${errCode(err)}), so whether it is inside the workspace is unknown. Nothing was started; pass an existing directory inside the workspace, or omit cwd.`,
      );
    }
    if (!isInsideCanonical(workspace, resolved)) {
      throw new RunRefusal(
        `run refused: cwd resolves outside the workspace ${ctxCwd} (resolved to ${resolved}). Pass a path inside the workspace.`,
      );
    }
    return { dir: resolved, workspace, workspacePin };
  }

  private ensureRunDir(workspaces: string[]): { run: string; jobs: string; out: string } {
    const roots = new Set(workspaces);
    for (const workspace of workspaces) {
      let ancestor = canonicalPath(workspace);
      while (true) {
        if (existsSync(join(ancestor, ".git"))) roots.add(ancestor);
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    for (const root of roots) {
      for (const [name, path] of [
        ["BOB_STATE_DIR", this.stateRoot],
        ["TMPDIR", tmpdir()],
      ]) {
        if (isInside(root, path)) {
          throw new RunRefusal(
            `run refused: ${name} (${path}) is inside the workspace or repository ${root}. Choose a directory outside it.`,
          );
        }
      }
    }
    ensurePrivateDir(this.stateRoot, true);
    if (this.dirs !== null) return this.dirs;
    let run: string | undefined;
    let out: string | undefined;
    try {
      run = mkdtempSync(join(this.stateRoot, "run-"));
      ensurePrivateDir(run, false);
      out = mkdtempSync(join(tmpdir(), "bob-run-"));
      ensurePrivateDir(out, false);
      mkdirSync(join(run, "jobs"), { mode: 0o700 });
      const scratch = lstatSync(out, { bigint: true });
      const identity = this.readIdentity(process.pid);
      this.writeRecord(join(run, "run.json"), {
        v: 1,
        supervisor_pid: process.pid,
        supervisor_instance: processInstanceId(),
        supervisor_identity: typeof identity === "object" ? identity : null,
        started_at: new Date().toISOString(),
        scratch_dir: out,
        scratch_dev: String(scratch.dev),
        scratch_ino: String(scratch.ino),
      });
    } catch (err) {
      if (out) rmSync(out, { recursive: true, force: true });
      if (run) rmSync(run, { recursive: true, force: true });
      throw new RunRefusal(
        `run refused: private run storage could not be created (${errCode(err)}).`,
      );
    }
    const dirs = { run, jobs: join(run, "jobs"), out };
    // The heartbeat: the run record's mtime, refreshed while this run lives.
    const record = join(run, "run.json");
    this.heartbeat = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(record, now, now);
      } catch {
        // the next sweep sees a stale heartbeat; nothing else depends on it
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
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
    const { dir: cwd, workspace, workspacePin } = this.resolveCwd(ctxCwd, req.cwd);
    // From this live-job limit check to the job's registration (`this.jobs.set`
    // below) NOTHING may await: a yield in between would let a concurrent start
    // pass the same check, and the limit would not hold. The one await on the way
    // is on the no-pid branch, which throws without registering anything.
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

    // The command should start at the checked canonical path, in the directory pinned at open.
    // Node names a child's cwd by string, so this NARROWS the window in which they
    // can differ rather than closing it (see "the cwd pin" above, and the README):
    // open the resolved path as the pin and verify it, re-check it, release the pin, and
    // only then spawn. A failure in any pin step refuses with nothing started, and
    // no pin step runs after the spawn. The test seams are synchronous and called
    // only when set.
    let child: ChildProcess;
    try {
      this.beforePin?.(cwd);
      const pin = pinDirectory(this.dirPinOps, cwd, workspace, workspacePin);
      let recheck: { err: unknown } | null = null;
      try {
        this.beforeSpawn?.(cwd);
        assertStillPinned(
          this.dirPinOps,
          cwd,
          workspace,
          workspacePin,
          pin,
          "immediately before the spawn",
        );
      } catch (err) {
        recheck = { err };
      }
      releasePin(this.dirPinOps, cwd, pin, recheck);
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
      // A refusal from the pin (nothing started) is reported as-is.
      if (err instanceof RunRefusal) throw err;
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
      // Pinned now, before the first durable record: the boot sweep of a later
      // bob signals this group only if its leader still has this identity.
      leaderIdentity: ((): ProcIdentity | null => {
        const id = this.readIdentity(child.pid);
        return typeof id === "object" && id !== null && id.pgid === child.pid ? id : null;
      })(),
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

    // The first durable record, written right after spawn and before the
    // deadline is armed. The command is already running by now: the shell
    // starts at spawn. A job the registry does not know about could outlive a
    // crashed supervisor with nothing left to find it, so if this write fails
    // termination is attempted (the deadline's escalation) and the refusal says
    // whether its group was verified empty.
    try {
      this.writeEntry(job);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      job.phase = "cancelling";
      job.outcome = "cancelled";
      job.cancelReason = "record_failed";
      await this.complete(job);
      this.jobs.delete(runId);
      const clean = job.cleanup === "group_empty" || job.cleanup === "group_killed";
      throw new RunRefusal(
        `run refused: the job record for ${runId} could not be written (${code}) right after the job started, so termination was attempted (SIGTERM to its process group only if a first membership probe found members it may signal, then SIGKILL attempted if no probe reported the group empty during a grace). Its process group ${job.pgid} ${
          clean
            ? `was verified empty (cleanup_state ${job.cleanup}): nothing from it is left running`
            : `could NOT be verified empty (cleanup_state ${job.cleanup}): something from it may survive`
        }. Check that the job state directory ${dirs.run} is writable (a full disk?), then retry.`,
      );
    }

    // The deadline: a timer of the tool's own, independent of the child's I/O.
    job.deadlineTimer = setTimeout(
      () => void this.onDeadline(job),
      Math.max(0, job.deadlineAt - Date.now()),
    );
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

  // The boot sweep's escalation for a group whose supervisor died: the same
  // SIGTERM → grace → SIGKILL as the deadline, but each signal only while the
  // leader still has its pinned identity. Identity lost before SIGTERM: nothing
  // is signalled. Lost before escalation: SIGKILL is NOT sent. Either way the
  // result is escaped_or_unverified, never a clean state.
  private async terminatePinnedGroup(
    pgid: number,
    pinned: () => boolean,
  ): Promise<{ signalled: boolean; escalated: boolean; cleanup: CleanupState; note: string }> {
    if (!pinned()) {
      return {
        signalled: false,
        escalated: false,
        cleanup: "escaped_or_unverified",
        note: "its leader's identity was lost before SIGTERM, so it was NOT signalled",
      };
    }
    this.groupOps.signal(pgid, "SIGTERM");
    if (await this.waitGroupEmpty(pgid, this.killGraceMs)) {
      return {
        signalled: true,
        escalated: false,
        cleanup: "group_killed",
        note: "cancelled by its pinned process group (SIGTERM)",
      };
    }
    if (!pinned()) {
      return {
        signalled: true,
        escalated: false,
        cleanup: "escaped_or_unverified",
        note: "SIGTERM was sent, but its leader's identity was lost before escalation, so SIGKILL was NOT sent; members may survive",
      };
    }
    this.groupOps.signal(pgid, "SIGKILL");
    const empty = await this.waitGroupEmpty(pgid, this.reapLimitMs);
    return {
      signalled: true,
      escalated: true,
      cleanup: empty ? "group_killed" : "escaped_or_unverified",
      note: empty
        ? "cancelled by its pinned process group (escalated to SIGKILL)"
        : "SIGKILL was sent to its pinned process group, but members remain",
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
      leader_identity: job.leaderIdentity,
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
    this.writeRecord(job.entryPath, entry);
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
    const captureComplete = this.outputComplete(job);
    const excerpt: Excerpt = withExcerpt
      ? readExcerpt(job.capturePath, { complete: captureComplete })
      : { ...NO_EXCERPT, bytes: job.captureBytes, missing: false };
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
      // A capture that vanished after it was written is not complete either.
      output_complete: captureComplete && !excerpt.missing,
      output_bytes: job.captureBytes,
      output_dropped_bytes: job.droppedBytes,
      output_excerpt: excerpt.text,
      output_excerpt_truncated: excerpt.truncated,
      output_tail_withheld_bytes: excerpt.withheld,
      output_missing: excerpt.missing,
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
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const dirs = this.dirs;
    if (dirs === null) return;
    try {
      rmSync(dirs.out, { recursive: true, force: true });
      this.writeRecord(join(dirs.run, "ended.json"), {
        v: 1,
        ended_at: new Date().toISOString(),
        supervisor_pid: process.pid,
      });
    } catch (err) {
      this.log(`work: could not close the run directory ${dirs.run}: ${(err as Error).message}`);
    }
  }

  // --- boot sweep ------------------------------------------------------------

  // Jobs left by a bob run whose supervisor is gone (its run-end sweep never
  // ran): find them in the registry and report every one, signalling a job's
  // group only while its leader still has the identity pinned at spawn
  // (re-checked before each signal); delete the dead run's output captures; and
  // sweep ENDED runs by the retention bound alone.
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
      const runRecord = join(dir, "run.json");
      const meta = readJson(runRecord);
      const sup = meta?.supervisor_pid;
      if (meta === null || typeof sup !== "number" || !Number.isSafeInteger(sup) || sup <= 0) {
        continue;
      }
      const endedPath = join(dir, "ended.json");
      const ended = readJson(endedPath);
      const endedAt = typeof ended?.ended_at === "string" ? Date.parse(ended.ended_at) : Number.NaN;
      if (!Number.isNaN(endedAt)) {
        // An ENDED run is swept by the retention bound alone, whoever holds its
        // supervisor's pid now: captures go at once, records after the bound.
        this.removeStaleScratch(meta);
        if (now - endedAt > REGISTRY_RETENTION_MS) rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (this.supervisorAlive(meta, runRecord, now)) continue;

      // The supervisor is gone (or its pid now belongs to another process).
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

      this.removeStaleScratch(meta);
      try {
        this.writeRecord(endedPath, {
          v: 1,
          ended_at: new Date(now).toISOString(),
          reaped_by: process.pid,
        });
      } catch {
        // best effort: the next sweep finds the run again and retries
      }
    }
    return reaped;
  }

  private removeStaleScratch(meta: Record<string, unknown>): void {
    const path = meta.scratch_dir;
    if (typeof path !== "string" || !isAbsolute(path)) return;
    if (canonicalPath(dirname(path)) !== canonicalPath(tmpdir())) return;
    if (!/^bob-run-[A-Za-z0-9]{6}$/.test(basename(path))) return;
    try {
      ensurePrivateDir(path, false);
      const st = lstatSync(path, { bigint: true });
      if (String(st.dev) !== meta.scratch_dev || String(st.ino) !== meta.scratch_ino) return;
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      if (errCode(err) !== "ENOENT") this.log(`work: scratch cleanup skipped: ${String(err)}`);
    }
  }

  // Is the recorded supervisor of a run still that process? A pid alone is not
  // enough — pids are reused — so:
  //   * this process's own pid counts only with this process's instance id;
  //   * a gone pid is a dead supervisor;
  //   * a live pid with a pinned identity on record counts only if it still
  //     has that identity — a read that finds the pid gone is a mismatch;
  //   * a live pid whose identity cannot be compared — none on record (a
  //     platform without one), or a read that could not tell ("unreadable") —
  //     counts only while the run's heartbeat (its record's mtime) is fresh.
  //     "Cannot tell" never classifies a live supervisor as replaced.
  private supervisorAlive(meta: Record<string, unknown>, record: string, now: number): boolean {
    const pid = meta.supervisor_pid as number;
    if (pid === process.pid) return meta.supervisor_instance === processInstanceId();
    if (!isPidAlive(pid)) return false;
    const recorded = meta.supervisor_identity;
    const current = this.readIdentity(pid);
    if (isIdentity(recorded) && current !== "unsupported" && current !== "unreadable") {
      return current !== null && sameIdentity(recorded, current);
    }
    let mtime: number;
    try {
      mtime = statSync(record).mtimeMs;
    } catch {
      return false;
    }
    return now - mtime <= HEARTBEAT_STALE_MS;
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
        const recorded = isIdentity(entry.leader_identity) ? entry.leader_identity : null;
        // The group is this job's only while its leader (pid == pgid) still has
        // the identity pinned at spawn: a group id stays in use while its leader
        // lives, so a pinned leader pins the group. Checked again immediately
        // before EVERY signal.
        const pinned = (): boolean => {
          if (recorded === null) return false;
          const now = this.readIdentity(pgid);
          return typeof now === "object" && now !== null && sameIdentity(recorded, now);
        };
        if (recorded === null) {
          cleanup = "escaped_or_unverified";
          note =
            "no sub-second identity was recorded for its leader (this platform gives none), so it was NOT signalled";
        } else if (!pinned()) {
          cleanup = "escaped_or_unverified";
          note =
            this.readIdentity(pgid) === "unreadable"
              ? "its leader's identity could not be read, so the tool cannot tell whether the group is still this job's; it was NOT signalled"
              : "its process group exists but its leader no longer has the identity pinned at spawn (gone, or its pid was reused), so it was NOT signalled";
        } else {
          const t = await this.terminatePinnedGroup(pgid, pinned);
          cleanup = t.cleanup;
          escalated = t.escalated;
          signalled = t.signalled;
          if (signalled) outcome = "cancelled";
          note = t.note;
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
      this.writeRecord(path, updated);
    } catch {
      // the log line below still reports it
    }
    this.log(
      `work: boot sweep: ${entry.run_id} (process group ${pgid}) left by bob pid ${supervisor}, which is gone or no longer that bob: outcome=${outcome} cleanup_state=${cleanup} — ${note}`,
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
  // This process's random instance id, written into every run record it
  // supervises. A later process that happens to get the same pid has another.
  instance: string;
}

function liveRegistry(): LiveRegistry {
  liveManagers();
  return (globalThis as unknown as Record<symbol, LiveRegistry>)[LIVE_KEY];
}

export function processInstanceId(): string {
  return liveRegistry().instance;
}

function liveManagers(): Set<JobManager> {
  const g = globalThis as unknown as Record<symbol, LiveRegistry | undefined>;
  let reg = g[LIVE_KEY];
  if (!reg) {
    const created: LiveRegistry = {
      managers: new Set(),
      instance: randomBytes(16).toString("hex"),
    };
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
