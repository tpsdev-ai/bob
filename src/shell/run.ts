// `bob run <name> [prompt]` — invoke an onboarded agent for a short-lived,
// `claude -p`-style task: spin up a fresh session, send one prompt, capture
// the assistant's final text, exit.
//
// THERE IS ONE SESSION BUILDER: `createPiRunSession` below is a thin wrapper
// over the runtime factory in session.ts, so `bob run`, the persistent runtime,
// the launcher (`bob launch`), the mail consumer, onboarding and alignment all
// stand up the same session from the same place. bob never spawns the pi CLI
// and never builds pi argv — an argv built here is a second policy surface,
// which is how a caller's arguments used to widen the role ceiling.
//
// EVERY launch path resolves the tool policy HERE: the session factory gets it
// through RunSessionConfig (required — see the interface), so there is no path
// that starts an agent session without it. In the interactive mode the same
// resolved policy is what the factory creates the session with.
//
// Config resolution:
//   - provider + model come from ~/agents/<name>/bob.yaml (`provider:` block)
//   - soul.md is appended to pi's system prompt, preserving the agent's persona
//   - per-agent credentials live in ~/agents/<name>/.pi-agent/{auth,models}.json
//     (the old launcher's PI_CODING_AGENT_DIR) — we point pi's ModelRuntime at
//     that dir so the exe-dev-gateway baseUrl override and auth.json are honored
//     without env juggling.
//
// Model override is per-call (`opts.model`): it replaces the bob.yaml model
// for this invocation only.

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { readAgentRole, readBlock, readCron, readResident, readTools } from "./bob-yaml.js";
import { capabilityConfigEnv, resolveCapabilities } from "./capability-loader.js";
import {
  CONTINUE_TURN,
  createCompactionObserver,
  evaluateCompletion,
  readWorktreeStatus,
  type SilenceReason,
} from "./compaction-contract.js";
import type { BobRole, CronEntry } from "./index.js";
import { loadRole } from "./role-loader.js";
import {
  createBobRuntimeFactory,
  promptSession,
  runInteractiveSession,
  type SessionDeps,
} from "./session.js";
import { resolveToolPolicy, type ToolPolicy } from "./tool-allowlist.js";

// Same regex as init.ts AGENT_NAME — names are filesystem paths, keep them
// strict-safe (no `..`, no `/`, no newlines).
const AGENT_NAME = /^[a-z0-9-]+$/;

// --- Run-log sizing + retention (see issue #146) --------------------------------
//
// The per-run log used to grow QUADRATICALLY with a long message: every
// `message_update` event carried `partial`, the whole assistant message so far,
// and it was appended once per streamed token. On a real builder that meant a
// 2.6 GB log for one 2h35m run and 15 GB in `runs/` on a 40 GB disk — the disk
// fills, the agent dies mid-task, and the logger swallows the disk-full error.
//
// DEFAULT_RUNLOG_DELTA_CAP_BYTES: the per-run DELTA cap. It caps the STREAMED
// DELTA events only — message_update, tool_execution_update,
// bash_execution_update and queue_update, the four events that repeat per stream
// chunk (`isDeltaEvent`). Once the log reaches this many bytes those deltas stop
// being written; every NON-delta event — tool calls and results, errors,
// lifecycle, the *_end finals, the done line — keeps coming, and exactly one line
// records that the DELTA cap was hit.
//
// The consequence, stated plainly (README + PR body say the same): past the cap
// the deltas are dropped; `message_end` still records each final message once, so
// content is recoverable there; a crash before a `message_end` loses that
// message's post-cap tail.
const DEFAULT_RUNLOG_DELTA_CAP_BYTES = 50 * 1024 * 1024; // 50 MB

// RUNLOG_KEEP / RUNLOG_BUDGET_BYTES: on run start, the newest RUNLOG_KEEP logs
// are always kept; older ones are deleted oldest-first once their combined size
// exceeds RUNLOG_BUDGET_BYTES. A log still being written is never touched
// (retention runs before the current run's file exists, and a live sibling's
// fresh mtime keeps it in the newest-K window). Retention FAILS SAFE: a log is
// pruned only when we can POSITIVELY show its run is finished — it has no lock at
// all, or its lock names a provably dead PID. A lock that exists but cannot be
// read, or whose content does not name a PID, is KEPT.
const RUNLOG_KEEP = 5;
const RUNLOG_BUDGET_BYTES = 500 * 1024 * 1024; // 500 MB for logs older than newest-K

// Retention result so a caller (or test) can assert what was pruned.
export interface RunLogRetentionResult {
  // Newest logs left untouched (capped at the number of logs present).
  kept: number;
  // Filenames of older logs deleted to honor the budget.
  removed: string[];
  // Combined bytes of the (now-pruned) non-newest logs after deletion.
  remainingBytes: number;
}

