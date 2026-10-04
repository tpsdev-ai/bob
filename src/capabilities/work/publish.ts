import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { GitInvocation, GitResult, GitRunner } from "./apply-patch.js";
import { type CandidateRecord, candidateIdentity, candidateRecordPath } from "./apply-patch.js";
import { bodyWithMarker, type PullRequestService, publicationMarker } from "./pull-request.js";
import { DRAIN_GRACE_MS, ensurePrivateDir, isInside, KILL_GRACE_MS, REAP_LIMIT_MS } from "./run.js";
import { PUBLICATION_ID, parseTaskBinding, type TaskBinding } from "./task-binding.js";

const HEX40 = /^[0-9a-f]{40}$/;

// Longer than a cancel's SIGTERM grace, SIGKILL reap limit and output drain.
const CHECK_SETTLE_MS = KILL_GRACE_MS + REAP_LIMIT_MS + DRAIN_GRACE_MS + 4000;

export type PublishStatus = "published" | "refused" | "indeterminate";

export type PushState = "confirmed_present" | "confirmed_absent" | "unknown";

export type PublishPhase = "intent" | "committed" | "checked" | "pushing" | "pushed" | "published";

export type PublishRefusalReason =
  | "unknown_task"
  | "invalid_binding"
  | "invalid_request"
  | "candidate_unknown"
  | "candidate_mismatch"
  | "scope_violation"
  | "expected_tree_mismatch"
  | "check_runner_unavailable"
  | "check_failed"
  | "check_timeout"
  | "check_cancelled"
  | "check_missing_status"
  | "check_incomplete"
  | "check_cleanup_unverified"
  | "materialize_failed"
  | "materialized_tree_changed"
  | "remote_diverged"
  | "remote_absent_unauthorized"
  | "push_rejected"
  | "push_failed"
  | "pr_unsupported"
  | "pr_service_unavailable"
  | "publication_locked"
  | "publication_conflict"
  | "aborted"
  | "storage_failed";

export interface PublishPrRequest {
  title: string;
  body?: string;
}

export interface PublishParams {
  candidate_id: string;
  commit_message: string;
  // Create a pull request after the push. Allowed only when the task binding
  // authorizes PR creation.
  pr?: PublishPrRequest;
}

// What a check command must report for publication to proceed. Mirrors the S1
// executor's outcome/cleanup/capture fields; `publish` applies the success rule.
export interface CheckReport {
  outcome: string | null;
  exit_code: number | null;
  cleanup_state: string | null;
  output_complete: boolean;
  elapsed_s?: number;
  output_excerpt?: string;
}

// On `signal` abort the runner kills the check it started.
export type CheckRunner = (
  command: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<CheckReport>;

export interface PublishDeps {
  // Seam: the git runner. Production spawns the real `git`.
  git?: GitRunner;
  // Seam: the S1 executor. Production runs the command through JobManager.
  runCheck?: CheckRunner;
  // How long an aborted publish waits for the cancelled check to settle.
  checkSettleMs?: number;
  now?: () => Date;
  // Test seams. `writeJournal`/`readJournal` default to an owner-only atomic
  // write/read under the state root.
  writeJournal?: (path: string, data: string) => void;
  readJournal?: (path: string) => string | null;
  // Runs after the commit object id is persisted and before materialization.
  afterCommitStored?: (commitOid: string) => void;
  // Runs after a push the remote accepted, before success is persisted. A test
  // throws here to model a terminated publisher with a lost acknowledgement.
  afterPushAccepted?: (commitOid: string) => void;
  // Seam: the pull-request service. Production uses `gh` (see pull-request.ts);
  // a test supplies a fake, so no network is used.
  pr?: PullRequestService;
  // Runs after the PR-creation intent is persisted and before the create call. A
  // test throws here to model a publisher terminated with no request sent.
  afterPrIntentStored?: (publicationId: string) => void;
}

export interface PublishResult {
  publication_id: string;
  candidate_id: string | null;
  tree_oid: string | null;
  commit_oid: string | null;
  status: PublishStatus;
  phase: PublishPhase;
  push_state: PushState;
  // Present only once a requested pull request is confirmed to exist.
  pr_url?: string;
  reason?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export interface PublishInput {
  binding: TaskBinding | undefined;
  bindingError?: string;
  params: PublishParams;
  stateRoot: string;
  deps?: PublishDeps;
  // The tool call's signal. An abort before the push refuses and never pushes.
  signal?: AbortSignal;
}

interface CommitMeta {
  tree_oid: string;
  parent_oid: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  timestamp: number;
  tz: string;
  message: string;
}

// PR-creation state, persisted before the create request so a retry reconciles
// an existing PR instead of issuing a second one.
interface JournalPr {
  head: string;
  base: string;
  title: string;
  // The effective body, marker included.
  body: string;
  marker: string;
  // intent: persisted, no request sent. creating: a request was sent, its
  // outcome not yet confirmed. created: a verified URL is recorded.
  state: "intent" | "creating" | "created";
  url?: string;
}

interface PublishJournal {
  v: 2;
  authority: TaskBinding;
  endpoint: string;
  publication_id: string;
  task_id: string;
  candidate_id: string;
  request: { commit_message: string; pr?: { title: string; body: string } };
  base_oid: string;
  tree_oid: string;
  changed_paths: string[];
  commit_meta: CommitMeta;
  commit_oid?: string;
  checks?: Array<{ command: string; ok: boolean; reason?: string }>;
  pr?: JournalPr;
  phase: PublishPhase;
  push_state: PushState;
  created_at: string;
}

function runGit(args: string[], inv: GitInvocation): GitResult {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (inv.indexFile !== undefined) env.GIT_INDEX_FILE = inv.indexFile;
  const r = spawnSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd: inv.cwd,
    env,
    input: inv.input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    return { status: -1, stdout: "", stderr: r.error.message };
  }
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

function refuse(
  reason: PublishRefusalReason,
  message: string,
  extra: Partial<PublishResult> = {},
): PublishResult {
  return {
    publication_id: "",
    candidate_id: null,
    tree_oid: null,
    commit_oid: null,
    phase: "intent",
    push_state: "unknown",
    status: "refused",
    reason,
    message,
    ...extra,
  };
}

function indeterminate(
  reason: string,
  message: string,
  extra: Partial<PublishResult>,
): PublishResult {
  return { status: "indeterminate", reason, message, ...extra } as PublishResult;
}

// --- changed-path computation ---------------------------------------------------

interface ChangedEntry {
  oldMode: string;
  newMode: string;
  path: string;
}

function parseDiffTree(out: string): ChangedEntry[] | null {
  const entries: ChangedEntry[] = [];
  if (out === "") return entries;
  if (!out.endsWith("\0")) return null;
  const fields = out.slice(0, -1).split("\0");
  if (fields.length % 2 !== 0) return null;
  for (let i = 0; i < fields.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]$/.exec(fields[i]);
    if (!m || fields[i + 1] === "") return null;
    entries.push({ oldMode: m[1], newMode: m[2], path: fields[i + 1] });
  }
  return entries;
}

// `--no-renames` so both sides of a rename appear; ignored or generated files
// that are present in the tree are included, not omitted.
function changedPaths(
  git: GitRunner,
  repo: string,
  base: string,
  tree: string,
): { ok: true; paths: string[] } | { ok: false; stderr: string } {
  const diff = git(["diff-tree", "-r", "--no-renames", "--raw", "-z", base, tree], { cwd: repo });
  if (diff.status !== 0) return { ok: false, stderr: diff.stderr.trim() };
  const entries = parseDiffTree(diff.stdout);
  if (entries === null) return { ok: false, stderr: "git diff-tree output could not be parsed" };
  return { ok: true, paths: entries.map((e) => e.path) };
}

// Declared paths match literal filenames or directory component boundaries.
function scopeOffenders(declared: string[], changed: string[]): string[] {
  const norm = declared.map((d) => d.replace(/\/+$/, ""));
  return changed.filter((path) => !norm.some((d) => path === d || path.startsWith(`${d}/`)));
}

// --- the commit object ----------------------------------------------------------

// Deterministic commit metadata, derived from the candidate record so a retry
// reuses it instead of regenerating. The commit object is written directly with
// `git hash-object -t commit -w` (no environment-dependent commit-tree), so the
// object id is reproducible.
function commitMeta(record: CandidateRecord, message: string): CommitMeta {
  const timestamp = Math.floor(Date.parse(record.created_at) / 1000);
  return {
    tree_oid: record.tree_oid,
    parent_oid: record.base_oid,
    author: { name: "bob-builder", email: "builder@bob.invalid" },
    committer: { name: "bob-builder", email: "builder@bob.invalid" },
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    tz: "+0000",
    message: message.replace(/\n+$/, ""),
  };
}

function commitObject(meta: CommitMeta): Buffer {
  const body = [
    `tree ${meta.tree_oid}`,
    `parent ${meta.parent_oid}`,
    `author ${meta.author.name} <${meta.author.email}> ${meta.timestamp} ${meta.tz}`,
    `committer ${meta.committer.name} <${meta.committer.email}> ${meta.timestamp} ${meta.tz}`,
    "",
    meta.message,
  ].join("\n");
  return Buffer.from(`${body}\n`, "utf8");
}

// --- the journal ----------------------------------------------------------------

export function publishJournalPath(stateRoot: string, publicationId: string): string {
  if (!PUBLICATION_ID.test(publicationId)) throw new Error("invalid publication_id");
  return join(stateRoot, "publications", `${publicationId}.json`);
}

export function writeJournalAtomic(path: string, data: string, sync = fsyncSync): void {
  const dir = join(path, "..");
  const root = join(dir, "..");
  ensurePrivateDir(root, false);
  ensurePrivateDir(dir, false);
  const rootFd = openSync(
    root,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const dirFd = openSync(
      dir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      const tmp = join(
        dir,
        `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      try {
        const fd = openSync(
          tmp,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(fd, data);
          sync(fd);
        } finally {
          closeSync(fd);
        }
        assertDirectory(root, rootFd);
        assertDirectory(dir, dirFd);
        renameSync(tmp, path);
        sync(dirFd);
        sync(rootFd);
      } finally {
        rmSync(tmp, { force: true });
      }
    } finally {
      closeSync(dirFd);
    }
  } finally {
    closeSync(rootFd);
  }
}

function assertDirectory(path: string, fd: number): void {
  ensurePrivateDir(path, false);
  const before = fstatSync(fd);
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino)
    throw new Error("storage directory changed");
}

function readRecord(path: string): string {
  const dir = join(path, "..");
  const root = join(dir, "..");
  ensurePrivateDir(root, false);
  ensurePrivateDir(dir, false);
  const rootFd = openSync(
    root,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const dirFd = openSync(
      dir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      const fd = openSync(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      try {
        if (!fstatSync(fd).isFile()) throw new Error("record is not a regular file");
        assertDirectory(root, rootFd);
        assertDirectory(dir, dirFd);
        return readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } finally {
      closeSync(dirFd);
    }
  } finally {
    closeSync(rootFd);
  }
}

function readJournalFile(path: string): string | null {
  try {
    lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    ensurePrivateDir(join(path, "..", ".."), false);
    ensurePrivateDir(join(path, ".."), false);
    return null;
  }
  return readRecord(path);
}

function parseJournal(raw: string): PublishJournal {
  const parsed = JSON.parse(raw) as PublishJournal;
  if (typeof parsed !== "object" || parsed === null || parsed.v !== 2) {
    throw new Error("publication journal is not a v2 record");
  }
  return parsed;
}

// --- materialization ------------------------------------------------------------

function gitCommonDir(git: GitRunner, repo: string): string | null {
  const r = git(["rev-parse", "--git-common-dir"], { cwd: repo });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  if (out === "") return null;
  return isAbsolute(out) ? out : resolve(repo, out);
}

// Materialize the candidate tree in a fresh, tool-owned checkout: its own Git
// directory, with the builder repository's object database as an alternate, so
// the checkout is independent of the builder's mutable working tree and index.
function materialize(
  git: GitRunner,
  repo: string,
  tree: string,
  dir: string,
): { ok: true } | { ok: false; message: string } {
  const common = gitCommonDir(git, repo);
  if (common === null)
    return { ok: false, message: "the repository's git directory cannot be read" };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, message: `checkout directory could not be created (${errCode(err)})` };
  }
  const init = git(["init", "-q"], { cwd: dir });
  if (init.status !== 0) return { ok: false, message: `git init failed (${init.stderr.trim()})` };
  try {
    const info = join(dir, ".git", "objects", "info");
    mkdirSync(info, { recursive: true, mode: 0o700 });
    writeFileSync(join(info, "alternates"), `${join(common, "objects")}\n`);
  } catch (err) {
    return { ok: false, message: `object alternate could not be written (${errCode(err)})` };
  }
  const read = git(["read-tree", tree], { cwd: dir });
  if (read.status !== 0) return { ok: false, message: `read-tree failed (${read.stderr.trim()})` };
  const checkout = git(["checkout-index", "-a", "-f"], { cwd: dir });
  if (checkout.status !== 0) {
    return { ok: false, message: `checkout-index failed (${checkout.stderr.trim()})` };
  }
  return { ok: true };
}

function materializedUnchanged(
  git: GitRunner,
  dir: string,
  tree: string,
): "unchanged" | "changed" | "verify_failed" {
  if (git(["update-index", "-q", "--refresh"], { cwd: dir }).status !== 0) return "verify_failed";
  const r = git(["diff-index", "--quiet", tree, "--"], { cwd: dir });
  if (r.status === 0) return "unchanged";
  if (r.status === 1) return "changed";
  return "verify_failed";
}

// --- remote operations ----------------------------------------------------------

type RemoteRefState =
  | { state: "present"; oid: string }
  | { state: "absent" }
  | { state: "unknown"; error: string };

function resolveEndpoint(git: GitRunner, binding: TaskBinding): string | null {
  const repo = binding.repository;
  if (
    !binding.destination.ref.startsWith("refs/heads/") ||
    git(["check-ref-format", binding.destination.ref], { cwd: repo }).status !== 0
  )
    return null;
  const rewrites = git(["config", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"], {
    cwd: repo,
  });
  if (rewrites.status !== 1) return null;
  const named = git(["remote", "get-url", "--all", binding.destination.remote], { cwd: repo });
  const endpoints =
    named.status === 0 ? named.stdout.trim().split("\n") : [binding.destination.remote];
  if (endpoints.length !== 1) return null;
  const endpoint = endpoints[0];
  if (!endpoint || /[\s\0]/.test(endpoint) || endpoint.startsWith("-")) return null;
  if (isAbsolute(endpoint)) return endpoint;
  if (/^(https?|ssh|git|file):\/\//.test(endpoint) || /^[^/:]+@[^/:]+:/.test(endpoint))
    return endpoint;
  if (endpoint.startsWith("./") || endpoint.startsWith("../")) return resolve(repo, endpoint);
  return null;
}

function inspectRemote(git: GitRunner, repo: string, remote: string, ref: string): RemoteRefState {
  const r = git(["ls-remote", remote, ref], { cwd: repo });
  if (r.status !== 0)
    return { state: "unknown", error: r.stderr.trim() || `git exited ${r.status}` };
  if (r.stdout === "") return { state: "absent" };
  const lines = r.stdout.replace(/\n$/, "").split("\n");
  const fields = lines[0].split("\t");
  if (lines.length !== 1 || fields.length !== 2 || !HEX40.test(fields[0]) || fields[1] !== ref)
    return { state: "unknown", error: "unexpected ls-remote output" };
  return { state: "present", oid: fields[0] };
}

function isAncestor(
  git: GitRunner,
  repo: string,
  ancestor: string,
  descendant: string,
): boolean | null {
  const { status } = git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo });
  return status === 0 ? true : status === 1 ? false : null;
}

// --- the lock -------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const pending = prev.then(() => gate);
  locks.set(key, pending);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === pending) locks.delete(key);
  }
}

// --- the flow -------------------------------------------------------------------

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? "error";
}

function requestOf(params: PublishParams): PublishJournal["request"] {
  if (params.pr === undefined) return { commit_message: params.commit_message };
  return {
    commit_message: params.commit_message,
    pr: { title: params.pr.title, body: params.pr.body ?? "" },
  };
}

function requestsEqual(a: PublishJournal["request"], b: PublishJournal["request"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const CHECK_SUCCESS_CLEANUP = new Set(["group_empty", "group_killed"]);

// Map a completed check's report to a refusal reason, or null when it passed
// under S1's outcome and cleanup rules with a complete capture.
function checkFailure(report: CheckReport): PublishRefusalReason | null {
  if (report.outcome === "no_exit_status" || report.outcome === null) return "check_missing_status";
  if (report.outcome !== "exited") {
    if (report.outcome === "timed_out") return "check_timeout";
    if (report.outcome === "cancelled") return "check_cancelled";
    return "check_failed";
  }
  if (report.exit_code !== 0) return "check_failed";
  if (report.cleanup_state === null || !CHECK_SUCCESS_CLEANUP.has(report.cleanup_state)) {
    return "check_cleanup_unverified";
  }
  if (!report.output_complete) return "check_incomplete";
  return null;
}

// `p`'s value, or null as soon as `signal` aborts.
function untilAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// True once `p` settles, false if `ms` passes first.
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  const settled = p.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([settled, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function removeTree(dir: string): string | null {
  try {
    rmSync(dir, { recursive: true, force: true });
    return null;
  } catch (err) {
    return errCode(err);
  }
}

// What outlives publishUnderLock: a checkout that could not be removed, and a
// cancelled check that had not settled, which keeps the lock until it does.
interface LockExit {
  checkoutLeft: { path: string; error: string } | null;
  holdUntil: Promise<void> | null;
}

export async function publish(input: PublishInput): Promise<PublishResult> {
  const deps = input.deps ?? {};
  const git = deps.git ?? runGit;

  if (input.bindingError !== undefined) {
    return refuse("invalid_binding", `publish refused: ${input.bindingError}`, {
      publication_id:
        "publication_id" in input.params ? String(input.params.publication_id ?? "") : "",
      candidate_id: null,
      tree_oid: null,
      commit_oid: null,
      phase: "intent",
      push_state: "unknown",
    });
  }
  if (input.binding === undefined) {
    return refuse(
      "unknown_task",
      "publish refused: this session holds no task binding, so there is no publication identity, repository, destination or check list to publish against. A task binding is supplied by the launcher, not by a tool argument, a file or bob.yaml.",
      {
        publication_id: "",
        candidate_id: null,
        tree_oid: null,
        commit_oid: null,
        phase: "intent",
        push_state: "unknown",
      },
    );
  }
  let binding: TaskBinding;
  try {
    binding = parseTaskBinding(JSON.stringify(input.binding)) as TaskBinding;
  } catch (err) {
    return refuse("invalid_binding", messageOf(err));
  }
  input = { ...input, binding, params: { ...input.params } };

  // Request shape. pi's schema checks this too; these checks make a
  // directly-driven call refuse as well.
  const params = input.params;
  if (typeof params?.candidate_id !== "string" || !HEX40.test(params.candidate_id)) {
    return refuse(
      "invalid_request",
      "publish refused: candidate_id must be 40 lowercase hex characters.",
      {
        publication_id: binding.publication_id,
        candidate_id: null,
        tree_oid: null,
        commit_oid: null,
        phase: "intent",
        push_state: "unknown",
      },
    );
  }
  if (typeof params.commit_message !== "string" || params.commit_message.trim() === "") {
    return refuse("invalid_request", "publish refused: commit_message is required.", {
      publication_id: binding.publication_id,
      candidate_id: params.candidate_id,
      tree_oid: null,
      commit_oid: null,
      phase: "intent",
      push_state: "unknown",
    });
  }
  const rawPr = (params as { pr?: unknown }).pr;
  if (rawPr !== undefined) {
    if (binding.pr === undefined) {
      return refuse(
        "pr_unsupported",
        "publish refused: this task binding does not authorize PR creation; omit pr.",
        {
          publication_id: binding.publication_id,
          candidate_id: params.candidate_id,
          tree_oid: null,
          commit_oid: null,
          phase: "intent",
          push_state: "unknown",
        },
      );
    }
    if (typeof rawPr !== "object" || rawPr === null || Array.isArray(rawPr)) {
      return refuse(
        "invalid_request",
        "publish refused: pr must be an object with a title and an optional body.",
        {
          publication_id: binding.publication_id,
          candidate_id: params.candidate_id,
          tree_oid: null,
          commit_oid: null,
          phase: "intent",
          push_state: "unknown",
        },
      );
    }
    const fields = rawPr as Record<string, unknown>;
    if (typeof fields.title !== "string" || fields.title.trim() === "") {
      return refuse("invalid_request", "publish refused: pr.title is required.", {
        publication_id: binding.publication_id,
        candidate_id: params.candidate_id,
        tree_oid: null,
        commit_oid: null,
        phase: "intent",
        push_state: "unknown",
      });
    }
    if (fields.body !== undefined && typeof fields.body !== "string") {
      return refuse("invalid_request", "publish refused: pr.body must be a string.", {
        publication_id: binding.publication_id,
        candidate_id: params.candidate_id,
        tree_oid: null,
        commit_oid: null,
        phase: "intent",
        push_state: "unknown",
      });
    }
    const unknownPr = Object.keys(fields).filter((key) => key !== "title" && key !== "body");
    if (unknownPr.length)
      return refuse(
        "invalid_request",
        `publish refused: unsupported pr arguments: ${unknownPr.join(", ")}`,
      );
    if (deps.pr === undefined)
      return refuse(
        "pr_service_unavailable",
        "publish refused: PR creation was requested but no PR service is wired, so no PR can be created. Nothing external was attempted.",
        {
          publication_id: binding.publication_id,
          candidate_id: params.candidate_id,
          tree_oid: null,
          commit_oid: null,
          phase: "intent",
          push_state: "unknown",
        },
      );
  }

  const unknown = Object.keys(params).filter(
    (key) => key !== "candidate_id" && key !== "commit_message" && key !== "pr",
  );
  if (unknown.length)
    return refuse(
      "invalid_request",
      `publish refused: unsupported arguments: ${unknown.join(", ")}`,
    );
  return withLock(`${input.stateRoot}/${binding.publication_id}`, () =>
    publishLocked(input, git, deps),
  );
}

async function publishLocked(
  input: PublishInput,
  git: GitRunner,
  deps: PublishDeps,
): Promise<PublishResult> {
  const binding = input.binding as TaskBinding;
  const stateRoot = input.stateRoot;
  const params = input.params;

  const base: Pick<
    PublishResult,
    "publication_id" | "candidate_id" | "tree_oid" | "commit_oid" | "phase" | "push_state"
  > = {
    publication_id: binding.publication_id,
    candidate_id: params.candidate_id,
    tree_oid: null,
    commit_oid: null,
    phase: "intent",
    push_state: "unknown",
  };
  const fail = (
    reason: PublishRefusalReason,
    message: string,
    extra: Partial<PublishResult> = {},
  ) => refuse(reason, message, { ...base, ...extra });

  // The state root must be outside the repository and the workspace, owner-only.
  const inside = (
    [
      [binding.workspace, "the workspace"],
      [binding.repository, "the repository"],
    ] as Array<[string, string]>
  ).filter(([root]) => isInside(root, stateRoot));
  if (inside.length > 0) {
    return fail(
      "storage_failed",
      `publish refused: the tool state directory ${stateRoot} is inside ${inside
        .map(([root, what]) => `${what} ${root}`)
        .join(
          " and ",
        )}, where the publication journal would become a stray file in the caller's checkout. Run bob with a temp directory (TMPDIR) outside the workspace and the repository.`,
    );
  }
  try {
    ensurePrivateDir(stateRoot, true);
  } catch (err) {
    return fail("storage_failed", `publish refused: ${messageOf(err)}`);
  }

  const dir = join(stateRoot, "publications");
  let lock: string;
  try {
    ensurePrivateDir(dir, true);
    lock = join(dir, `${binding.publication_id}.lock`);
    mkdirSync(lock, { mode: 0o700 });
  } catch (err) {
    return fail(
      errCode(err) === "EEXIST" ? "publication_locked" : "storage_failed",
      `publish refused: publication lock could not be acquired (${errCode(err)}).`,
    );
  }
  const exit: LockExit = { checkoutLeft: null, holdUntil: null };
  try {
    const result = await publishUnderLock(input, git, deps, exit);
    if (exit.checkoutLeft === null) return result;
    return {
      ...result,
      detail: {
        ...result.detail,
        checkout_left: exit.checkoutLeft.path,
        checkout_remove_error: exit.checkoutLeft.error,
      },
    };
  } finally {
    if (exit.holdUntil === null) rmSync(lock, { recursive: true });
    else void exit.holdUntil.then(() => removeTree(lock));
  }
}

async function publishUnderLock(
  input: PublishInput,
  git: GitRunner,
  deps: PublishDeps,
  exit: LockExit,
): Promise<PublishResult> {
  const binding = input.binding as TaskBinding;
  const stateRoot = input.stateRoot;
  const params = input.params;
  const fail = (
    reason: PublishRefusalReason,
    message: string,
    extra: Partial<PublishResult> = {},
  ) =>
    refuse(reason, message, {
      publication_id: binding.publication_id,
      candidate_id: params.candidate_id,
      tree_oid: null,
      commit_oid: null,
      phase: "intent",
      push_state: "unknown",
      ...extra,
    });

  // Only ENOENT means the candidate is absent.
  const recordPath = candidateRecordPath(stateRoot, params.candidate_id);
  let record: CandidateRecord;
  try {
    const raw = readRecord(recordPath);
    record = JSON.parse(raw) as CandidateRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fail(
        "candidate_unknown",
        `publish refused: no stored candidate ${params.candidate_id} exists under the tool state directory. Build the candidate with apply_patch first; a candidate id is not permission to publish.`,
      );
    }
    return fail(
      "storage_failed",
      `publish refused: the candidate record ${recordPath} could not be read (${errCode(err)}).`,
    );
  }

  // Association: the candidate must belong to this task, repository, base and
  // publication.
  if (
    record === null ||
    record.candidate_id !== params.candidate_id ||
    candidateIdentity(record) !== params.candidate_id ||
    record.task_id !== binding.task_id ||
    record.repository !== binding.repository ||
    record.workspace !== binding.workspace ||
    record.base_oid !== binding.base_oid ||
    record.publication_id !== binding.publication_id
  ) {
    return fail(
      "candidate_mismatch",
      `publish refused: candidate ${params.candidate_id} is not associated with this task, repository, base or publication. A candidate id is not permission to publish.`,
      { tree_oid: record?.tree_oid ?? null },
    );
  }
  if (record.mode !== binding.mode) {
    return fail(
      "candidate_mismatch",
      `publish refused: candidate ${params.candidate_id} was built in mode "${record.mode}", not the task's "${binding.mode}".`,
      { tree_oid: record.tree_oid },
    );
  }

  const treeOid = record.tree_oid;
  const commitMetaResolved = commitMeta(record, params.commit_message);

  const changed = changedPaths(git, binding.repository, binding.base_oid, treeOid);
  if (!changed.ok) {
    return fail(
      "candidate_mismatch",
      `publish refused: the candidate's changed paths could not be read from ${binding.repository} (${changed.stderr}).`,
      { tree_oid: treeOid },
    );
  }
  const offenders = scopeOffenders(binding.declared_paths, changed.paths);
  if (offenders.length > 0) {
    return fail(
      "scope_violation",
      `publish refused: the candidate changes paths outside the task's declared scope: ${offenders.join(", ")}. Declared: ${
        binding.declared_paths.length === 0 ? "(none)" : binding.declared_paths.join(", ")
      }.`,
      { tree_oid: treeOid, detail: { offenders, declared: binding.declared_paths } },
    );
  }

  // In apply mode the candidate tree must BE the task's expected tree.
  if (binding.mode === "apply" && treeOid !== binding.expected_tree_oid) {
    return fail(
      "expected_tree_mismatch",
      `publish refused: in apply mode the candidate tree ${treeOid} is not the task's expected tree ${binding.expected_tree_oid}. An equivalent-looking diff is insufficient.`,
      { tree_oid: treeOid },
    );
  }
  if (
    binding.mode === "apply" &&
    binding.patch_sha256 !== undefined &&
    record.patch_sha256 !== binding.patch_sha256
  ) {
    return fail(
      "candidate_mismatch",
      `publish refused: candidate ${params.candidate_id} was applied from artifact ${record.patch_sha256}, not the task-authorized ${binding.patch_sha256}.`,
      { tree_oid: treeOid },
    );
  }

  const endpoint = resolveEndpoint(git, binding);
  if (endpoint === null)
    return fail(
      "invalid_binding",
      "publish refused: destination must resolve to one endpoint without URL rewrites and a valid branch ref.",
    );

  const journalPath = publishJournalPath(stateRoot, binding.publication_id);
  const readJ = deps.readJournal ?? readJournalFile;
  const writeJ = deps.writeJournal ?? writeJournalAtomic;

  let existing: PublishJournal | null = null;
  let rawJournal: string | null;
  try {
    rawJournal = readJ(journalPath);
  } catch (err) {
    return fail(
      "storage_failed",
      `publish refused: the publication journal ${journalPath} could not be read (${errCode(err)}). Nothing external was attempted.`,
      { tree_oid: treeOid, detail: { reason: "journal_read_failed" } },
    );
  }
  if (rawJournal !== null) {
    try {
      existing = parseJournal(rawJournal);
    } catch (err) {
      return fail(
        "storage_failed",
        `publish refused: the publication journal ${journalPath} is not readable (${messageOf(err)}).`,
        { tree_oid: treeOid },
      );
    }
    // Reusing a publication identity with different candidate content or
    // publication parameters refuses.
    if (
      existing.publication_id !== binding.publication_id ||
      JSON.stringify(existing.authority) !== JSON.stringify(binding) ||
      existing.endpoint !== endpoint ||
      existing.candidate_id !== params.candidate_id ||
      existing.tree_oid !== treeOid ||
      !requestsEqual(existing.request, requestOf(params))
    ) {
      return fail(
        "publication_conflict",
        `publish refused: publication ${binding.publication_id} was already started with different candidate content or publication parameters. A new publication attempt needs a new launcher-authorized publication identity.`,
        {
          tree_oid: existing.tree_oid,
          commit_oid: existing.commit_oid ?? null,
          phase: existing.phase,
          push_state: existing.push_state,
        },
      );
    }
  }

  const now = deps.now ?? (() => new Date());
  const journal: PublishJournal =
    existing ??
    ({
      v: 2,
      authority: binding,
      endpoint,
      publication_id: binding.publication_id,
      task_id: binding.task_id,
      candidate_id: params.candidate_id,
      request: requestOf(params),
      base_oid: binding.base_oid,
      tree_oid: treeOid,
      changed_paths: changed.paths,
      commit_meta: commitMetaResolved,
      phase: "intent",
      push_state: "unknown",
      created_at: now().toISOString(),
    } satisfies PublishJournal);

  let pushAttempted = ["pushing", "pushed", "published"].includes(journal.phase);
  const persist = (): PublishResult | null => {
    try {
      writeJ(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      return null;
    } catch (err) {
      if (pushAttempted)
        return indeterminate(
          "journal_write_failed",
          `publish indeterminate: the publication journal could not be persisted (${errCode(err)}).`,
          {
            publication_id: binding.publication_id,
            candidate_id: params.candidate_id,
            tree_oid: treeOid,
            commit_oid: journal.commit_oid ?? null,
            phase: journal.phase,
            push_state: journal.push_state,
          },
        );
      return fail(
        "storage_failed",
        `publish refused: the publication intent could not be persisted to ${journalPath} (${errCode(err)}). No external effect was attempted without durable prior intent.`,
        { tree_oid: treeOid, commit_oid: journal.commit_oid ?? null, phase: journal.phase },
      );
    }
  };

  // 1. Intent (with the commit metadata) is durable before any external effect.
  const intentFail = persist();
  if (intentFail !== null) return intentFail;

  // 2. Create the commit object and persist its id. A retry reuses the id.
  if (journal.commit_oid === undefined) {
    const obj = commitObject(journal.commit_meta);
    const hashed = git(["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: binding.repository,
      input: obj,
    });
    if (hashed.status !== 0) {
      return fail(
        "storage_failed",
        `publish refused: the commit object could not be written to ${binding.repository} (${hashed.stderr.trim() || `git exited ${hashed.status}`}).`,
        { tree_oid: treeOid },
      );
    }
    const commitOid = hashed.stdout.trim();
    if (!HEX40.test(commitOid)) {
      return fail(
        "storage_failed",
        `publish refused: the written commit id ${JSON.stringify(commitOid)} is not a 40-character object id.`,
        { tree_oid: treeOid },
      );
    }
    journal.commit_oid = commitOid;
    journal.phase = "committed";
    const committedFail = persist();
    if (committedFail !== null) return committedFail;
  }
  const commitOid = journal.commit_oid;

  deps.afterCommitStored?.(commitOid);

  // 3. Materialize the candidate in a fresh, tool-owned checkout and run checks.
  // Skipped on recovery once the checks have passed.
  const checksPassed =
    journal.checks?.length === binding.check_commands.length &&
    journal.checks.every((c, i) => c.ok && c.command === binding.check_commands[i]);
  const signal = input.signal;
  const abortedFail = () =>
    fail("aborted", "publish refused: the publish tool call was aborted before the push.", {
      tree_oid: treeOid,
      commit_oid: commitOid,
      phase: journal.phase,
    });
  if (!checksPassed) {
    if (deps.runCheck === undefined) {
      return fail(
        "check_runner_unavailable",
        "publish refused: no check executor is wired, so the task's required checks cannot run. Publication requires the S1 executor.",
        { tree_oid: treeOid, commit_oid: commitOid, phase: journal.phase },
      );
    }
    let dir: string;
    try {
      dir = mkdtempSync(join(stateRoot, "publish-checkout-"));
    } catch (err) {
      return fail(
        "storage_failed",
        `publish refused: the tool could not create a checkout directory under ${stateRoot} (${errCode(err)}).`,
        { tree_oid: treeOid, commit_oid: commitOid },
      );
    }
    try {
      const mat = materialize(git, binding.repository, treeOid, dir);
      if (!mat.ok) {
        return fail(
          "materialize_failed",
          `publish refused: the candidate could not be materialized (${mat.message}).`,
          {
            tree_oid: treeOid,
            commit_oid: commitOid,
          },
        );
      }
      const before = materializedUnchanged(git, dir, treeOid);
      if (before !== "unchanged") {
        return fail(
          "materialize_failed",
          `publish refused: the materialized checkout does not match the candidate tree (${before}).`,
          { tree_oid: treeOid, commit_oid: commitOid },
        );
      }

      const results: PublishJournal["checks"] = [];
      for (const command of binding.check_commands) {
        if (signal?.aborted) return abortedFail();
        let report: CheckReport | null;
        let running: Promise<CheckReport> | undefined;
        try {
          running = deps.runCheck(command, dir, signal);
          report = await untilAbort(running, signal);
        } catch (err) {
          results.push({ command, ok: false, reason: "check_failed" });
          journal.checks = results;
          journal.phase = "committed";
          const storageFail = persist();
          if (storageFail !== null) return storageFail;
          return fail(
            "check_failed",
            `publish refused: the required check ${JSON.stringify(command)} could not be run (${messageOf(err)}).`,
            { tree_oid: treeOid, commit_oid: commitOid, phase: journal.phase },
          );
        }
        if (report === null) {
          const settleMs = deps.checkSettleMs ?? CHECK_SETTLE_MS;
          if (!(await settlesWithin(running, settleMs))) {
            exit.holdUntil = running.then(
              () => {},
              () => {},
            );
            return fail(
              "aborted",
              `publish refused: the publish tool call was aborted before the push, and the cancelled check ${JSON.stringify(command)} had not exited after ${settleMs} ms. The publication lock is held until it exits, so a retry is refused as publication_locked.`,
              { tree_oid: treeOid, commit_oid: commitOid, phase: journal.phase },
            );
          }
          return abortedFail();
        }
        if (signal?.aborted) return abortedFail();
        const after = materializedUnchanged(git, dir, treeOid);
        if (after !== "unchanged") {
          results.push({ command, ok: false, reason: "materialized_tree_changed" });
          journal.checks = results;
          journal.phase = "committed";
          const storageFail = persist();
          if (storageFail !== null) return storageFail;
          return fail(
            "materialized_tree_changed",
            after === "changed"
              ? `publish refused: the required check ${JSON.stringify(command)} changed tracked source in the materialized tree.`
              : `publish refused: the materialized source tree could not be verified after ${JSON.stringify(command)} (${after}).`,
            { tree_oid: treeOid, commit_oid: commitOid, phase: journal.phase },
          );
        }
        const reason = checkFailure(report);
        results.push(reason === null ? { command, ok: true } : { command, ok: false, reason });
        if (reason !== null) {
          journal.checks = results;
          journal.phase = "committed";
          const storageFail = persist();
          if (storageFail !== null) return storageFail;
          return fail(
            reason,
            `publish refused: the required check ${JSON.stringify(command)} did not pass (${reason}). A missing check, a nonzero exit, a timeout, a cancellation, a missing exit status, uncertain cleanup or an incomplete capture prevents publication.`,
            {
              tree_oid: treeOid,
              commit_oid: commitOid,
              phase: journal.phase,
              detail: { outcome: report.outcome, exit_code: report.exit_code },
            },
          );
        }
      }
      journal.checks = results;
      journal.phase = "checked";
      const checkedFail = persist();
      if (checkedFail !== null) return checkedFail;
    } finally {
      if (exit.holdUntil === null) {
        const error = removeTree(dir);
        if (error !== null) exit.checkoutLeft = { path: dir, error };
      } else {
        exit.holdUntil = exit.holdUntil.then(() => {
          removeTree(dir);
        });
      }
    }
  }

  let transportDir: string;
  try {
    transportDir = mkdtempSync(join(stateRoot, "publish-transport-"));
  } catch (err) {
    return fail(
      "storage_failed",
      `publish refused: transport preparation failed (${messageOf(err)}).`,
    );
  }
  try {
    try {
      const init = git(["init", "-q", "--bare", transportDir], { cwd: stateRoot });
      if (init.status !== 0) throw new Error(init.stderr || "transport init failed");
      const common = gitCommonDir(git, binding.repository);
      if (common === null) throw new Error("object directory unavailable");
      const info = join(transportDir, "objects", "info");
      mkdirSync(info, { recursive: true });
      writeFileSync(join(info, "alternates"), `${join(common, "objects")}\n`, { flag: "wx" });
    } catch (err) {
      return fail(
        "storage_failed",
        `publish refused: transport preparation failed (${messageOf(err)}).`,
      );
    }
    const sourceGit = git;
    git = (args, inv) =>
      sourceGit(args, {
        ...inv,
        cwd: args[0] === "ls-remote" || args[0] === "push" ? transportDir : inv.cwd,
      });
    // 4. Inspect the authoritative remote ref and decide the push.
    const remote = journal.endpoint;
    const { ref } = binding.destination;
    const observed = inspectRemote(git, binding.repository, remote, ref);
    if (observed.state === "unknown") {
      return indeterminate(
        "remote_unavailable",
        `publish indeterminate: the authoritative remote ${remote} ${ref} could not be inspected (${observed.error}); whether the commit is published is unknown.`,
        {
          publication_id: binding.publication_id,
          candidate_id: params.candidate_id,
          tree_oid: treeOid,
          commit_oid: commitOid,
          phase: journal.phase,
          push_state: "unknown",
        },
      );
    }

    let pushExpected: string | null;
    if (observed.state === "present") {
      const contains =
        observed.oid === commitOid || isAncestor(git, binding.repository, commitOid, observed.oid);
      if (contains === true) {
        // The remote already contains the pinned commit: confirmed present.
        return await finishPublished(input, journal, commitOid, treeOid, git, deps, true);
      }
      const precedes = isAncestor(git, binding.repository, observed.oid, commitOid);
      if (contains === null || precedes === null)
        return indeterminate(
          "ancestry_unknown",
          "publish indeterminate: remote ancestry could not be compared.",
          {
            publication_id: binding.publication_id,
            candidate_id: params.candidate_id,
            tree_oid: treeOid,
            commit_oid: commitOid,
            phase: journal.phase,
            push_state: "unknown",
          },
        );
      if (!precedes) {
        // Neither is an ancestor of the other: a conflicting ref. Never rebase,
        // amend or force.
        return fail(
          "remote_diverged",
          `publish refused: the remote ${remote} ${ref} is at ${observed.oid}, which neither contains nor precedes the pinned commit ${commitOid}. Divergence is refused; publication does not rebase, amend, merge or force.`,
          {
            tree_oid: treeOid,
            commit_oid: commitOid,
            push_state: "confirmed_absent",
            phase: journal.phase,
          },
        );
      }
      // The remote is an ancestor of the commit: a fast-forward.
      pushExpected = observed.oid;
    } else {
      // Absent. Creating an absent ref requires explicit authorization.
      if (binding.destination.create !== true) {
        return fail(
          "remote_absent_unauthorized",
          `publish refused: the remote ${remote} ${ref} does not exist and the task binding does not authorize creating it.`,
          { tree_oid: treeOid, commit_oid: commitOid, push_state: "confirmed_absent" },
        );
      }
      pushExpected = null;
    }

    if (signal?.aborted) return abortedFail();
    journal.phase = "pushing";
    journal.push_state = "unknown";
    const pushingFail = persist();
    if (pushingFail !== null) return pushingFail;

    const pushArgs =
      pushExpected === null
        ? ["push", `--force-with-lease=${ref}:`, remote, `${commitOid}:${ref}`]
        : ["push", `--force-with-lease=${ref}:${pushExpected}`, remote, `${commitOid}:${ref}`];
    pushAttempted = true;
    const pushed = git(pushArgs, { cwd: binding.repository });
    if (pushed.status !== 0) {
      const stderr = pushed.stderr.trim();
      // Reconcile unclassified push failures against the remote.
      if (/\[rejected\]|non-fast-forward|stale info|fetch first|cannot lock ref/i.test(stderr)) {
        return fail(
          "push_rejected",
          `publish refused: the remote ${remote} ${ref} rejected the fast-forward push (${stderr || `git exited ${pushed.status}`}). The remote history is preserved.`,
          {
            tree_oid: treeOid,
            commit_oid: commitOid,
            phase: "pushing",
            push_state: "unknown",
          },
        );
      }
      const after = inspectRemote(git, binding.repository, remote, ref);
      if (after.state === "present" && after.oid === commitOid) {
        return await finishPublished(input, journal, commitOid, treeOid, git, deps, true);
      }
      return indeterminate(
        "push_unknown",
        `publish indeterminate: the push to ${remote} ${ref} reported ${stderr || `git exited ${pushed.status}`} and the remote could not be reconciled. The commit may or may not be published.`,
        {
          publication_id: binding.publication_id,
          candidate_id: params.candidate_id,
          tree_oid: treeOid,
          commit_oid: commitOid,
          phase: "pushing",
          push_state: "unknown",
        },
      );
    }

    // The remote accepted the push. Persist success only after the acknowledgement
    // (a test may terminate here with the acknowledgement lost).
    deps.afterPushAccepted?.(commitOid);
    journal.phase = "pushed";
    journal.push_state = "confirmed_present";
    const pushedFail = persist();
    if (pushedFail !== null) return pushedFail;

    return await finishPublished(input, journal, commitOid, treeOid, git, deps, false);
  } finally {
    rmSync(transportDir, { recursive: true, force: true });
  }
}

// The branch the PR is opened from: the task's authorized head, or the pushed
// branch when the task does not name one.
function prHead(binding: TaskBinding): string {
  const pr = binding.pr as { base: string; head?: string };
  return pr.head ?? binding.destination.ref.replace(/^refs\/heads\//, "");
}

type PrReconcile =
  | { kind: "found"; url: string }
  | { kind: "absent" }
  | { kind: "unknown"; error: string };

// Reconcile by the authorized repository and head/base pair, accepting an
// already open, closed or merged PR, and reusing its URL only when the body
// carries this publication's marker. A list that cannot be read is `unknown`,
// never `absent`.
async function reconcilePr(
  service: PullRequestService,
  repository: string,
  head: string,
  base: string,
  marker: string,
): Promise<PrReconcile> {
  let records: unknown;
  try {
    records = await service.list({ repository, head, base });
  } catch (err) {
    return { kind: "unknown", error: messageOf(err) };
  }
  if (!Array.isArray(records)) return { kind: "unknown", error: "the PR service returned no list" };
  for (const raw of records) {
    const rec = raw as {
      url?: unknown;
      head?: unknown;
      base?: unknown;
      body?: unknown;
      repository?: unknown;
    } | null;
    if (rec === null || typeof rec !== "object") continue;
    if (typeof rec.url !== "string" || rec.url === "") continue;
    if (rec.head !== head || rec.base !== base) continue;
    if (typeof rec.body !== "string" || !rec.body.includes(marker)) continue;
    if (rec.repository !== undefined && rec.repository !== repository) continue;
    return { kind: "found", url: rec.url };
  }
  return { kind: "absent" };
}

type PrOutcome = { ok: true; url: string } | { ok: false; reason: string; message: string };

// Create the requested pull request, or confirm an existing one, after the push
// is confirmed. The intent is persisted before any create request; a create
// whose outcome is not confirmed is indeterminate and is never reissued.
async function ensurePullRequest(
  input: PublishInput,
  journal: PublishJournal,
  deps: PublishDeps,
): Promise<PrOutcome> {
  const binding = input.binding as TaskBinding;
  const service = deps.pr as PullRequestService;
  const params = input.params;
  const requested = params.pr as PublishPrRequest;
  const head = prHead(binding);
  const base = (binding.pr as { base: string }).base;
  const repository = journal.endpoint;
  const marker = publicationMarker(binding.publication_id);

  const journalPath = publishJournalPath(input.stateRoot, binding.publication_id);
  const writeJ = deps.writeJournal ?? writeJournalAtomic;
  const persist = (): unknown | null => {
    try {
      writeJ(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      return null;
    } catch (err) {
      return err;
    }
  };

  let pr = journal.pr;
  if (pr?.url !== undefined && pr.url !== "") return { ok: true, url: pr.url };

  // 1. The immutable intent is durable before any create request.
  if (pr === undefined) {
    pr = journal.pr = {
      head,
      base,
      title: requested.title,
      body: bodyWithMarker(requested.body ?? "", marker),
      marker,
      state: "intent",
    };
    const err = persist();
    if (err !== null)
      return {
        ok: false,
        reason: "journal_write_failed",
        message: `publish indeterminate: commit ${journal.commit_oid} is published but the PR intent could not be persisted (${errCode(err)}); no PR was created.`,
      };
  }
  deps.afterPrIntentStored?.(binding.publication_id);

  // 2. Reconcile before creating, so a retry or recovery reuses the PR this
  // publication already created instead of issuing a second one.
  const found = await reconcilePr(service, repository, head, base, marker);
  if (found.kind === "found") {
    pr.state = "created";
    pr.url = found.url;
    const err = persist();
    return err === null
      ? { ok: true, url: found.url }
      : {
          ok: false,
          reason: "journal_write_failed",
          message: `publish indeterminate: the PR ${found.url} exists but the journal could not record it (${errCode(err)}).`,
        };
  }
  if (found.kind === "unknown")
    return {
      ok: false,
      reason: "pr_unreconciled",
      message: `publish indeterminate: commit ${journal.commit_oid} is published but whether the requested PR exists could not be reconciled (${found.error}). No second create was issued.`,
    };

  // 3. No PR exists. A create that was already sent is never reissued.
  if (pr.state === "creating")
    return {
      ok: false,
      reason: "pr_uncertain",
      message: `publish indeterminate: a PR create for ${repository} ${head}->${base} was already issued and no PR can be reconciled; no second PR was created.`,
    };
  pr.state = "creating";
  const creatingErr = persist();
  if (creatingErr !== null)
    return {
      ok: false,
      reason: "journal_write_failed",
      message: `publish indeterminate: the commit is published but the PR create intent could not be persisted (${errCode(creatingErr)}); no PR was created.`,
    };

  let url: string;
  try {
    const created = await service.create({
      repository,
      head,
      base,
      title: pr.title,
      body: pr.body,
    });
    if (created === null || typeof created.url !== "string" || created.url === "")
      throw new Error("the PR service returned no URL");
    url = created.url;
  } catch (err) {
    // The request may have succeeded; the outcome is unknown, so no second
    // create is issued. A retry reconciles.
    return {
      ok: false,
      reason: "pr_uncertain",
      message: `publish indeterminate: the PR create for ${repository} ${head}->${base} reported ${messageOf(err)} and its outcome is unknown; no second create was issued.`,
    };
  }
  pr.state = "created";
  pr.url = url;
  const err = persist();
  return err === null
    ? { ok: true, url }
    : {
        ok: false,
        reason: "journal_write_failed",
        message: `publish indeterminate: the PR ${url} exists but the journal could not record it (${errCode(err)}).`,
      };
}

// Confirm the remote and report `published`. `remoteConfirmed`
// is true when a prior inspection already established the commit is present.
async function finishPublished(
  input: PublishInput,
  journal: PublishJournal,
  commitOid: string,
  treeOid: string,
  git: GitRunner,
  deps: PublishDeps,
  remoteConfirmed: boolean,
): Promise<PublishResult> {
  const binding = input.binding as TaskBinding;
  const stateRoot = input.stateRoot;
  const journalPath = publishJournalPath(stateRoot, binding.publication_id);
  const writeJ = deps.writeJournal ?? writeJournalAtomic;

  const persist = (): PublishResult | null => {
    try {
      writeJ(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      return null;
    } catch (err) {
      return indeterminate(
        "journal_write_failed",
        `publish indeterminate: the remote accepted commit ${commitOid} but the journal ${journalPath} could not record it (${errCode(err)}). The commit is on the remote; a retry reconciles it.`,
        {
          publication_id: binding.publication_id,
          candidate_id: journal.candidate_id,
          tree_oid: treeOid,
          commit_oid: commitOid,
          phase: journal.phase,
          push_state: "confirmed_present",
        },
      );
    }
  };

  if (!remoteConfirmed) {
    const observed = inspectRemote(
      git,
      binding.repository,
      journal.endpoint,
      binding.destination.ref,
    );
    if (
      observed.state !== "present" ||
      (observed.oid !== commitOid &&
        isAncestor(git, binding.repository, commitOid, observed.oid) !== true)
    ) {
      return indeterminate(
        "remote_unconfirmed",
        `publish indeterminate: commit ${commitOid} is not confirmed on the remote ${binding.destination.remote} ${binding.destination.ref}.`,
        {
          publication_id: binding.publication_id,
          candidate_id: journal.candidate_id,
          tree_oid: treeOid,
          commit_oid: commitOid,
          phase: "pushing",
          push_state: observed.state === "absent" ? "confirmed_absent" : "unknown",
        },
      );
    }
  }

  journal.phase = "pushed";
  journal.push_state = "confirmed_present";

  // A requested PR is created after the push is confirmed, and reported only
  // once it is. An unresolved PR leaves the commit published and the whole
  // result indeterminate.
  if (input.params.pr !== undefined) {
    const prOutcome = await ensurePullRequest(input, journal, deps);
    if (!prOutcome.ok) {
      const prFail = persist();
      if (prFail !== null) return prFail;
      return indeterminate(prOutcome.reason, prOutcome.message, {
        publication_id: binding.publication_id,
        candidate_id: journal.candidate_id,
        tree_oid: treeOid,
        commit_oid: commitOid,
        phase: "pushed",
        push_state: "confirmed_present",
      });
    }
    journal.phase = "published";
    const prFinalFail = persist();
    if (prFinalFail !== null) return prFinalFail;
    return {
      publication_id: binding.publication_id,
      candidate_id: journal.candidate_id,
      tree_oid: treeOid,
      commit_oid: commitOid,
      status: "published",
      phase: "published",
      push_state: "confirmed_present",
      pr_url: prOutcome.url,
    };
  }

  journal.phase = "published";
  const finalFail = persist();
  if (finalFail !== null) return finalFail;
  return {
    publication_id: binding.publication_id,
    candidate_id: journal.candidate_id,
    tree_oid: treeOid,
    commit_oid: commitOid,
    status: "published",
    phase: "published",
    push_state: "confirmed_present",
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