// True when `logPath` has a sidecar lock (`<logPath>.lock`) that shows the run is
// NOT finished, so retention must keep the log. Retention FAILS SAFE (issue #146,
// round 5): a log is pruned only when we can POSITIVELY show its run is finished.
//
//     no lock file          -> the run removed it at the end  -> finished, prunable
//     lock names a live PID -> the run is still writing       -> KEEP
//     lock unreadable       -> cannot show it is finished     -> KEEP (fail safe)
//     lock unparsable       -> cannot show it is finished     -> KEEP (fail safe)
//     lock names a dead PID -> ESRCH; the run is gone         -> prunable
//
// `process.kill(pid, 0)` probes liveness without signaling the target: it throws
// ESRCH for a dead PID and EPERM for a live PID we can't signal (different uid),
// so "no throw, or EPERM" means the run is live.
function logHasLiveLock(logPath: string): boolean {
  const lockPath = `${logPath}.lock`;
  // No lock at all: the run dropped its lock at run end, so it is finished and the
  // log is prunable. Distinguishing this from a PRESENT but unreadable lock is
  // exactly what lets the unreadable case fail safe below.
  if (!existsSync(lockPath)) return false;
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    // The lock exists but cannot be read (perms, or a directory named as the lock).
    // We cannot show the run is finished, so keep the log.
    return true;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    // The lock exists but does not name a PID. We cannot show the run is finished,
    // so keep the log.
    return true;
  }
  try {
    process.kill(pid, 0);
    return true; // live
  } catch (err) {
    // EPERM = a live PID we aren't allowed to signal (still alive) -> keep.
    // ESRCH = gone; a dead PID is a finished run -> the log is prunable.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// On run start: keep the newest `keep` logs untouched and, of the older ones,
// delete the oldest-first until their combined size is at or under
// `budgetBytes`. Never touches a run still in progress — its sidecar lock
// (`<log>.lock`, which names the run's PID) protects it; a lock whose PID is dead
// (a crashed or finished run) is treated as finished and pruned like any other
// (see logHasLiveLock).
export function pruneOldRunLogs(
  dir: string,
  opts: { keep?: number; budgetBytes?: number } = {},
): RunLogRetentionResult {
  const keep = opts.keep ?? RUNLOG_KEEP;
  const budgetBytes = opts.budgetBytes ?? RUNLOG_BUDGET_BYTES;
  if (!existsSync(dir)) return { kept: 0, removed: [], remainingBytes: 0 };
  // Newest-first by mtime so the most recent runs are protected first.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { name: f, mtimeMs: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const older = files.slice(keep);
  let remainingBytes = older.reduce((sum, f) => sum + f.size, 0);
  const removed: string[] = [];
  // `older` is newest→oldest, so iterate its tail (oldest) first.
  for (let i = older.length - 1; i >= 0; i--) {
    if (remainingBytes <= budgetBytes) break;
    const f = older[i];
    const logPath = join(dir, f.name);
    // A run still in progress drops a sidecar lock naming its PID; never unlink
    // such a log (its writer would keep writing to a now-deleted path). A dead-PID
    // (stale) lock, or no lock, marks a finished run — prunable.
    if (logHasLiveLock(logPath)) continue;
    try {
      unlinkSync(logPath);
      // A stale lock left by a crashed run goes with its log so we do not
      // accumulate orphan locks; best-effort — a missing lock is the common case.
      try {
        unlinkSync(`${logPath}.lock`);
      } catch {
        // best-effort
      }
      remainingBytes -= f.size;
      removed.push(f.name);
    } catch {
      // Best-effort: a file we can't delete (race, perms) leaves the budget
      // slightly over rather than throwing into run start.
    }
  }
  return { kept: Math.min(keep, files.length), removed, remainingBytes };
}

// --- Run-log projection (issue #146, round 5) -----------------------------------
//
// The log used to copy each session event WHOLE and strip the snapshot fields it
// already knew about. Each review round then found one more accumulated field it
// did not know about — message_update's growing `partial` and `message`, then
// tool_execution_update's cumulative `partialResult`, then queue_update's whole
// steering/follow-up queues — because a denylist can only ever be as complete as
// the last field someone remembered. The projection inverts that: a field
// WHITELIST mapping every event type in pi 0.84.3's event unions (pi-agent-core's
// AgentEvent and pi-coding-agent's AgentSessionEvent, enumerated from the
// installed `.d.ts`) to exactly the fields worth logging.
//
//     - streamed updates log their increment only: message_update the inner
//       event kind and its delta — never `partial` or `message`;
//       tool_execution_update no `partialResult` (the result is logged once, on
//       tool_execution_end); queue_update counts only; bash_execution_update its
//       per-chunk delta;
//     - `*_end` events log the final content exactly once;
//     - an event type the projection does not name logs `{ type, unknownEvent:
//       true }` and none of its payload.
//
// Because each record's shape depends only on the event's own named fields, a
// record never grows with the events before it, so the log stays linear in the
// number of events rather than in their accumulated payload.

// The event types the DELTA cap drops once it is hit (see
// DEFAULT_RUNLOG_DELTA_CAP_BYTES): the streamed updates that repeat per stream
// chunk — a growing message, a cumulative tool result, a streaming bash delta, a
// queue snapshot. Every other event is a NON-delta and is ALWAYS written, even
// past the cap, so the log stays a faithful post-mortem.
export function isDeltaEvent(type: unknown): boolean {
  return (
    type === "message_update" ||
    type === "tool_execution_update" ||
    type === "bash_execution_update" ||
    type === "queue_update"
  );
}

// A short random suffix so two runs that start in the same millisecond get
// distinct log filenames — and therefore distinct locks. 6 random bytes
// (crypto, 2^48) against a millisecond timestamp and a PID: not a secret, just
// enough entropy that a collision is not a thing that happens.
function randomLogSuffix(): string {
  return randomBytes(6).toString("hex");
}

// A session event as it reaches the log: pi's events, widened to a plain record.
type EventRecord = Record<string, unknown>;

// Copy the named fields, dropping the ones the event does not carry, so a record
// holds exactly what it logs (no `undefined` keys).
function projectFields(event: EventRecord, keys: readonly string[]): EventRecord {
  const out: EventRecord = { type: event.type };
  for (const k of keys) {
    if (event[k] !== undefined) out[k] = event[k];
  }
  return out;
}

// Map one session event to the fields the run log records. See the block comment
// above for the shape and why it is a whitelist.
export function projectRunLogRecord(event: EventRecord): EventRecord {
  const type = event.type;
  switch (type) {
    // Lifecycle: no payload of their own.
    case "agent_start":
    case "turn_start":
    case "agent_settled":
    case "summarization_retry_finished":
      return { type };

    // The message, logged once (message_start) or once final (message_end).
    case "message_start":
    case "message_end":
      return projectFields(event, ["message"]);

    // message_update: the inner stream event's KIND and its increment only. Never
    // `partial` (the whole message so far) or `message` (its growing shallow copy)
    // — that pair is what made the log quadratic. The delta reconstructs the
    // message and message_end carries the final one once.
    case "message_update": {
      const inner = (event.assistantMessageEvent ?? {}) as EventRecord;
      const out: EventRecord = { type };
      if (inner.type !== undefined) out.kind = inner.type;
      if (inner.delta !== undefined) out.delta = inner.delta;
      return out;
    }

    // tool_execution_start: the call and its args, logged once.
    case "tool_execution_start":
      return projectFields(event, ["toolCallId", "toolName", "args"]);
    // tool_execution_update: NO `partialResult` — it is the CUMULATIVE tool output
    // (a long `bash` run streams the whole output on every update); the result is
    // logged once, on tool_execution_end.
    case "tool_execution_update":
      return projectFields(event, ["toolCallId", "toolName"]);
    // tool_execution_end: the final result, logged once.
    case "tool_execution_end":
      return projectFields(event, ["toolCallId", "toolName", "result", "isError"]);

    // turn_end: the turn's final message and the tool results it produced, once.
    case "turn_end":
      return projectFields(event, ["message", "toolResults"]);

    // agent_end: each low-level run's OWN `messages`, logged UNCHANGED (issue
    // #139). They are that run's own newMessages, not the accumulated history, so
    // they are already bounded by the run — never slice them against a running
    // count (a shorter retry or failure run would silently lose messages).
    case "agent_end":
      return projectFields(event, ["messages", "willRetry"]);

    // queue_update: the COUNTS only — never the steering/follow-up text, which is
    // the whole pending queue repeated on every update.
    case "queue_update":
      return {
        type,
        steeringCount: Array.isArray(event.steering) ? event.steering.length : 0,
        followUpCount: Array.isArray(event.followUp) ? event.followUp.length : 0,
      };

    // bash_execution_update: the per-chunk output delta (already an increment).
    case "bash_execution_update":
      return projectFields(event, ["id", "delta"]);

    case "compaction_start":
      return projectFields(event, ["reason"]);
    case "compaction_end":
      return projectFields(event, ["reason", "result", "aborted", "willRetry", "errorMessage"]);

    case "auto_retry_start":
      return projectFields(event, ["attempt", "maxAttempts", "delayMs", "errorMessage"]);
    case "auto_retry_end":
      return projectFields(event, ["success", "attempt", "finalError"]);
    case "summarization_retry_scheduled":
      return projectFields(event, ["attempt", "maxAttempts", "delayMs", "errorMessage"]);
    case "summarization_retry_attempt_start":
      return projectFields(event, ["source", "reason"]);

    case "entry_appended":
      return projectFields(event, ["entry"]);
    case "session_info_changed":
      return projectFields(event, ["name"]);
    case "thinking_level_changed":
      return projectFields(event, ["level"]);

    default:
      // An event type the projection does not name: the type alone, none of its
      // payload. A future pi event is logged as unrecognised rather than copied
      // whole (which is how each previous round's accumulated field got in).
      return { type, unknownEvent: true };
  }
}

// A minimal view of what a `run` task needs from a pi AgentSession. Keeping
// our own slim type (rather than pi's full AgentSession) is what lets tests
// inject a fake session without standing up the whole SDK.
export interface RunSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  // Send a turn. `expandPromptTemplates: false` is how bob sends a prompt: the
  // text is the prompt, and nothing bob did not declare can interpret it (no
  // command, prompt-template or skill expansion). The persistent runtime also
  // uses `streamingBehavior` to steer a running turn.
  prompt(
    text: string,
    options?: { expandPromptTemplates?: boolean; streamingBehavior?: "steer" | "followUp" },
  ): Promise<void>;
  // Best-effort final assistant text, used as a fallback when no text_delta
  // events were observed (e.g. providers/transports that don't stream).
  readonly messages?: ReadonlyArray<unknown>;
  // Best-effort idle barrier — pi's AgentSession exposes `agent.waitForIdle()`;
  // the persistent runtime awaits it before disposing so a SIGTERM doesn't cut
  // off an in-flight turn. Optional so a fake session in tests need not provide
  // it. (pi's AgentSession doesn't expose this method directly, so the real
  // persistent factory wraps it — see persistent.ts.)
  waitForIdle?(): Promise<void>;
  dispose(): void;
}

// Inputs the session factory needs to stand up a pi session for an agent.
// Resolved from bob.yaml/soul.md + the per-call model override before the
// factory is called, so a fake factory in tests doesn't need filesystem access.
export interface RunSessionConfig {
  // pi provider id (already mapped from the bob provider, e.g.
  // exe-dev-gateway → anthropic).
  provider: string;
  // Model id to run. Per-call override wins over bob.yaml.
  model: string;
  // Appended system prompt (soul.md contents). Empty string when no soul.
  appendSystemPrompt: string;
  // The agent's working dir (~/agents/<name>/work) — pi's cwd.
  cwd: string;
  // The agent's pi config dir (~/agents/<name>/.pi-agent) — holds
  // auth.json/models.json. pi's ModelRuntime reads from here.
  piAgentDir: string;
  // pi extension sources for the agent's declared capabilities, in order.
  // Each is an npm:/git:/local-path spec handed to pi's resource loader as an
  // `additionalExtensionPaths` entry. Resolved from bob.yaml `capabilities:`
  // against the blessed catalog before the factory runs, so a fake factory in
  // tests doesn't need the catalog or filesystem. Empty when the agent
  // declares none. With round 3 this is the ONLY extension source that LOADS:
  // the ambient pi extension, skill and prompt-template paths are never LOADED,
  // and no package is installed.
  extensionSources: string[];
  // source → capability name, so a source pi fails to load can be reported as
  // the capability the agent asked for rather than a bare path. Optional: a
  // fake factory in tests need not supply it.
  capabilityBySource?: Record<string, string>;
  // Per-capability config the extensions read from the environment, keyed by
  // each capability's env var (BOB_CAP_<NAME>). The real factory sets these
  // before loading the extensions so each reads + re-validates its own config
  // block. JSON values carry config only — NEVER a secret (schemas forbid an
  // inlined token; the discord capability holds only a token file PATH).
  capabilityEnv: Record<string, string>;
  // True only for the PERSISTENT runtime (`bob serve`/runPersistent). Surfaced
  // to capabilities via BOB_PERSISTENT so "serving" capabilities (e.g. discord's
  // inbound gateway listener) only open their connection persistently — a
  // one-shot `bob run` stays minimal (outbound tools, no gateway). Defaults
  // falsy (ephemeral run).
  persistent?: boolean;
  // The tool policy resolved from bob.yaml's `tools:` block + top-level
  // `resident:` flag, with role.json as the ceiling (see tool-allowlist.ts).
  // `tools` is pi's STRICT allowlist and is REQUIRED: the type says so, and
  // createPiRunSession refuses a config without it at runtime. A session
  // without the resolved allowlist is the defect this whole area recovers
  // from, so "absent" is not a shape that can reach a session any more —
  // resolveAgentToolPolicy always produces it, and an empty array is the
  // explicit "no tools" decision. `excludeTools` is pi's denylist, applied
  // after `tools` (always an array at the factory; the resident policy rides
  // in it).
  tools: string[];
  excludeTools?: string[];
  // #145 — the CONTRACT carried in the system prompt. A one-shot `bob run`
  // carries its TASK (`taskContract`); the persistent runtime carries the
  // agent's STANDING CONTRACT (`standingContract`). They are mutually
  // exclusive, and the factory refuses a config with both. The contract is
  // appended to the system prompt as LITERAL TEXT through the loader's
  // `appendSystemPromptOverride`, so it is present on every model call and no
  // context compaction can remove it — which is why neither field is a message.
  // A blank value is refused (see assertContractText).
  taskContract?: string;
  standingContract?: string;
  // Cap on the appended contract block, in characters (default
  // DEFAULT_CONTRACT_CAP_CHARS). The block is cut with a visible truncation
  // marker; the heading is never the part that is cut.
  contractCapChars?: number;
}

// The injectable seam. Production builds a real pi AgentSession through bob's
// ONE session factory (session.ts); tests inject a fake that returns canned
// assistant text without any LLM call.
export type RunSessionFactory = (config: RunSessionConfig) => Promise<RunSession>;

export interface RunOptions {
  // Agent name. Config lives at ~/agents/<name>/.
  name: string;
  // Optional initial prompt. PR1 covers the non-interactive prompt path; an
  // interactive REPL on the SDK is a later PR. Without a prompt there's
  // nothing to send, so runAgent treats it as an error unless interactive.
  prompt?: string;
  // Optional per-call model override. Replaces bob.yaml's model for this
  // invocation only (same intent as the old `--model` flag).
  model?: string;
  // Reserved: interactive REPL mode on the SDK lands in a later PR. For now,
  // requesting it from the prompt path is rejected.
  interactive?: boolean;
  // If true, populate RunResult.stdout with the captured assistant final text.
  // The Discord listener depends on this (captureStdout → RunResult.stdout).
  // Defaults to false to preserve the prior contract for callers that only
  // care about exitCode.
  captureStdout?: boolean;
  // Override the agents root dir (tests). Defaults to ~/agents.
  agentsRoot?: string;
  // Inject the pi session factory (tests). Defaults to the real SDK factory.
  sessionFactory?: RunSessionFactory;
  // Per-run run-log DELTA cap in bytes (see DEFAULT_RUNLOG_DELTA_CAP_BYTES). It
  // caps the STREAMED DELTA events only (message_update, tool_execution_update,
  // bash_execution_update, queue_update). Past it those deltas stop being written;
  // every non-delta event (tool calls and results, errors, lifecycle, the *_end
  // finals, the done line) keeps coming. message_end still records each final
  // message, so content is recoverable there; a crash before a message_end loses
  // that message's post-cap tail. Tests set a small cap to exercise it without
  // writing gigabytes.
  runLogCapBytes?: number;
  // Injectable clock for the run-log filename and record timestamps (tests).
  // Defaults to a fresh Date() per call. Lets a test pin the start millisecond so
  // two runs started in the same millisecond still get distinct files and locks.
  now?: () => Date;
  // #145: the ONE completion contract this run is judged by. When the caller
  // (or bob.yaml) declares an expected final-assistant-message shape, a run only
  // settles exit 0 when the captured final text matches it. Omitted → the
  // contract is "the final message is non-empty".
  expectedFinal?: (text: string) => boolean;
  // #145: cap on the contract block appended to the system prompt. Defaults to
  // DEFAULT_CONTRACT_CAP_CHARS. A blank task is refused before the session
  // starts, whatever this is.
  contractCapChars?: number;
}

export interface RunResult {
  exitCode: number;
  // The agent's config dir (~/agents/<name>). Replaces the old launcherPath;
  // kept on the result so callers/tests can assert what was targeted.
  agentDir: string;
  // The resolved provider + model the session ran with (after applying any
  // per-call override). Useful for logging/diagnostics + assertions.
  provider: string;
  model: string;
  // Captured assistant final text, populated only when captureStdout=true.
  // Undefined otherwise.
  stdout?: string;
  // #145: the named reason a one-shot run refused to report success
  // (`settled_after_compaction` / `no_final_message` / `final_shape_mismatch`).
  // Undefined on exit 0.
  reason?: SilenceReason;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  if (!AGENT_NAME.test(opts.name)) {
    throw new Error(`invalid agent name: ${JSON.stringify(opts.name)} (must match ${AGENT_NAME})`);
  }
  if (opts.interactive) {
    // The SDK interactive REPL path is a later PR; the prompt path is PR1.
    throw new Error(
      "runAgent: interactive mode is not yet supported on the SDK path (PR1 is the non-interactive prompt path)",
    );
  }
  if (opts.prompt === undefined) {
    throw new Error(
      "runAgent: a prompt is required (the SDK prompt path sends one prompt and exits)",
    );
  }
  // #145: a BLANK task is refused here, BEFORE the session starts. The task is
  // carried in the session's system prompt for its whole life, so an empty one
  // would spend a whole run on nothing while looking like a real one.
  if (opts.prompt.trim().length === 0) {
    throw new Error(
      "runAgent: refusing to start a session with a blank task — the task is carried in the session's system prompt, and an empty one guarantees nothing",
    );
  }

  const root = opts.agentsRoot ?? join(homedir(), "agents");
  const { agentDir, provider, model, config } = resolveRunConfig({
    name: opts.name,
    agentsRoot: root,
    model: opts.model,
  });

  const factory = opts.sessionFactory ?? createPiRunSession;
  // #145: the task is the session's CONTRACT, carried in its system prompt
  // through the factory. (It is ALSO the first user message below, so a provider
  // that shows only messages still sees it; see the README's stated limits.)
  const session = await factory({
    ...config,
    taskContract: opts.prompt,
    ...(opts.contractCapChars !== undefined ? { contractCapChars: opts.contractCapChars } : {}),
  });

  // Tee every session event to a per-run JSONL log so a mid-run death (a provider
  // cap, an OOM, a crash) is post-mortem-able instead of leaving no trace. Logging
  // is strictly best-effort: NOTHING about it — including creating the runs
  // directory — may throw into the run. If the log cannot even be set up we warn
  // ONCE and continue with a no-op logger, so the run still completes and the
  // failure is a stderr line rather than a crash (issue #146, round 5).
  const now = opts.now ?? (() => new Date());
  const runsDir = join(agentDir, "runs");

  // writeRunLog stays a no-op until setup finishes, and runLogLockPath stays ""
  // unless a lock was actually dropped. A failure anywhere in the setup below (an
  // unwritable runs dir, a file where the dir belongs) leaves the run running
  // without its log.
  let writeRunLog: (record: unknown, isDelta: boolean) => void = () => {};
  let runLogLockPath = "";

  try {
    // (1) Create the runs directory. This is the setup step that can throw into the
    // run; the outer catch turns a failure into one warning line + the no-op logger.
    mkdirSync(runsDir, { recursive: true });

    // (2) Retention first (best-effort): keep the newest few logs and delete older
    // ones oldest-first past a total budget, so a full disk can't silently kill a
    // long run. Runs BEFORE this run's file exists, so it never touches a run still
    // being written.
    try {
      pruneOldRunLogs(runsDir, {});
    } catch {
      // Retention is best-effort; never let it abort the run.
    }

    // (3) ONE log per run, even when two runs start in the same millisecond: the
    // name carries the start timestamp, the run's PID and a random suffix, so
    // distinct runs get distinct files — and therefore distinct locks. Created
    // EXCLUSIVELY (`wx`), so an existing path is never clobbered.
    const runLogName = `${now().toISOString().replace(/[:.]/g, "-")}.${process.pid}.${randomLogSuffix()}.jsonl`;
    const runLogPath = join(runsDir, runLogName);
    closeSync(openSync(runLogPath, "wx"));
    process.stderr.write(`run log: ${runLogPath}\n`);

    // (4) Sidecar lock: while this run writes its log it holds `<log>.lock` naming
    // its PID; retention reads it to leave a live run's log alone. The lock belongs
    // to this log file alone (the name above is unique), and is created exclusively
    // too. Removed at run end.
    runLogLockPath = `${runLogPath}.lock`;
    try {
      writeFileSync(runLogLockPath, String(process.pid), { flag: "wx" });
    } catch {
      // Best-effort: without a lock, retention can't show this run is live and may
      // prune the log — the pre-existing caveat, unchanged.
    }

    // (5) The DELTA cap: the per-run limit on the STREAMED DELTA events
    // (isDeltaEvent). Past it those deltas are dropped; every NON-delta event — tool
    // calls and results, errors, lifecycle, the *_end finals, the done line — keeps
    // coming, and exactly one line records that the DELTA cap was hit.
    const capBytes = opts.runLogCapBytes ?? DEFAULT_RUNLOG_DELTA_CAP_BYTES;
    let logBytes = 0; // running total of bytes committed to this log
    let deltaCapHit = false; // set once the marker below is on disk; then deltas stop

    // Synchronous writer: appendFileSync commits each record to disk before it
    // returns — exactly the post-mortem property this log exists for (a hard crash
    // leaves every record written before it on disk). Each record is projected to a
    // bounded shape (`projectRunLogRecord`), so there is no per-write cost worth
    // buffering and no accumulated payload in it. A failed append (disk full, race,
    // perms) is swallowed: logging is best-effort and never throws into the run.
    writeRunLog = (record: unknown, isDelta: boolean): void => {
      try {
        // Past the delta cap the STREAMED DELTAS are dropped; every non-delta event
        // keeps coming, so the log stays a faithful post-mortem.
        if (isDelta && deltaCapHit) return;
        const line = `${JSON.stringify(record)}\n`;
        const n = Buffer.byteLength(line);
        appendFileSync(runLogPath, line);
        logBytes += n;
        if (!deltaCapHit && logBytes >= capBytes) {
          // One line, ever, recording that the delta cap was hit — written BEFORE
          // the flag is set, so the flag never claims "delta cap hit" without the
          // marker already on disk. If that append throws, the flag stays clear and
          // the catch below swallows it.
          const capLine = `${JSON.stringify({
            t: now().toISOString(),
            cap: true,
            kind: "delta",
            bytes: logBytes,
            capBytes,
          })}\n`;
          appendFileSync(runLogPath, capLine);
          logBytes += Buffer.byteLength(capLine);
          deltaCapHit = true;
        }
      } catch {
        // Best-effort: never throw from the logger (disk full, races, etc.).
      }
    };
  } catch {
    // Setting up the log failed — including creating the runs directory. Warn once
    // and continue with the no-op logger: logging never throws into the run.
    process.stderr.write(
      `bob run ${opts.name}: run log unavailable (could not create ${runsDir}); continuing without a run log\n`,
    );
  }

  const unsubscribeRunLog = session.subscribe((event) => {
    // Post-mortem trail: record EVERY event (tool calls, results, errors,
    // retries), not just text — that's what makes a death diagnosable. The
    // FINAL-MESSAGE capture is NOT here: it lives on the compaction observer
    // below, which knows the compaction boundary, and the record is the
    // projected, bounded shape (projectRunLogRecord), not the raw event.
    writeRunLog(
      {
        t: now().toISOString(),
        event: projectRunLogRecord(event as unknown as Record<string, unknown>),
      },
      isDeltaEvent(event.type),
    );
  });

  let exitCode = 0;
  let reason: SilenceReason | undefined;

  // #145: after every non-aborted compaction the observer sends ONE best-effort
  // "what remains" note (a steer: the last thing the agent said, git status,
  // recent tool calls).
  // It is never load-bearing — the task is in the system prompt — so a failed
  // note is logged and nothing else happens. The observer also owns the
  // final-message boundary the judge reads.
  const observer = createCompactionObserver({
    worktreeStatus: () => readWorktreeStatus(config.cwd),
    inject: (text) => session.prompt(text, { streamingBehavior: "steer" }),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const unsubscribeContract = session.subscribe((event) => observer.observe(event));

  // The FINAL message is the text of the LAST assistant message that ENDED since
  // the last compaction (or the last startTurn): text streamed before a
  // compaction can never satisfy the completion contract, streamed deltas are
  // never substituted for the ended message's own content, and the observer
  // clears its capture on `compaction_end` and at every `startTurn()`.
  const finalTextNow = (): string => {
    const tracked = observer.finalText();
    if (tracked.length > 0) return tracked;
    // NOTHING ended with text since the boundary. Only a transport that ended no
    // assistant message at all may fall back to session state — and NEVER after
    // a compaction, whose boundary the session's message list cannot express.
    if (observer.compactions() > 0 || observer.assistantEnded()) return "";
    return lastAssistantText(session) ?? "";
  };

  // ONE judge: the first evaluation and the one after the continue turn are the
  // same call, so the run cannot be judged by two different rules.
  const judge = (): { ok: boolean; reason?: SilenceReason } =>
    evaluateCompletion({
      capturedText: finalTextNow(),
      compactions: observer.compactions(),
      expectedFinal: opts.expectedFinal,
    });

  try {
    observer.startTurn();
    // bob's own runner: the text IS the prompt (no command/template/skill
    // expansion — see session.ts promptSession).
    await promptSession(session, opts.prompt);

    // #145: the completion contract. Before this, a run settled `exitCode 0`
    // whenever the prompt promise resolved — including after a compaction that
    // erased the plan. Now it settles 0 ONLY with a final message (matching an
    // expected shape when one is declared).
    let outcome = judge();
    if (!outcome.ok && outcome.reason === "settled_after_compaction") {
      // Settled after a compaction with no final message: retry ONCE with an
      // explicit "continue from the state above" turn. This retry is meaningful
      // because the task is still in the system prompt.
      process.stderr.write(
        `bob run ${opts.name}: settled after a context compaction with no final message — retrying once with a continue turn\n`,
      );
      try {
        observer.startTurn(); // the retry is its own turn: its final message counts
        // Through the one non-interactive prompt entry point, so template and
        // command expansion stay off by construction (not because of the text).
        await promptSession(session, CONTINUE_TURN);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        process.stderr.write(`bob run ${opts.name}: the continue turn failed — ${m}\n`);
      }
      outcome = judge();
    }
    if (!outcome.ok) {
      // NEVER exit 0 for silence. Name the reason and print what we can (the
      // dirty paths, if the agent's cwd is a git worktree).
      exitCode = 1;
      reason = outcome.reason;
      process.stderr.write(
        `bob run ${opts.name}: REFUSING to report success — ${reason}` +
          (reason === "settled_after_compaction"
            ? " (the session settled after a context compaction without a final message)"
            : reason === "final_shape_mismatch"
              ? " (the final message did not match the declared shape)"
              : " (the session settled without a final message)") +
          "\n",
      );
      const status = readWorktreeStatus(config.cwd);
      if (status.length > 0) {
        process.stderr.write(`bob run ${opts.name}: uncommitted paths in ${config.cwd}:\n`);
        for (const line of status.split("\n")) process.stderr.write(`  ${line}\n`);
      } else {
        process.stderr.write(
          `bob run ${opts.name}: no dirty paths in ${config.cwd} (nothing to commit there)\n`,
        );
      }
    }
  } catch (err) {
    exitCode = 1;
    // Surface the error instead of swallowing it: an underscore-ignored catch
    // made a cap-hit look like a silent clean exit. Label a provider
    // rate-limit/cap so a budget stall is distinguishable from a crash.
    const msg = err instanceof Error ? err.message : String(err);
    const isCap =
      /rate.?limit|quota|\b429\b|too many requests|usage limit|capacity|overloaded/i.test(msg);
    process.stderr.write(
      `bob run ${opts.name}: ${isCap ? "PROVIDER RATE-LIMIT/CAP" : "run failed"} — ${msg}\n`,
    );
  } finally {
    // Stop recording first: the done line below is this log's last record, and the
    // run is over whatever the turn did.
    unsubscribeRunLog();
    unsubscribeContract();

    // Final record, so a reader can tell a clean completion from a truncated log.
    // A synchronous append is on disk when writeRunLog returns, so a mid-run crash
    // leaves every record written before it — the post-mortem trail this log exists
    // for.
    writeRunLog({ done: true, exitCode }, false);

    // Run end: drop the sidecar lock so retention no longer sees this log as
    // live. Best-effort — a leaked lock names a now-dead PID, which the next
    // sweep treats as finished.
    try {
      if (runLogLockPath !== "") unlinkSync(runLogLockPath);
    } catch {
      // best-effort: the lock may already be gone
    }
  }

  // The run's final text — exactly the content of the last assistant message
  // that ended since the last compaction (or the session-state fallback for a
  // transport that ended no message at all).
  const finalStdout = finalTextNow();

  session.dispose();

  return {
    exitCode,
    agentDir,
    provider,
    model,
    ...(opts.captureStdout ? { stdout: finalStdout } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

// Resolve everything a pi session needs for an agent from disk: provider/model
// (bob.yaml + per-call override), soul.md (appended system prompt), cwd +
// .pi-agent dir, and the resolved+validated capabilities (extension sources +
// config env). Shared by `bob run` (ephemeral) and the persistent runtime
// (persistent.ts) so both stand up the IDENTICAL session — only the
// SessionManager lifespan differs. Throws with an onboard hint when the agent
// dir / bob.yaml is missing, and fails fast on a bad capability.
export interface ResolveRunConfigOptions {
  name: string;
  // Agents root dir (~/agents). The agent lives at <agentsRoot>/<name>.
  agentsRoot: string;
  // Optional per-invocation model override (wins over bob.yaml).
  model?: string;
  // True when the caller is the PERSISTENT runtime, which is resident by
  // definition: an agent kept up by its service unit runs unattended, so the
  // resident tool policy (no shell, no file-writing tools, unless the role opts
  // in) applies even when bob.yaml does not say `resident: true`. The one-shot
  // `bob run` path leaves this falsy.
  persistent?: boolean;
}

export interface ResolvedRunConfig {
  agentDir: string;
  provider: string;
  model: string;
  config: RunSessionConfig;
  // bob.yaml `cron:` entries (validated). Only the PERSISTENT runtime uses
  // these (it schedules them into the live session); `bob run` ignores them.
  cron: CronEntry[];
  // bob.yaml `agent:` block (id/name/role). The persistent runtime's standing
  // contract — the text carried in its system prompt — is built from it.
  agent: { id?: string; name?: string; role?: string };
  // The resolved tool policy (role ceiling + bob.yaml narrowing + the resident
  // decision), so a caller that only has the result can still hand the SAME
  // policy to a session it starts itself (`bob launch` does exactly that).
  policy: ToolPolicy;
}

// The tool policy for an agent's bob.yaml. ONE entry point for every launch
// path, so `bob run`/the persistent runtime (via resolveRunConfig) and the pi
// CLI paths (onboard, align, `bob launch`) cannot drift:
//
//   * role.json is the CEILING — it ships with bob, while bob.yaml is
//     agent-writable, so bob.yaml may narrow the role's list but never widen it;
//   * a missing `tools.allow` is a load error, not "pi's defaults";
//   * every name must be one pi (or a loaded capability) can enable.
//
// Throws rather than returning a default, because a session without the
// resolved policy is the defect this whole area is recovering from.
export function resolveAgentToolPolicy(
  yamlText: string,
  opts?: { persistent?: boolean },
): ToolPolicy {
  const roleName = readAgentRole(yamlText);
  // loadRole validates the name (path traversal) and throws a named error when
  // bob does not ship the role. The ceiling has to be readable: an agent whose
  // role.json cannot be found cannot start a session.
  const role = loadRole(roleName as BobRole);
  return resolveToolPolicy({
    yamlText,
    tools: readTools(yamlText),
    role: {
      name: roleName,
      allow: role.tools.allow,
      allowResidentShell: role.tools.allowResidentShell,
    },
    resident: readResident(yamlText),
    persistent: opts?.persistent,
  });
}

// The policy for an on-disk agent, for the launch paths that only have an
// agent dir (onboard, align, `bob launch`). Same reader as resolveRunConfig, so
// a CLI session and an embedded session get the same policy — and fail closed
// the same way when bob.yaml is missing, roleless, or has no allowlist.
export function readAgentToolPolicy(agentDir: string): ToolPolicy {
  const yamlPath = join(agentDir, "bob.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error(
      `config not found at ${yamlPath} (run 'bob onboard <name>' first, or point --agent-dir at the agent)`,
    );
  }
  return resolveAgentToolPolicy(readFileSync(yamlPath, "utf8"));
}

export interface LaunchOptions {
  name: string;
  // The launcher's one optional prompt. `bob launch` accepts at most one
  // prompt and nothing else (see parseLaunchArgs); a pi flag never reaches a
  // session because there is no argv to put it in.
  prompt?: string;
  // Agents root dir. Defaults to ~/agents. Tests override.
  agentsRoot?: string;
  // Per-invocation model override (same semantics as `bob run --model`).
  model?: string;
  // Test seam for the one-shot path (defaults to the real SDK factory).
  sessionFactory?: RunSessionFactory;
  // Test seam for the interactive path (defaults to pi's InteractiveMode in a
  // real terminal).
  interactive?: (input: {
    config: RunSessionConfig;
    policy: ToolPolicy;
    deps?: SessionDeps;
  }) => Promise<number>;
  deps?: SessionDeps;
}

// A refused `bob launch` argument. Thrown by parseLaunchArgs; the CLI turns it
// into exit code 2 with the message on stderr.
export class LaunchArgError extends Error {}

// `bob launch` takes a name and AT MOST ONE PROMPT — nothing else.
//
// The launcher is the mail path and the human path: whatever reaches a session
// comes from here. A caller-supplied argument is refused BY NAME (rather than
// dropped or forwarded): the session's tools are the role's allowlist resolved
// by bob, and there is no argument path into a session at all.
//
// `-- <prompt>` is how a prompt that starts with `-` gets through:
//   bob launch pulse -- --tools   → the literal prompt "--tools"
//   bob launch pulse --tools      → refused (no `--`, so it is a flag)
//
// An empty prompt is "no prompt": the launcher with no arguments opens the
// interactive TUI.
export function parseLaunchArgs(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): LaunchOptions {
  const flagNames = Object.keys(flags);
  if (flagNames.length > 0) {
    throw new LaunchArgError(
      `bob launch: refusing argument "--${flagNames[0]}" — bob launch takes at most one prompt and nothing else. The session's tools come from the role's allowlist (roles/<role>/role.json narrowed by bob.yaml), never from a flag. To send a prompt that starts with "-", pass it after --: bob launch <name> -- --${flagNames[0]}`,
    );
  }
  const [name, ...rest] = positional;
  if (name === undefined) {
    throw new LaunchArgError("bob launch: missing <name>");
  }
  if (rest.length > 1) {
    throw new LaunchArgError(
      `bob launch: refusing argument "${rest[1]}" — bob launch takes at most one prompt and nothing else. Quote a multi-word prompt: bob launch <name> -- "the whole prompt".`,
    );
  }
  const prompt = rest[0];
  if (prompt !== undefined && prompt.trim() === "") {
    return { name };
  }
  return prompt === undefined ? { name } : { name, prompt };
}

// `bob launch <name> [prompt]` — the agent's session, started with the resolved
// tool policy. This is what the generated `bin/<name>` launcher runs, and
// therefore what the mail consumer reaches when it invokes that launcher.
//
// Two shapes, one policy:
//   * a prompt → bob's OWN runner (runAgent) sends it through the factory's
//     session, keeping the capture + run-log behaviour `bob run` has;
//   * no prompt → pi's InteractiveMode, given an AgentSessionRuntime whose
//     factory is bob's (session.ts), so a new/resumed/forked session is still
//     the agent's own with the agent's policy.
//
// It never spawns the pi CLI and never assembles a command line: a session's
// tools come from the factory's policy, never from an argument.
export async function runLaunch(opts: LaunchOptions): Promise<number> {
  if (opts.prompt !== undefined && opts.prompt.trim() !== "") {
    const result = await runAgent({
      name: opts.name,
      prompt: opts.prompt,
      model: opts.model,
      agentsRoot: opts.agentsRoot,
      captureStdout: true,
      sessionFactory: opts.sessionFactory,
    });
    if (result.stdout && result.stdout.trim().length > 0) {
      process.stdout.write(`${result.stdout}\n`);
    }
    return result.exitCode;
  }

  const { config, policy } = resolveRunConfig({
    name: opts.name,
    agentsRoot: opts.agentsRoot ?? join(homedir(), "agents"),
    model: opts.model,
  });
  const interactive = opts.interactive ?? ((i) => runInteractiveSession({ ...i, deps: opts.deps }));
  return interactive({ config, policy, deps: opts.deps });
}

// Parse + validate bob.yaml `cron:` into CronEntry[]. Drops any entry missing
// name/schedule/prompt — a single malformed entry shouldn't stop the agent from
// starting (the scheduler additionally skips an unparseable schedule).
function parseCron(yamlText: string): CronEntry[] {
  return readCron(yamlText)
    .filter(
      (e) =>
        typeof e.name === "string" &&
        e.name.length > 0 &&
        typeof e.schedule === "string" &&
        e.schedule.length > 0 &&
        typeof e.prompt === "string" &&
        e.prompt.length > 0,
    )
    .map((e) => ({ name: e.name, schedule: e.schedule, prompt: e.prompt }));
}

export function resolveRunConfig(opts: ResolveRunConfigOptions): ResolvedRunConfig {
  if (!AGENT_NAME.test(opts.name)) {
    throw new Error(`invalid agent name: ${JSON.stringify(opts.name)} (must match ${AGENT_NAME})`);
  }
  const agentDir = join(opts.agentsRoot, opts.name);
  if (!existsSync(agentDir)) {
    throw new Error(
      `bob: agent dir not found at ${agentDir} (run 'bob onboard ${opts.name}' first)`,
    );
  }

  const yamlText = readBobYaml(agentDir, opts.name);
  const { provider, model: yamlModel } = resolveProviderAndModel(yamlText, opts.name);
  // Per-call override wins, mirroring the old `--model` flag semantics.
  const model = opts.model ?? yamlModel;
  const appendSystemPrompt = readSoul(agentDir);

  // Resolve the agent's declared capabilities (bob.yaml `capabilities:`) against
  // the blessed catalog, validating each config block. Throws fast on an
  // unknown / unbuilt / misconfigured capability — better than running an
  // under-equipped agent. Produces the pi extension sources the session loads
  // plus the per-capability config env each extension reads (no secrets).
  const resolution = resolveCapabilities({ yamlText });

  // Resolve the role's tool allowlist: role.json is the ceiling and bob.yaml
  // may only narrow it; a missing allowlist is a load error; every name must be
  // one pi or a loaded capability can enable (pi drops an unknown name
  // SILENTLY, so a stale name would otherwise look like a working allowlist
  // while the tool is simply absent). Throws naming the offender and the fix.
  const toolPolicy = resolveAgentToolPolicy(yamlText, { persistent: opts.persistent });

  // The agent block (id/name/role). Read through readBlock, but a malformed
  // `agent:` block must not stop the agent from running: it is only used to
  // render the persistent runtime's standing contract, which falls back to the
  // agent's directory name.
  let agentBlock: Record<string, unknown> | undefined;
  try {
    agentBlock = readBlock(yamlText, "agent");
  } catch {
    agentBlock = undefined;
  }
  const agent = {
    ...(typeof agentBlock?.id === "string" ? { id: agentBlock.id } : {}),
    ...(typeof agentBlock?.name === "string" ? { name: agentBlock.name } : {}),
    ...(typeof agentBlock?.role === "string" ? { role: agentBlock.role } : {}),
  };

  const config: RunSessionConfig = {
    provider,
    model,
    appendSystemPrompt,
    cwd: join(agentDir, "work"),
    piAgentDir: join(agentDir, ".pi-agent"),
    extensionSources: resolution.extensionSources,
    capabilityBySource: Object.fromEntries(
      resolution.capabilities.map((c) => [c.piPackage, c.name]),
    ),
    capabilityEnv: capabilityConfigEnv(resolution),
    // Always both: resolveAgentToolPolicy refuses an agent without an
    // allowlist, so there is no longer a "declared none" case here.
    tools: toolPolicy.tools,
    excludeTools: toolPolicy.excludeTools,
  };
  return {
    agentDir,
    provider,
    model,
    config,
    cron: parseCron(yamlText),
    agent,
    policy: toolPolicy,
  };
}

// The capability-load and active-tool checks live in session.ts, next to the
// factory that runs them. Re-exported here because they are part of this
// module's public surface (tests and doctor use them).
export {
  type ActiveToolSource,
  assertAllowedToolsActive,
  assertCapabilitiesLoaded,
  type ExtensionErrorSource,
} from "./session.js";

// The ONE session builder. Every path routes through it: `bob run` (ephemeral,
// in-memory SessionManager), the persistent runtime (durable SessionManager),
// `bob launch` with a prompt, the mail consumer, onboarding and alignment (the
// interactive shape goes through session.ts's runInteractiveSession, which
// builds its runtime from the same factory).
//
// It is a thin wrapper over createBobRuntimeFactory (session.ts), which owns
// the isolated settings/resource sources, the effective policy, and the audit —
// so there is exactly one place where a session's tools are decided.
//
// `sessionManagerFactory` lets a caller supply the SessionManager — the
// ephemeral `run` path defaults to in-memory (nothing to persist); the
// persistent runtime passes `SessionManager.create(cwd)` so the warm session is
// durable on disk (the working window; Flair remains the long-term store).
export async function createPiRunSession(
  config: RunSessionConfig,
  sessionManagerFactory?: (cwd: string) => SessionManagerLike,
): Promise<RunSession> {
  assertToolPolicy(config);
  const policy: ToolPolicy = {
    tools: config.tools,
    // resolveToolPolicy already folded the resident exclusions into
    // excludeTools, so the factory's job is simply to hand pi the resolved pair.
    excludeTools: config.excludeTools ?? [],
    resident: config.persistent === true,
    allowResidentShell: false,
  };
  const makeSessionManager =
    sessionManagerFactory ?? ((cwd: string) => SessionManager.inMemory(cwd));
  const factory = createBobRuntimeFactory({ config, policy });
  const { session } = await factory({
    cwd: config.cwd,
    agentDir: config.piAgentDir,
    sessionManager: makeSessionManager(config.cwd),
  });
  return session as unknown as RunSession;
}

// A session config MUST carry the resolved policy — the type says so, and this
// says so at runtime for a caller that got here through `any`. pi's defaults
// (read, bash, edit, write) are not a policy, they are the absence of one, and
// that absence is the defect this area recovers from.
function assertToolPolicy(config: RunSessionConfig): void {
  if (!Array.isArray(config.tools)) {
    throw new Error(
      "bob: refusing to create a session without a resolved tool policy — RunSessionConfig.tools is required (it is pi's strict allowlist; an empty array means no tools). Resolve it with resolveAgentToolPolicy/readAgentToolPolicy.",
    );
  }
}

// Minimal structural alias for pi's SessionManager (in-memory or durable). The
// persistent runtime passes a durable one; we only need it to satisfy
// createAgentSession's `sessionManager` slot, so a structural alias avoids
// importing pi's full type here.
export type SessionManagerLike = ReturnType<typeof SessionManager.inMemory>;

// Pull the text of the last assistant message from session state, as a
// fallback for transports that don't emit text_delta events. Defensive about
// the message shape (we only typed `messages` as unknown[] on RunSession).
function lastAssistantText(session: RunSession): string | undefined {
  const messages = session.messages;
  if (!messages || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!msg || msg.role !== "assistant") continue;
    return assistantContentToText(msg.content);
  }
  return undefined;
}

function assistantContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const b = block as { type?: string; text?: string };
        return b && b.type === "text" && typeof b.text === "string" ? b.text : "";
      })
      .join("");
  }
  return "";
}

// Read ~/agents/<name>/bob.yaml, erroring with an onboard hint when absent.
// Returned text is parsed by the targeted readers below + the capability
// loader — all hand-rolled to avoid a YAML dependency the monorepo has
// deliberately deferred (see the note in init.ts renderBobYaml).
function readBobYaml(agentDir: string, name: string): string {
  const yamlPath = join(agentDir, "bob.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error(
      `bob run ${name}: config not found at ${yamlPath} (run 'bob onboard ${name}' first)`,
    );
  }
  return readFileSync(yamlPath, "utf8");
}

// Resolve provider + model from bob.yaml text. We parse only the `provider:`
// block (name + model) — the exact shape init.ts emits. The bob provider is
// mapped to pi's provider id the same way init.ts's resolvePiProvider does.
function resolveProviderAndModel(
  yamlText: string,
  name: string,
): { provider: string; model: string } {
  const bobProvider = readProviderField(yamlText, "name");
  const model = readProviderField(yamlText, "model");
  if (!bobProvider || !model) {
    throw new Error(`bob run ${name}: bob.yaml is missing provider.name and/or provider.model`);
  }
  return { provider: mapBobProviderToPi(bobProvider), model };
}

// Read a scalar `key: value` field from inside the top-level `provider:` block.
// Targeted to init.ts's flat output (2-space indented keys under `provider:`);
// not a general YAML parser.
function readProviderField(yamlText: string, key: string): string | undefined {
  const lines = yamlText.split(/\r?\n/);
  let inProvider = false;
  for (const line of lines) {
    // A new top-level (column-0, non-comment) key ends the provider block.
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
      inProvider = /^provider\s*:/.test(line);
      continue;
    }
    if (!inProvider) continue;
    // Trim first, then match without leading/trailing `\s*` — avoids a
    // polynomial regex (CodeQL js/polynomial-redos). Value is trimmed below.
    const t = line.trim();
    const m = t.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (m && m[1] === key) {
      // Strip surrounding whitespace + quotes if present.
      return m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

// Map a bob provider name to pi's provider id: `exe-dev-gateway` is bob's term
// for "anthropic API shape via the exe.dev gateway"; pi only knows `anthropic`
// (the gateway baseUrl override lives in .pi-agent/models.json). Exported so
// onboarding/alignment map a caller's provider override the same way.
export function mapBobProviderToPi(bobProvider: string): string {
  if (bobProvider === "exe-dev-gateway") return "anthropic";
  return bobProvider;
}

// Read soul.md (the appended persona). Returns "" when absent so the session
// falls back to pi's default system prompt.
function readSoul(agentDir: string): string {
  const soulPath = join(agentDir, "soul.md");
  if (!existsSync(soulPath)) return "";
  return readFileSync(soulPath, "utf8");
}
