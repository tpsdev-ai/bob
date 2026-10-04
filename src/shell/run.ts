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
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildMailTurnPrompt,
  formatMailTurnResult,
  MAIL_TURN_INPUT_MAX_BYTES,
  parseMailTurnInput,
} from "../capabilities/tps-mail/prompt.js";
import type { TaskBinding } from "../capabilities/work/task-binding.js";
import {
  type ProviderLimitsBlock,
  parseBobYamlBlock,
  readAgentRole,
  readBlock,
  readCapabilities,
  readCron,
  readExplorationBudget,
  readProviderLimits,
  readResident,
  readRunLimits,
  readSessionBudget,
  readToolLoopLimit,
  readTools,
} from "./bob-yaml.js";
import {
  capabilityConfigEnv,
  type ResolvedCapability,
  resolveCapabilities,
} from "./capability-loader.js";
import {
  CONTINUE_TURN,
  createCompactionObserver,
  DEFAULT_MAX_REASONING_REPROMPTS,
  evaluateCompletion,
  readWorktreeStatus,
  readWorktreeStatusResult,
  type SilenceReason,
} from "./compaction-contract.js";
import { collectCredentialPaths } from "./confined-read.js";
import { gatedNoteInjection } from "./data-class.js";
import { captureRepositoryState, isVerifiedEdit, type RepositoryState } from "./edit-evidence.js";
import {
  EXPLORATION_INSTRUCTION,
  ExplorationBudgetDetector,
  ExplorationBudgetExhaustedError,
  explorationExhaustedMessage,
  explorationInstructionMessage,
} from "./exploration-budget.js";
import {
  type FlairBootstrapTarget,
  loadFlairBootstrapContext,
  flairBootstrapTarget as resolveFlairBootstrapTarget,
} from "./flair-bootstrap.js";
import type { BobRole, CronEntry } from "./index.js";
import { resolveAdoptedConfig } from "./position-runtime.js";
import {
  DEFAULT_PROVIDER_REGISTRY,
  type ProviderRecord,
  type ProviderRegistry,
  providerRecord,
  resolveRuntimeProviderName,
} from "./provider-registry.js";
import { repromptWhileReasoningOnly } from "./reasoning-retry.js";
import { createRequestUsageTracker } from "./request-usage.js";
import { loadRole } from "./role-loader.js";
import {
  boundMessage,
  createRunBounds,
  RunAbortedError,
  type RunBounds,
  type RunLimitsBlock,
  type RunTimer,
  raceTimeout,
  resolveRunLimits,
  type TerminationReason,
  TIMED_OUT,
} from "./run-bounds.js";
import {
  createBobRuntimeFactory,
  promptSession,
  providerKeyConsumedMessage,
  providerKeyWasConsumed,
  runInteractiveSession,
  type SessionDeps,
} from "./session.js";
import type { ModelLimits, ThinkingSetting } from "./session-budget.js";
import { applyMailTurnPolicy, resolveToolPolicy, type ToolPolicy } from "./tool-allowlist.js";
import {
  DEFAULT_TOOL_LOOP_LIMIT,
  LOOP_ABORT_GRACE_MS,
  loopBreakMessage,
  ToolLoopDetector,
  ToolLoopError,
} from "./tool-loop.js";
import type { TurnAdmission } from "./turn-admission.js";
import { originValidationError } from "./turn-origin.js";

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
//
// What this does NOT bound, just as plainly: the NON-delta records. They keep
// coming past the cap without limit, and retention's budget is a sweep at run
// start, not a per-run limit — so a run that emits hundreds of thousands of tool
// events writes every one of them, and one run can exceed the budget before the
// next run's sweep sees it. The cap bounds the deltas; the budget bounds what a
// series of runs leaves behind.
const DEFAULT_RUNLOG_DELTA_CAP_BYTES = 50 * 1024 * 1024; // 50 MB

// RUNLOG_KEEP / RUNLOG_BUDGET_BYTES: on run start, the newest RUNLOG_KEEP logs
// are always kept; older ones are deleted oldest-first once their combined size
// exceeds RUNLOG_BUDGET_BYTES. A log still being written is never touched
// (retention runs before the current run's file exists, and a live sibling's
// fresh mtime keeps it in the newest-K window). Retention FAILS SAFE: a log is
// pruned only when we can POSITIVELY show its run is finished — it has no lock at
// all, or its lock names a provably dead PID. A lock that exists but cannot be
// read, or whose content is not EXACTLY a PID (the whole content as digits), is
// KEPT.
//
// The one state that would defeat that rule — an ACTIVE run whose log has no lock
// at all — is not reachable: a run takes its lock BEFORE it creates its log file,
// and a run that cannot take its lock writes no log (see runAgent's setup).
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
// "Unparsable" means the whole content is not a PID — not merely that it starts
// with something that is not one. `parseInt` reads the longest digit PREFIX, so
// it turns "123garbage" into 123 and the lock's fate would turn on a number it
// never named; the check below is digits-only, all of it.
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
  // The lock must name a PID and nothing else: the WHOLE trimmed content is
  // digits. `Number.parseInt("123garbage", 10)` is 123, so a prefix test would
  // read a lock whose content is not a PID as the PID 123 — and then decide the
  // log's fate on it (prunable if that PID happens to be dead). Not a PID means
  // unparsable, and unparsable KEEPS the log.
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) {
    // The lock exists but does not name a PID. We cannot show the run is finished,
    // so keep the log.
    return true;
  }
  const pid = Number(text);
  // A digits-only string can still fail to be a PID: the empty string is refused
  // above, a very long one overflows to Infinity, and 0 is not a PID. All three
  // are unparsable, so they keep the log too.
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
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
//     - streamed updates log their increment only: message_update the inner event
//       kind, its content block index and its delta — never `partial` or
//       `message`, and never the whole event. The other three name their bound
//       exactly: tool_execution_update the call's IDENTIFIERS (no `partialResult`,
//       the cumulative tool output, which is logged once on tool_execution_end),
//       queue_update the COUNTS (never the steering/follow-up text), and
//       bash_execution_update its per-chunk delta;
//     - entry_appended logs a bounded SUMMARY of the entry it carries — its type
//       (and a custom entry's `customType`), its id, and the serialized size — and
//       never the entry itself: `entry` is an extension's own opaque payload, and
//       an extension that appends a growing snapshot would otherwise put that
//       growth back into the log;
//     - `*_end` events log the final content exactly once;
//     - an event type the projection does not name logs `{ type, unknownEvent:
//       true }` and none of its payload.
//
// Because each record's shape depends only on the event's own named fields, and a
// value that can grow (the entry) is reduced to its size, a record never grows
// with the events before it, so the log stays linear in the number of events
// rather than in their accumulated payload. The records the DELTA cap does not
// cover are NOT bounded by it — see DEFAULT_RUNLOG_DELTA_CAP_BYTES.

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

// How many bytes a value takes when it is serialized, or 0 when it cannot be
// serialized at all (a cycle) — the size WITHOUT the bytes, which is what lets a
// record say how big the payload it dropped was. The intermediate string is not
// kept; only its length is.
function serializedBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json);
  } catch {
    return 0;
  }
}

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

    // message_update: the inner stream event's KIND, the content block it belongs
    // to, and its increment only. Never `partial` (the whole message so far) or
    // `message` (its growing shallow copy) — that pair is what made the log
    // quadratic. The delta reconstructs the message and message_end carries the
    // final one once.
    case "message_update": {
      const inner = (event.assistantMessageEvent ?? {}) as EventRecord;
      const out: EventRecord = { type };
      if (inner.type !== undefined) out.kind = inner.type;
      // `contentIndex` is the delta's OWN block (pi-ai's AssistantMessageEvent:
      // every text/thinking/tool-call event carries it). Without it a delta is
      // just text with no place to go: the message as a whole arrives on
      // message_end, so a run that dies before one would leave deltas from
      // several blocks — thinking, text, tool-call arguments — that nothing can
      // attribute or reassemble. It is a small integer per delta, so keeping it
      // costs nothing and does not grow.
      if (inner.contentIndex !== undefined) out.contentIndex = inner.contentIndex;
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

    // entry_appended: a BOUNDED SUMMARY of the entry, never the entry. `entry` is
    // an extension's own opaque payload (session-manager.d.ts: CustomEntry.data,
    // BranchSummaryEntry.details, CustomMessageEntry.content), and an extension
    // that appends a growing state snapshot makes the entry grow with the SESSION,
    // not with the event — logging it whole re-introduces exactly the growth this
    // projection removes. Identity and size instead: what it was, and what it
    // would have cost to keep.
    case "entry_appended": {
      const entry = (event.entry ?? {}) as EventRecord;
      const out: EventRecord = { type };
      if (entry.type !== undefined) out.entryType = entry.type;
      if (entry.customType !== undefined) out.entryCustomType = entry.customType;
      if (entry.id !== undefined) out.entryId = entry.id;
      out.entryBytes = serializedBytes(event.entry);
      return out;
    }
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
  // Stop an in-flight turn. pi's AgentSession exposes `abort()`, which resolves
  // once the agent is idle; bob calls it when a bound or loop break ends a run.
  // Optional so a fake session in tests need not provide it; without it, bob
  // cannot confirm the session stopped.
  abort?(): Promise<void>;
  // Queue a message for the agent. pi's AgentSession `steer()` only queues; it
  // never starts a turn. pi delivers the queue at the start of its next agent
  // run, after each assistant turn, and in the continuation it runs after an
  // auto-compaction. A one-shot run sends its compaction note this way.
  // Optional so a fake session in tests need not provide it; without it, the
  // note is not sent.
  steer?(text: string): Promise<void>;
  dispose(): void;
}

// Inputs the session factory needs to stand up a pi session for an agent.
// Resolved from bob.yaml/soul.md + the per-call model override before the
// factory is called, so a fake factory in tests doesn't need filesystem access.
export interface RunSessionConfig {
  // pi provider id (already mapped from the bob provider, e.g.
  // exe-dev-gateway → anthropic).
  provider: string;
  readonly providerRecord?: ProviderRecord;
  // Model id to run. Per-call override wins over bob.yaml.
  model: string;
  // Appended system prompt (soul.md contents). Empty string when no soul.
  appendSystemPrompt: string;
  // bob#254 — the Flair bootstrap block, when the agent's resolved capabilities
  // include the flair capability. Appended to the system prompt AFTER soul.md,
  // as its own entry (session.ts isolatedLoaderOptions). Holds EITHER the
  // block or the one-line "could not be loaded" note; absent when the agent
  // does not configure flair, or the session holds web.
  flairBootstrap?: string;
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
  // True only for the PERSISTENT runtime (`bob run <name>`/runPersistent). Surfaced
  // to capabilities via BOB_PERSISTENT so "serving" capabilities (e.g. discord's
  // inbound gateway listener) only open their connection persistently — a
  // one-shot `bob run` stays minimal (outbound tools, no gateway). Defaults
  // falsy (ephemeral run).
  persistent?: boolean;
  // Owned by startPersistent; capabilities obtain it from the loader service.
  turnAdmission?: TurnAdmission;
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
  // bob#230 — the RESOLVED residency decision (bob.yaml `resident: true`, or
  // the persistent runtime), as resolveRunConfig's tool policy decided it. The
  // factory confines `read` for a resident session from THIS, so a one-shot
  // `bob run` of a resident agent is confined exactly like its persistent
  // runtime. Absent: not resident unless `persistent` says so.
  resident?: boolean;
  // bob#230 — the agent's credential files, from bob's own PARSED config
  // (collectCredentialPaths: identity.key_file, the flair block's keyFile, each
  // capability's validated tokenFile/keyFile/officeKeyFile), plus pi's provider
  // stores under `.pi-agent`. A resident role that opts into `read` gets a
  // confined read that refuses these even inside the workspace. When the list
  // could not be built, `credentialPathsUnavailable` says why, and the factory
  // REFUSES to compose a resident read — it never falls back to an empty list.
  credentialPaths?: string[];
  credentialPathsUnavailable?: string;
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
  // bob#204: the `soul.md` of the agent the session runs as, set ONLY by the
  // setup sessions (`bob onboard`'s hiring interview and `bob align`) from
  // bindSetupSoulTarget (write-soul.ts): absolute, under the agents root that
  // was canonicalized once and that the session's config was resolved from. When present, bob's session factory registers
  // the bob-owned `write_soul` tool bound to this path — the setup policy's one
  // write, never a tool argument. No other path sets it, so no other session
  // gets the tool.
  setupSoulPath?: string;
  // bob#214: the declared limits of the model — bob.yaml's `provider:`
  // context_window (and optional max_output_tokens), bound to the provider/model
  // pair they describe. The session factory REFUSES a session whose pair has no
  // declared window: there is no default, because a window bob guessed can
  // disagree with the server. Absent here means "not declared".
  modelLimits?: ModelLimits;
  // bob#214: bob.yaml's own provider (pi's id) and provider.model — the pair
  // provider.context_window describes. When the session's pair has no declared
  // window, the factory's refusal uses it to name the key that would declare one
  // (provider.context_window, or a provider.models entry for a --model override).
  yamlModel?: { provider: string; model: string };
  // bob#214: compact between model calls once the context passes this fraction
  // of the window (bob.yaml `session:` over role.json `session`). Absent: pi's
  // own threshold (the window minus its reserve).
  compactionThreshold?: number;
  // bob#214: the thinking level handed to pi (bob.yaml `session:` over
  // role.json `session`). Absent: pi's default.
  thinking?: ThinkingSetting;
  // bob#275 (S2a): the launcher-supplied task binding the work capability reads
  // (via the task-binding environment hand-off). It carries the task and
  // publication identities, repository/workspace, pinned base, mode, artifact
  // root, declared paths, check commands and publication destination. Set by a
  // LAUNCHER only — the resolver never reads it from bob.yaml, so an agent
  // cannot write its own authority. Absent: the session has no task, and the
  // dependent operations refuse.
  taskBinding?: TaskBinding;
}

// The injectable seam. Production builds a real pi AgentSession through bob's
// ONE session factory (session.ts); tests inject a fake that returns canned
// assistant text without any LLM call.
export type RunSessionFactory = (config: RunSessionConfig) => Promise<RunSession>;

export interface RunOptions {
  // Agent name. Config lives at ~/agents/<name>/.
  name: string;
  // The validated provider selection this run resolves against. Loaded ONCE by
  // the caller (the CLI) and threaded here; it defaults to the built-in table
  // for tests. Never re-loaded per call.
  registry?: ProviderRegistry;
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
  // Host state root for the position grant store (tests). Defaults to ~/.bob/host.
  hostRoot?: string;
  // Positions root (tests). Defaults to bob's packaged positions/ directory.
  positionsRoot?: string;
  // bob#275 (S2a): the launcher-supplied task binding for this run, passed
  // through to the session factory. Absent: the session has no task.
  taskBinding?: TaskBinding;
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
  // Deterministic bound timer for tests; production uses native timers.
  timer?: RunTimer;
  // #145: the ONE completion contract this run is judged by. When the caller
  // (or bob.yaml) declares an expected final-assistant-message shape, a run only
  // settles exit 0 when the captured final text matches it. Omitted → the
  // contract is "the final message is non-empty".
  expectedFinal?: (text: string) => boolean;
  // #145: cap on the contract block appended to the system prompt. Defaults to
  // DEFAULT_CONTRACT_CAP_CHARS. A blank task is refused before the session
  // starts, whatever this is.
  contractCapChars?: number;
  // The TASK contract carried in the system prompt, when it is not the prompt
  // itself. Defaults to `prompt`. A mail turn (bob#200) sets it to the
  // capability's FIXED frame, so the untrusted mail body — which is the user
  // message — never reaches the system prompt.
  taskContract?: string;
  // bob#200: this run answers ONE TPS mail. The session holds only the role's
  // tools that are on the reviewed mail allowlist (tool-allowlist.ts
  // MAIL_TURN_ALLOWED_TOOLS: the Flair memory tools); every other tool, from any
  // role or capability, is dropped.
  mailTurn?: boolean;
  // bob#143 item 3: the loop breaker's limit — how many consecutive identical
  // tool calls trip it. Overrides bob.yaml's `run.tool_loop_limit`.
  toolLoopLimit?: number;
  explorationBudget?: number;
  // Overrides the role's `require_edit_or_blocked` completion gate.
  requireEditOrBlocked?: boolean;
  // bob#135 — the one-shot run's bounds, in milliseconds. Each overrides the
  // agent's bob.yaml `run:` block, which overrides run-bounds.ts's default.
  // Tests pass small values.
  wallClockMs?: number;
  noProgressMs?: number;
  turnTimeoutMs?: number;
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
  // True when the run FAILED rather than settled: the prompt threw, or the last
  // assistant message ended on an error/abort. Undefined otherwise — a run with
  // no final message that did NOT fail simply had nothing to say. (A mail turn
  // retries a failure and sends no reply for silence.)
  failed?: true;
  // bob#143 item 3: set when the loop breaker ended the run — the same tool call
  // repeated `toolLoopLimit` times in a row. The exit code is non-zero.
  loopBreaker?: { toolName: string; count: number };
  // bob#135: set when a bound ended the run (the wall clock, the no-progress
  // watchdog, or a turn timeout) rather than the session. The exit code is
  // non-zero.
  aborted?: TerminationReason;
  explorationBudgetExhausted?: { limit: number; nonProgressCalls: number };
  // The completion judge accepted, but the edit-or-BLOCKED gate rejected.
  noEditNoBlocked?: true;
}

// bob#254 — load the Flair bootstrap for this session and attach the rendered
// block to the config. A failure never stops the session: the block becomes the
// one-line "could not load" note instead (flair-bootstrap.ts). No target (the
// agent does not configure the flair capability) → nothing to do.
export async function attachFlairBootstrap(
  target: FlairBootstrapTarget | undefined,
  config: RunSessionConfig,
  log?: (message: string) => void,
): Promise<void> {
  if (target === undefined) return;
  const text = await loadFlairBootstrapContext({
    target,
    gate: config,
    ...(log !== undefined ? { log } : {}),
  });
  if (text.length > 0) config.flairBootstrap = text;
}

// bob#143 item 3 — the loop breaker error and its log line live in
// tool-loop.ts, shared by the one-shot run and the persistent turn path.
// bob#283 — the line the runtime prints when a run that made no verified edit
// also did not report BLOCKED, so it is not reported as a success.
function noEditNoBlockedMessage(name: string): string {
  return `bob run ${name}: NO EDIT AND NO BLOCKED REPORT — the run made no verified edit and its final message did not begin with BLOCKED, so it was not reported as a success (exit 1). Make the edit, or end with a message that begins with BLOCKED.\n`;
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
  const taskContract = opts.taskContract ?? opts.prompt;
  if (taskContract.trim().length === 0) {
    throw new Error("runAgent: refusing to start a session with a blank task contract");
  }

  const root = opts.agentsRoot ?? join(homedir(), "agents");
  const resolved = resolveRunConfig({
    name: opts.name,
    agentsRoot: root,
    model: opts.model,
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
    ...(opts.mailTurn ? { mailTurn: true } : {}),
    ...(opts.hostRoot !== undefined ? { hostRoot: opts.hostRoot } : {}),
    ...(opts.positionsRoot !== undefined ? { positionsRoot: opts.positionsRoot } : {}),
    ...(opts.taskBinding !== undefined ? { taskBinding: opts.taskBinding } : {}),
  });
  // bob#135 — the one-shot run's bounds: bob.yaml `run:` overlaid with the
  // per-invocation flags. The wall clock and the watchdog start HERE, once the
  // configuration is resolved and before the Flair bootstrap and the session
  // start. A run-level bound (wall clock, no-progress watchdog) or the turn
  // timeout ends the run with a non-zero exit; `stop()` in the `finally` clears
  // the run-level timers, and a fired bound cancels a pending turn deadline, so
  // a completed run leaves the event loop free.
  const limits = resolveRunLimits(resolved.runLimits, {
    ...(opts.wallClockMs !== undefined ? { wallClockMs: opts.wallClockMs } : {}),
    ...(opts.noProgressMs !== undefined ? { noProgressMs: opts.noProgressMs } : {}),
    ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
  });
  const bounds = createRunBounds(limits, opts.timer);
  try {
    return await runBoundedSession(opts, opts.prompt, taskContract, resolved, bounds);
  } finally {
    bounds.stop();
  }
}

// The run itself, under the bounds created by runAgent. Split out so the timer
// lifecycle lives in one `finally` in runAgent, wrapping every await below.
async function runBoundedSession(
  opts: RunOptions,
  prompt: string,
  taskContract: string,
  resolved: ResolvedRunConfig,
  bounds: RunBounds,
): Promise<RunResult> {
  const { agentDir, provider, model, config, flairBootstrapTarget } = resolved;
  const limits = bounds.limits;
  // bob#143 item 3: how many consecutive identical calls trip the loop breaker.
  const toolLoopLimit = opts.toolLoopLimit ?? resolved.toolLoopLimit;
  const explorationLimit = opts.explorationBudget ?? resolved.explorationBudget;
  // Applies to bob run and launch with a prompt; mail turns are exempt.
  const requireEditOrBlocked =
    opts.mailTurn !== true && (opts.requireEditOrBlocked ?? resolved.requireEditOrBlocked === true);
  const repositoryAtLaunch: RepositoryState =
    requireEditOrBlocked || explorationLimit !== undefined
      ? captureRepositoryState(config.cwd)
      : { kind: "unavailable" };
  let repositoryAtLastTool = repositoryAtLaunch;

  // bob#254 — the agent runtime sessions that build a system prompt load the
  // Flair bootstrap first. This covers `bob run` one-shot and the mail turn
  // (the mail turn reaches runAgent through `bob launch`). The persistent
  // runtime calls the same helper in persistent.ts; the interactive launch path
  // below covers the TUI. Setup sessions (onboard/align) are not runtime turns
  // and do not load it. Guarded like the factory below: when a run-level bound
  // fires first, the run returns without waiting for the bootstrap (the guard
  // does not cancel it).
  try {
    await bounds.guard(attachFlairBootstrap(flairBootstrapTarget, config));
  } catch (err) {
    if (err instanceof RunAbortedError) return abortedRunResult(opts, resolved, bounds, err.reason);
    throw err;
  }

  const factory =
    opts.sessionFactory ??
    ((cfg: RunSessionConfig) => createPiRunSession(cfg, undefined, opts.registry));
  // #145: the task is the session's CONTRACT, carried in its system prompt
  // through the factory. (It is ALSO the first user message below, so a provider
  // that shows only messages still sees it; see the README's stated limits.)
  // The factory is guarded too: when a run-level bound fires before a session
  // finishes standing up (pi's resource/extension load), the run returns
  // without waiting for it. The guard does not cancel the factory.
  let session: RunSession;
  try {
    session = await bounds.guard(
      factory({
        ...config,
        taskContract,
        ...(opts.contractCapChars !== undefined ? { contractCapChars: opts.contractCapChars } : {}),
      }),
    );
  } catch (err) {
    if (err instanceof RunAbortedError) return abortedRunResult(opts, resolved, bounds, err.reason);
    throw err;
  }

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
    // Owner-only: the log carries assistant text, tool arguments and tool results.
    // A directory an older bob created keeps its mode; the files below are 0600.
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });

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
    // distinct runs get distinct files — and therefore distinct locks.
    const runLogName = `${now().toISOString().replace(/[:.]/g, "-")}.${process.pid}.${randomLogSuffix()}.jsonl`;
    const runLogPath = join(runsDir, runLogName);

    // (4) The sidecar lock FIRST, before the log file exists: while this run writes
    // its log it holds `<log>.lock` naming its PID, and retention reads exactly that
    // to leave a live run's log alone. Taking it first means there is no window in
    // which an ACTIVE log has no lock — an unlocked `.jsonl` cannot be told from a
    // crashed run's, which is what makes it prunable, so a concurrent run's sweep
    // (or this agent's next run) would delete it under its writer. The lock belongs
    // to this log file alone (the name above is unique) and is created exclusively
    // too. Removed at run end.
    runLogLockPath = `${runLogPath}.lock`;
    try {
      writeFileSync(runLogLockPath, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (err) {
      // NO LOCK, NO LOG (issue #146, round 7): this used to be swallowed and the log
      // kept being written, which produced the one log retention is allowed to
      // delete — an ACTIVE one with no lock, deleted under the writer by the next
      // run's sweep. A run that cannot hold its lock writes no log at all instead:
      // the log file is never created (the lock is taken first), and the warning
      // below is its only trace. A lock this run did not create is never removed —
      // if the write failed because the path already existed, that lock is someone
      // else's, so `runLogLockPath` is cleared and run end leaves it alone.
      runLogLockPath = "";
      const reason = err instanceof Error ? err.message : String(err);
      // Re-thrown so the ONE setup warning names it: this catch KNOWS which step
      // failed (the lock) rather than guessing it, which is the point of round 6's
      // warning and this one's.
      throw new Error(`the run-log lock could not be created (${reason})`);
    }

    // (5) The log file itself, created EXCLUSIVELY (`wx`) so an existing path is
    // never clobbered; the line naming it comes after it exists, so the path is
    // announced only for a log that is really there.
    closeSync(openSync(runLogPath, "wx", 0o600));
    process.stderr.write(`run log: ${runLogPath}\n`);

    // (6) The DELTA cap: the per-run limit on the STREAMED DELTA events
    // (isDeltaEvent). Past it those deltas are dropped; every NON-delta event — tool
    // calls and results, errors, lifecycle, the *_end finals, the done line — keeps
    // coming, and exactly one line records that the DELTA cap was hit.
    const capBytes = opts.runLogCapBytes ?? DEFAULT_RUNLOG_DELTA_CAP_BYTES;
    let logBytes = 0; // running total of bytes committed to this log
    let deltaCapHit = false; // set once the marker below is written; then deltas stop

    // Synchronous writer: appendFileSync puts each record in the page cache when it
    // returns: every reader sees it and it survives the process dying, but power
    // loss or a kernel panic can still lose the tail, because nothing calls fsync.
    // That is the post-mortem property this log exists for: after the process
    // crashes, every record written before the crash is still readable. Each record
    // is projected to a bounded shape (`projectRunLogRecord`), so there is no per-write cost worth
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
  } catch (err) {
    // Setting up the log failed — creating the runs directory, creating the lock,
    // naming the file, or opening it. Warn once, name the real cause and the
    // directory it happened in (never a guessed step, since this catch covers all
    // four; the lock's own failure carries its step with it), and continue with the
    // no-op logger: logging never throws into the run. A lock taken before a later
    // step failed is dropped at run end; a leaked one names a now-dead PID, which
    // the next sweep treats as a finished run's.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `bob run ${opts.name}: run log unavailable in ${runsDir} (${reason}); continuing without a run log\n`,
    );
  }

  const loopDetector = new ToolLoopDetector(toolLoopLimit);
  const explorationDetector =
    explorationLimit !== undefined ? new ExplorationBudgetDetector(explorationLimit) : undefined;
  const loopController = new AbortController();
  let loopBreaker: { toolName: string; count: number } | undefined;
  let explorationExhausted: { limit: number; nonProgressCalls: number } | undefined;
  let verifiedEdits = 0;
  let noEditNoBlocked = false;
  const raceLoop = <T>(work: Promise<T>): Promise<T> => {
    if (loopBreaker !== undefined) {
      // A synchronous session may emit the breaking event before its prompt
      // promise is returned. Keep observing that promise's eventual rejection.
      void work.catch(() => {});
      return Promise.reject(new ToolLoopError(loopBreaker.toolName, loopBreaker.count));
    }
    if (explorationExhausted !== undefined) {
      void work.catch(() => {});
      return Promise.reject(
        new ExplorationBudgetExhaustedError(
          explorationExhausted.limit,
          explorationExhausted.nonProgressCalls,
        ),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (loopBreaker !== undefined) {
          reject(new ToolLoopError(loopBreaker.toolName, loopBreaker.count));
        } else if (explorationExhausted !== undefined) {
          reject(
            new ExplorationBudgetExhaustedError(
              explorationExhausted.limit,
              explorationExhausted.nonProgressCalls,
            ),
          );
        } else {
          // Only the two stops above abort this controller.
          reject(new ToolLoopError("", 0));
        }
      };
      loopController.signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          loopController.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          loopController.signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  };

  // Best-effort delivery of the exploration instruction: a session without
  // steer(), or a bound that fired first, must not throw into the subscriber.
  const reportInstructionUndelivered = (err: unknown): void => {
    const m = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `bob run ${opts.name}: the exploration-budget instruction was not delivered (${m}); the run continues\n`,
    );
  };

  // bob#135/bob#143/bob#279 — stop the session after a turn-level stop (the loop
  // breaker, or the exploration budget) and read the workspace, at most the
  // grace. The wait is bounded: pi's abort() waits for idle, so a turn that
  // never becomes idle must not keep the run (and the CLI's process.exit)
  // pending.
  const stopTurn = async (what: "repeated" | "over-budget"): Promise<void> => {
    const stopped = await abortBounded(session, LOOP_ABORT_GRACE_MS);
    if (stopped.timedOut) {
      process.stderr.write(
        `bob run ${opts.name}: the stop request did not settle within ${LOOP_ABORT_GRACE_MS}ms; ending the run anyway\n`,
      );
    } else if (!stopped.idle) {
      const m = stopped.missing
        ? "the session has no abort()"
        : stopped.error instanceof Error
          ? stopped.error.message
          : String(stopped.error);
      process.stderr.write(`bob run ${opts.name}: could not stop the ${what} turn — ${m}\n`);
    }
    reportWorktreeStatus(opts.name, config.cwd, stopped.idle);
  };

  const unsubscribeRunLog = session.subscribe((event) => {
    // Progress belongs to the session, regardless of whether its best-effort
    // log was opened, an append succeeds, or streamed deltas pass the log cap.
    bounds.noteProgress();
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
    // bob#143 item 3: count consecutive identical tool calls as they start.
    if (event.type === "tool_execution_start") {
      const toolName = String((event as unknown as { toolName?: unknown }).toolName ?? "");
      const args = (event as unknown as { args?: unknown }).args;
      const observation = loopDetector.observe(toolName, args);
      if (observation.fire && loopBreaker === undefined) {
        loopBreaker = { toolName, count: observation.count };
        writeRunLog(
          {
            t: now().toISOString(),
            outcome: { reason: "tool_loop", toolName, count: observation.count },
          },
          false,
        );
        process.stderr.write(loopBreakMessage(opts.name, toolName, args, observation.count));
        loopController.abort();
      }
    }
    if (event.type === "tool_execution_end") {
      const toolName = String((event as unknown as { toolName?: unknown }).toolName ?? "");
      const isError = (event as unknown as { isError?: unknown }).isError;
      const result = (event as unknown as { result?: unknown }).result;
      if (isVerifiedEdit(toolName, isError, result)) verifiedEdits += 1;
    }
    if (
      (event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
      explorationDetector !== undefined &&
      explorationExhausted === undefined
    ) {
      const call = event as unknown as { toolName?: unknown; isError?: unknown; result?: unknown };
      const toolName = String(call.toolName ?? "");
      const repository =
        event.type === "tool_execution_end" && repositoryAtLaunch.kind === "git"
          ? {
              cwd: config.cwd,
              before: repositoryAtLastTool,
              after: captureRepositoryState(config.cwd, repositoryAtLaunch),
            }
          : undefined;
      const budget =
        event.type === "tool_execution_start"
          ? explorationDetector.observeStart(toolName)
          : explorationDetector.observeEnd(toolName, call.isError, call.result, repository);
      if (repository?.after.kind === "git") repositoryAtLastTool = repository.after;
      if (budget.inject) {
        writeRunLog(
          {
            t: now().toISOString(),
            exploration: { nonProgressCalls: budget.nonProgressCalls, action: "instruction" },
          },
          false,
        );
        process.stderr.write(explorationInstructionMessage(opts.name, budget.nonProgressCalls));
        try {
          const sent = sendToSession(session, bounds, EXPLORATION_INSTRUCTION, "steer");
          void sent.catch(reportInstructionUndelivered);
        } catch (err) {
          reportInstructionUndelivered(err);
        }
      } else if (budget.exhaust) {
        explorationExhausted = {
          limit: explorationDetector.limit,
          nonProgressCalls: budget.nonProgressCalls,
        };
        writeRunLog(
          {
            t: now().toISOString(),
            outcome: {
              reason: "exploration_budget_exhausted",
              limit: explorationDetector.limit,
              nonProgressCalls: budget.nonProgressCalls,
            },
          },
          false,
        );
        process.stderr.write(
          explorationExhaustedMessage(
            opts.name,
            explorationDetector.limit,
            budget.nonProgressCalls,
          ),
        );
        loopController.abort();
      }
    }
  });

  // bob#214: one flat usage record per model request (prompt, cached-prompt,
  // completion and thinking tokens, time to first token, model), written when
  // the request's assistant message ends. A NON-delta record: the delta cap
  // never drops it.
  // bob#185 item 2: when the selected row declares a budget, a request whose
  // stopReason is "length" carries the row's output cap in the record.
  const usageTracker = createRequestUsageTracker(() => now().getTime(), {
    ...(config.providerRecord?.budget !== undefined
      ? { outputCap: config.providerRecord.budget.maxOutputTokens }
      : {}),
  });
  const unsubscribeUsage = session.subscribe((event) => {
    const record = usageTracker.observe(event);
    if (record !== undefined) writeRunLog({ t: now().toISOString(), requestUsage: record }, false);
  });

  let exitCode = 0;
  let reason: SilenceReason | undefined;
  let failed = false;
  let aborted: TerminationReason | undefined;

  // #145: Non-aborted compactions attempt a note unless a response after
  // `agent_end` has stopReason "stop", no tool calls, compaction willRetry false,
  // and final text satisfying the completion contract.
  // The observer also owns the final-message boundary the judge reads.
  const observer = createCompactionObserver({
    isComplete: (text) => judge(text).ok,
    worktreeStatus: () => readWorktreeStatus(config.cwd),
    // bob#244: the note carries workspace data (git status), so a web session
    // refuses it; the observer logs the refusal and the run carries on.
    // bob#135: through the run's one sender, so no note is sent once a bound
    // has fired, and queued with steer(), so the note never starts a turn.
    inject: gatedNoteInjection(config, "compaction-note", (text) =>
      sendToSession(session, bounds, text, "steer"),
    ),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const unsubscribeContract = session.subscribe((event) => observer.observe(event));

  // The judge reads the observer's final-message boundary.
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
  const judge = (capturedText = finalTextNow()): { ok: boolean; reason?: SilenceReason } =>
    evaluateCompletion({
      capturedText,
      compactions: observer.compactions(),
      expectedFinal: opts.expectedFinal,
    });

  try {
    // ONE re-prompt budget for the WHOLE run, shared across the compaction
    // retry: the total number of reasoning-only re-prompts never exceeds the
    // bound, whichever phase spends them (bob#256).
    let reasoningReprompts = 0;
    const budgetLeft = (): number => DEFAULT_MAX_REASONING_REPROMPTS - reasoningReprompts;
    const drainReasoningOnly = async (): Promise<void> => {
      if (budgetLeft() <= 0) return;
      const spent = await repromptWhileReasoningOnly({
        session,
        // Every re-prompt goes through the SAME bounded sender as the first
        // prompt, so a stalled continuation is ended by the turn bound too.
        send: (text) => raceLoop(boundedPrompt(session, text, bounds, loopController.signal)),
        readEnding: () => observer.lastEnding(),
        beginTurn: () => observer.startTurn(),
        maxReprompts: budgetLeft(),
        onReprompt: (n) =>
          process.stderr.write(
            `bob run ${opts.name}: the turn ended with reasoning only (no text beyond whitespace, no tool call) — re-prompting (${reasoningReprompts + n}/${DEFAULT_MAX_REASONING_REPROMPTS})\n`,
          ),
      });
      reasoningReprompts += spent.reprompts;
    };

    observer.startTurn();
    // bob's own runner: the text IS the prompt (no command/template/skill
    // expansion — see session.ts promptSession). Both bounds and loop breaker
    // observe the turn; every send goes through the single bounded sender.
    await raceLoop(boundedPrompt(session, prompt, bounds, loopController.signal));
    await raceLoop(bounds.guard(drainReasoningOnly()));

    // #145: the completion contract. Before this, a run settled `exitCode 0`
    // whenever the prompt promise resolved — including after a compaction that
    // erased the plan. Now it settles 0 ONLY with a final message (matching an
    // expected shape when one is declared).
    let outcome = judge();
    if (budgetLeft() <= 0 && observer.lastEnding()?.reasoningOnly === true) {
      // Budget exhausted on a reasoning-only ending: report the honest failure
      // BEFORE the compaction retry. The retry recovers a SILENT settlement after
      // compaction; it is not a fourth reasoning turn, and a
      // text reply to it must never turn the run green.
      outcome = { ok: false, reason: "reasoning_only" };
    } else if (!outcome.ok && outcome.reason === "settled_after_compaction") {
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
        await raceLoop(boundedPrompt(session, CONTINUE_TURN, bounds, loopController.signal));
        await raceLoop(bounds.guard(drainReasoningOnly())); // shared re-prompt budget
      } catch (err) {
        // Every turn-level stop must fail the whole run.
        if (
          err instanceof RunAbortedError ||
          err instanceof ToolLoopError ||
          err instanceof ExplorationBudgetExhaustedError
        )
          throw err;
        const m = err instanceof Error ? err.message : String(err);
        process.stderr.write(`bob run ${opts.name}: the continue turn failed — ${m}\n`);
      }
      outcome = judge();
      // Still reasoning-only after the retry is a failure, never a normal
      // completion.
      if (!outcome.ok && observer.lastEnding()?.reasoningOnly === true) {
        outcome = { ok: false, reason: "reasoning_only" };
      }
    }
    // A run with no final message whose last message ended on an error or an
    // abort FAILED; one that ended cleanly with nothing to say did not.
    if (!outcome.ok && observer.lastEndFailed()) failed = true;
    if (outcome.reason === "reasoning_only") failed = true;
    if (!outcome.ok) {
      // NEVER exit 0 for silence. Name the reason and print what we can (the
      // dirty paths, if the agent's cwd is a git worktree).
      exitCode = 1;
      reason = outcome.reason;
      if (reason === "reasoning_only") {
        // The honest outcome record. NO model reasoning is written: length
        // limiting cannot establish that a model's thinking carries no secret
        // (bob#256), so the record has only the reason and the re-prompt count.
        writeRunLog(
          {
            t: now().toISOString(),
            outcome: { reason: "reasoning_only", reprompts: reasoningReprompts },
          },
          false,
        );
      }
      process.stderr.write(
        `bob run ${opts.name}: REFUSING to report success — ${reason}` +
          (reason === "settled_after_compaction"
            ? " (the session settled after a context compaction without a final message)"
            : reason === "final_shape_mismatch"
              ? " (the final message did not match the declared shape)"
              : reason === "reasoning_only"
                ? ` (the session ended without a final report — its last turn carried reasoning only, no text beyond whitespace and no tool call, after ${reasoningReprompts} re-prompt(s))`
                : " (the session settled without a final message)") +
          "\n",
      );
      reportWorktreeStatus(opts.name, config.cwd, true);
    }
    // Only an accepted completion reaches this gate; outcome logging is best-effort.
    if (
      exitCode === 0 &&
      requireEditOrBlocked &&
      verifiedEdits === 0 &&
      !isVerifiedEdit("", undefined, undefined, {
        cwd: config.cwd,
        before: repositoryAtLaunch,
        after: captureRepositoryState(config.cwd, repositoryAtLaunch),
      })
    ) {
      if (!/^BLOCKED(?=$|\s|:)/.test(finalTextNow())) {
        exitCode = 1;
        noEditNoBlocked = true;
        writeRunLog({ t: now().toISOString(), outcome: { reason: "no_edit_no_blocked" } }, false);
        process.stderr.write(noEditNoBlockedMessage(opts.name));
        reportWorktreeStatus(opts.name, config.cwd, true);
      }
    }
  } catch (err) {
    exitCode = 1;
    failed = true;
    if (err instanceof ToolLoopError) {
      // The event subscriber has already logged the break and named the call.
      // Use the same bounded abort as every other one-shot termination.
      await stopTurn("repeated");
    } else if (err instanceof ExplorationBudgetExhaustedError) {
      // The event subscriber has already logged the outcome and named the
      // budget (it set `explorationExhausted`). Same bounded abort.
      await stopTurn("over-budget");
    } else if (err instanceof RunAbortedError) {
      // bob#135 — a bound ended the run: name it and how to raise it, and record
      // the outcome in the log. Then signal the session's abort and wait for it,
      // at most the grace, BEFORE reading the workspace; if the abort did not
      // resolve, the report says the workspace may still be changing. The wait
      // is bounded: pi's abort() waits for idle, so a turn that never becomes
      // idle must not keep the run (and the CLI's process.exit) pending.
      aborted = err.reason;
      writeRunLog({ t: now().toISOString(), outcome: { reason: err.reason } }, false);
      process.stderr.write(boundMessage(opts.name, err.reason, limits));
      const stopped = await abortBounded(session, ABORT_GRACE_MS);
      reportWorktreeStatus(opts.name, config.cwd, stopped.idle);
    } else {
      // Surface the error instead of swallowing it: an underscore-ignored catch
      // made a cap-hit look like a silent clean exit. Label a provider
      // rate-limit/cap so a budget stall is distinguishable from a crash.
      const msg = err instanceof Error ? err.message : String(err);
      const isCap =
        /rate.?limit|quota|\b429\b|too many requests|usage limit|capacity|overloaded/i.test(msg);
      process.stderr.write(
        `bob run ${opts.name}: ${isCap ? "PROVIDER RATE-LIMIT/CAP" : "run failed"} — ${msg}\n`,
      );
    }
  } finally {
    // Stop recording first: the done line below is this log's last record, and the
    // run is over whatever the turn did.
    unsubscribeRunLog();
    unsubscribeUsage();
    unsubscribeContract();

    // Final record, so a reader can tell a clean completion from a truncated log.
    // A synchronous append is on disk when writeRunLog returns, so a mid-run crash
    // leaves every record written before it — the post-mortem trail this log exists
    // for.
    writeRunLog(
      {
        done: true,
        exitCode,
        ...(repositoryAtLaunch.kind === "git" && repositoryAtLaunch.historyCheckSkipped
          ? { repositoryHistoryCheckSkipped: repositoryAtLaunch.historyCheckSkipped }
          : {}),
      },
      false,
    );

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
    ...(loopBreaker !== undefined ? { loopBreaker } : {}),
    ...(explorationExhausted !== undefined
      ? { explorationBudgetExhausted: explorationExhausted }
      : {}),
    ...(noEditNoBlocked ? { noEditNoBlocked: true as const } : {}),
    ...(aborted !== undefined ? { aborted } : {}),
    ...(failed ? { failed: true as const } : {}),
  };
}

// The result for a run a bound ended during the Flair bootstrap or before the
// session factory returned: bob has no returned session handle, so it signals
// no abort and reads no workspace status, and there is no run log to record it
// in. A session the factory returns after this is never used, aborted or
// disposed; in the `bob` CLI, `process.exit` ends it.
function abortedRunResult(
  opts: RunOptions,
  resolved: ResolvedRunConfig,
  bounds: RunBounds,
  reason: TerminationReason,
): RunResult {
  process.stderr.write(boundMessage(opts.name, reason, bounds.limits));
  return {
    exitCode: 1,
    agentDir: resolved.agentDir,
    provider: resolved.provider,
    model: resolved.model,
    ...(opts.captureStdout ? { stdout: "" } : {}),
    aborted: reason,
    failed: true,
  };
}

// bob#135 — the ONE place a one-shot run sends to its session. The task, the
// continue turn and the reasoning re-prompts go through it as turns (through
// promptSession, so template expansion stays off; boundedPrompt times each one).
// The compaction note goes through it as a steer: queued with `steer()`, which
// never starts a turn. pi delivers it only if an agent run continues or starts
// after it is queued; otherwise it is not delivered. Once
// any bound has fired it sends nothing and throws that bound's RunAbortedError.
// It throws synchronously, before a prompt promise exists, so a caller that
// races the send is never left holding an unhandled rejection.
function sendToSession(
  session: RunSession,
  bounds: RunBounds,
  text: string,
  as: "turn" | "steer",
): Promise<void> {
  const fired = bounds.reason();
  if (fired !== undefined) throw new RunAbortedError(fired);
  if (as === "turn") return promptSession(session, text);
  if (session.steer === undefined) {
    throw new Error("the session has no steer(), so the note is not sent");
  }
  return session.steer(text);
}

// One prompt turn under the run's abort (bounds.guard), and an optional turn
// timeout. A configured timeout that expires ends the run as `turn_timeout`;
// there is no retry. The caller's abort path then signals
// the session's abort. pi's PromptOptions carries no AbortSignal and `prompt()`
// is a whole turn (model requests plus tool work), so a turn is the smallest
// unit bob can bound.
async function boundedPrompt(
  session: RunSession,
  text: string,
  bounds: RunBounds,
  loopSignal: AbortSignal,
): Promise<void> {
  const turnTimeoutMs = bounds.limits.turnTimeoutMs;
  if (turnTimeoutMs === undefined) {
    await bounds.guard(sendToSession(session, bounds, text, "turn"));
    return;
  }
  const outcome = await bounds.guard(
    raceTimeout(
      sendToSession(session, bounds, text, "turn"),
      turnTimeoutMs,
      AbortSignal.any([bounds.signal, loopSignal]),
      bounds.timer,
    ),
  );
  if (outcome !== TIMED_OUT) return;
  // The first bound to fire is the one reported.
  bounds.fire("turn_timeout");
  throw new RunAbortedError(bounds.reason() ?? "turn_timeout");
}

// How long an abort may block the run. pi's abort() signals cancellation and
// then WAITS for the agent to become idle; a turn that never becomes idle must
// not keep the run pending, so every abort is signalled and then given at most
// this long to settle before the run returns on its own.
const ABORT_GRACE_MS = 1_000;

/** Signal the session's abort and give it at most `graceMs` to settle. The
 *  result reports idle only when abort() resolved within the grace (pi's abort()
 *  resolves once the agent is idle). Missing, rejected and pending aborts are
 *  distinct so callers can report the cause. Never blocks past the grace. */
async function abortBounded(
  session: RunSession,
  graceMs: number,
): Promise<{ idle: boolean; missing?: boolean; timedOut?: boolean; error?: unknown }> {
  const abort = session.abort;
  if (abort === undefined) return { idle: false, missing: true };
  const settled = await raceTimeout(
    Promise.resolve()
      .then(() => abort.call(session))
      .then(
        () => ({ idle: true }),
        (error: unknown) => ({ idle: false, error }),
      ),
    graceMs,
  );
  return settled === TIMED_OUT ? { idle: false, timedOut: true } : settled;
}

/** Print the agent cwd's worktree status: the paths a run may have left dirty,
 *  or that the status could not be read — never "clean" for a git that failed
 *  or timed out. `idle` false means the session did not confirm it stopped:
 *  the report says the workspace may still be changing, and a clean read is
 *  not reported as final. */
function reportWorktreeStatus(name: string, cwd: string, idle: boolean): void {
  const status = readWorktreeStatusResult(cwd);
  if (!idle) {
    process.stderr.write(
      `bob run ${name}: the session did not confirm it stopped, so the workspace may still be changing\n`,
    );
  }
  if (!status.ok) {
    process.stderr.write(`bob run ${name}: workspace status unavailable in ${cwd}\n`);
  } else if (status.status.length > 0) {
    process.stderr.write(`bob run ${name}: uncommitted paths in ${cwd}:\n`);
    for (const line of status.status.split("\n")) process.stderr.write(`  ${line}\n`);
  } else if (idle) {
    process.stderr.write(`bob run ${name}: no dirty paths in ${cwd} (nothing to commit there)\n`);
  } else {
    process.stderr.write(`bob run ${name}: no uncommitted paths in ${cwd} when read\n`);
  }
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
  // bob#200: the session answers one TPS mail — applyMailTurnPolicy narrows the
  // resolved policy to the mail allowlist, for an ordinary AND an adopted
  // (position-bound) agent alike. Only ever narrows.
  mailTurn?: boolean;
  // Host state root for the position grant store. Defaults to ~/.bob/host. When
  // an agent has no grant it is NOT adopted, and resolution is unchanged.
  hostRoot?: string;
  // Positions root (tests). Defaults to bob's packaged positions/ directory.
  positionsRoot?: string;
  // bob#275 (S2a): the launcher-supplied task binding, threaded into
  // RunSessionConfig.taskBinding. A launcher supplies it; bob.yaml cannot.
  taskBinding?: TaskBinding;
  // The provider registry this resolution reads its identity records from.
  // Defaults to the built-in table; tests supply one with a row of their own.
  registry?: ProviderRegistry;
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
  // The resolved, schema-validated capabilities (bob.yaml `capabilities:`), so
  // the persistent runtime can start the ones it runs itself (tps-mail's inbox
  // consumer) from the SAME validated config the session loads.
  capabilities: ResolvedCapability[];
  // bob#254 — where to call Flair at session start, when the agent configures
  // the flair capability. Absent: no bootstrap is loaded.
  flairBootstrapTarget?: FlairBootstrapTarget;
  // bob#143 item 3 — bob.yaml `run.tool_loop_limit`, or the default. One-shot
  // runs and the persistent runtime both observe it.
  toolLoopLimit: number;
  // bob#279 — the effective exploration budget: bob.yaml `run.exploration_budget`
  // over the role's role.json `exploration_budget`. Absent when neither sets one,
  // which leaves the budget off.
  explorationBudget?: number;
  // bob#283 — the role opted in to the edit-or-blocked completion rule. Absent
  // when the role does not; used by bob run and launch with a prompt.
  requireEditOrBlocked?: true;
  // bob#135 — the agent's bob.yaml `run:` bounds (seconds), parsed and
  // validated for every caller. A one-shot `bob run` overlays its per-invocation
  // flags on these to arm the run.
  runLimits: RunLimitsBlock;
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
      allowResidentWeb: role.tools.allowResidentWeb,
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
  // Host state root for the position grant store (tests). Defaults to ~/.bob/host.
  hostRoot?: string;
  // Positions root (tests). Defaults to bob's packaged positions/ directory.
  positionsRoot?: string;
  // Test seam for the one-shot path (defaults to the real SDK factory).
  sessionFactory?: RunSessionFactory;
  // The validated provider selection (loaded once by the CLI).
  registry?: ProviderRegistry;
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
      ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
      ...(opts.hostRoot !== undefined ? { hostRoot: opts.hostRoot } : {}),
      ...(opts.positionsRoot !== undefined ? { positionsRoot: opts.positionsRoot } : {}),
      captureStdout: true,
      sessionFactory: opts.sessionFactory,
    });
    if (result.stdout && result.stdout.trim().length > 0) {
      process.stdout.write(`${result.stdout}\n`);
    }
    return result.exitCode;
  }

  const { config, policy, flairBootstrapTarget } = resolveRunConfig({
    name: opts.name,
    agentsRoot: opts.agentsRoot ?? join(homedir(), "agents"),
    model: opts.model,
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
    ...(opts.hostRoot !== undefined ? { hostRoot: opts.hostRoot } : {}),
    ...(opts.positionsRoot !== undefined ? { positionsRoot: opts.positionsRoot } : {}),
  });
  // bob#254 — the interactive path builds a real system prompt too, so it loads
  // the bootstrap before the session is opened.
  await attachFlairBootstrap(flairBootstrapTarget, config);
  const interactive = opts.interactive ?? ((i) => runInteractiveSession({ ...i, deps: opts.deps }));
  return interactive({
    config,
    policy,
    deps: opts.deps,
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
  });
}

// ─── `bob launch` in mail-turn mode (bob#200) ────────────────────────────────
//
// The tps-mail consumer runs each accepted mail through the agent's launcher
// with BOB_MAIL_TURN=1 in the environment and the VERIFIED fields as JSON on
// STDIN (never argv). This is that turn: ONE fresh session, the capability's
// fixed frame as the task contract (system prompt), the delimited untrusted
// mail as the user message, and only the role's tools on the mail allowlist.
//
// It writes ONE result line on stdout and exits 0 when the turn settled —
// `final` (the compaction contract's final message: the reply) or `silent` (no
// final message: tool-only or empty, so no reply) — and exits 1 with no result
// line when the turn FAILED (an error-ended message or a thrown run), which the
// consumer retries. An input it cannot accept exits 2. The env flag and stdin
// can only NARROW what the session gets; they select no tool and no model.

// A mail turn runs in its OWN process group (so a timeout can kill everything
// it started), which also means a crash of the runtime that started it no
// longer takes it down with the runtime's group. So the turn watches the
// CONSUMER — whose pid the consumer passes at spawn (BOB_MAIL_TURN_PARENT) —
// and ends when it is gone (Gauge round 5, blocker 4). The first check runs
// IMMEDIATELY, before stdin is read, so a consumer that died before the turn
// even started is caught; later checks also catch the turn being reparented.
// An orphaned turn could never have its reply sent, and must not keep a model
// busy. Stated limit: a dead consumer whose pid is reused within the check
// interval reads as alive until the reparenting check fires.
export function watchParent(
  opts: {
    expectedParentPid?: number;
    getPpid?: () => number;
    isAlive?: (pid: number) => boolean;
    exit?: (code: number) => void;
    intervalMs?: number;
  } = {},
): () => void {
  const getPpid = opts.getPpid ?? (() => process.ppid);
  const isAlive =
    opts.isAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    });
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const initialPpid = getPpid();
  let fired = false;
  const end = (why: string) => {
    fired = true;
    process.stderr.write(`bob launch: ${why}; ending the turn\n`);
    exit(1);
  };
  // At installation the expected consumer must BE this process's parent (the
  // generated launcher `exec`s bob, so the consumer spawned this very process).
  // A mismatch means the consumer is already gone (reparented) or the variable
  // does not describe this process, and either way the pid proves nothing.
  if (opts.expectedParentPid !== undefined && initialPpid !== opts.expectedParentPid) {
    end(
      `this mail turn's parent is pid ${initialPpid}, not the consumer pid ${opts.expectedParentPid} that should have spawned it (the consumer is gone, or a launcher did not exec bob)`,
    );
    return () => {};
  }
  const check = () => {
    if (fired) return;
    const consumerGone = opts.expectedParentPid !== undefined && !isAlive(opts.expectedParentPid);
    if (consumerGone || getPpid() !== initialPpid) {
      end("the consumer that started this mail turn is gone");
    }
  };
  check();
  const timer = setInterval(check, opts.intervalMs ?? 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// The consumer pid from BOB_MAIL_TURN_PARENT, when it is one.
export function mailTurnParentPid(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export interface MailTurnLaunchOptions {
  name: string;
  // The raw stdin the consumer wrote (already read, bounded by the caller).
  input: string;
  agentsRoot?: string;
  model?: string;
  // The validated provider selection (loaded once by the CLI).
  registry?: ProviderRegistry;
  // Host state root for the position grant store (tests). Defaults to ~/.bob/host.
  hostRoot?: string;
  // Positions root (tests). Defaults to bob's packaged positions/ directory.
  positionsRoot?: string;
  sessionFactory?: RunSessionFactory;
  // Where the result line goes. Defaults to stdout, awaited until flushed.
  write?: (text: string) => Promise<void>;
  // Test seam for the template's marker nonce.
  nonce?: string;
}

export async function runMailTurnLaunch(opts: MailTurnLaunchOptions): Promise<number> {
  let input: ReturnType<typeof parseMailTurnInput>;
  try {
    input = parseMailTurnInput(opts.input);
  } catch (err) {
    process.stderr.write(
      `bob launch ${opts.name}: mail turn refused — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }
  const prompt = buildMailTurnPrompt(input, opts.nonce ? { nonce: opts.nonce } : {});
  // The consumer watchdog is installed by the CLI BEFORE stdin is read
  // (cli.ts), so it covers this whole call.
  return runMailTurn(opts, prompt);
}

async function runMailTurn(
  opts: MailTurnLaunchOptions,
  prompt: ReturnType<typeof buildMailTurnPrompt>,
): Promise<number> {
  const result = await runAgent({
    name: opts.name,
    prompt: prompt.userMessage,
    taskContract: prompt.contract,
    mailTurn: true,
    model: opts.model,
    agentsRoot: opts.agentsRoot,
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
    ...(opts.hostRoot !== undefined ? { hostRoot: opts.hostRoot } : {}),
    ...(opts.positionsRoot !== undefined ? { positionsRoot: opts.positionsRoot } : {}),
    captureStdout: true,
    sessionFactory: opts.sessionFactory,
  });
  const write =
    opts.write ??
    ((text: string) =>
      new Promise<void>((resolve) => {
        process.stdout.write(text, () => resolve());
      }));
  const text = (result.stdout ?? "").trim();
  if (result.exitCode === 0 && text.length > 0) {
    await write(formatMailTurnResult({ outcome: "final", text }));
    return 0;
  }
  if (result.failed) {
    process.stderr.write(
      `bob launch ${opts.name}: mail turn FAILED (no reply; the consumer retries the mail)\n`,
    );
    return 1;
  }
  // Settled with nothing to say: silence is a valid mail outcome.
  await write(formatMailTurnResult({ outcome: "silent" }));
  return 0;
}

// Read the mail-turn input: fd 0 (stdin), synchronously, until EOF.
//
// NOT through `process.stdin` (bob#203). Under bun, a `process.stdin` that was
// created in an earlier tick yields NOTHING when fd 0 is a regular file — and
// bob's module graph creates it at import (pi-coding-agent touches the getter),
// so every read came back empty. On Linux, bun's spawnSync hands a child its
// `input` as a memfd, which is a regular file: the mail-turn test failed there
// with "not JSON" while passing on macOS, where it is a pipe. Node was never
// affected. Reading the descriptor directly has no stream state to lose and
// behaves the same in both runtimes, for a pipe, a file or a memfd, in one
// chunk or many.
//
// It reads until read(2) returns 0 (EOF) — every chunk, however the writer
// split it. A pipe may be non-blocking (node makes fd 0 non-blocking once
// `process.stdin` exists), so EAGAIN waits briefly and reads again. More than
// `maxBytes` is refused rather than truncated. A writer that never closes the
// pipe blocks the read; the consumer's turn timeout kills the process.
export interface MailTurnInputReadOptions {
  fd?: number;
  maxBytes?: number;
  // Seams (tests): the read(2) and the EAGAIN wait.
  readSync?: (fd: number, buf: Buffer, offset: number, length: number, position: null) => number;
  sleep?: (ms: number) => void;
}

const EAGAIN_WAIT_MS = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readMailTurnInput(opts: MailTurnInputReadOptions = {}): string {
  const fd = opts.fd ?? 0;
  const maxBytes = opts.maxBytes ?? MAIL_TURN_INPUT_MAX_BYTES;
  const read = opts.readSync ?? ((f, b, o, l, p) => readSync(f, b, o, l, p));
  const sleep = opts.sleep ?? sleepSync;
  const chunks: Buffer[] = [];
  let size = 0;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let n: number;
    try {
      n = read(fd, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        sleep(EAGAIN_WAIT_MS);
        continue;
      }
      if (code === "EOF") break;
      throw err;
    }
    if (n === 0) break; // EOF: the writer closed its end
    size += n;
    if (size > maxBytes) {
      throw new Error(
        `mail turn input exceeds ${maxBytes} bytes; refusing it rather than reading a truncated mail`,
      );
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
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
    .map((e) => {
      const reason = originValidationError({ kind: "cron", job: e.name });
      if (reason) throw new Error(`bob: invalid cron entry name: ${reason}`);
      return { name: e.name, schedule: e.schedule, prompt: e.prompt };
    });
}

// The agent's EFFECTIVE capabilities — the set the persistent runtime starts
// (bob#200 x bob#195, Gauge round 6, blocker 4). For an ADOPTED agent that is
// the grant-resolved set with local disables applied, from the SAME resolver
// resolveRunConfig uses; for any other agent it is bob.yaml's capabilities:
// list, the list resolveCapabilities walks. `bob doctor` reads this, so it can
// never report a capability healthy that the runtime will not start.
export function effectiveCapabilities(opts: {
  name: string;
  agentDir: string;
  yamlText: string;
  hostRoot?: string;
  positionsRoot?: string;
}): { adopted: boolean; names: string[]; configs: Record<string, Record<string, unknown>> } {
  const adopted = resolveAdoptedConfig({
    name: opts.name,
    agentDir: opts.agentDir,
    yamlText: opts.yamlText,
    ...(opts.hostRoot !== undefined ? { hostRoot: opts.hostRoot } : {}),
    ...(opts.positionsRoot !== undefined ? { positionsRoot: opts.positionsRoot } : {}),
    persistent: true,
  });
  if (adopted) {
    return {
      adopted: true,
      names: adopted.resolvedCapabilities.map((c) => c.name),
      configs: Object.fromEntries(adopted.resolvedCapabilities.map((c) => [c.name, c.config])),
    };
  }
  return { adopted: false, names: readCapabilities(opts.yamlText), configs: {} };
}

// bob#214: the declared limits for `model` on `provider`: the provider block's
// own window when `model` is provider.model, else the provider.models entry
// for it. Undefined when that model declares no window.
export function declaredModelLimits(
  block: ProviderLimitsBlock,
  provider: string,
  yamlModel: string,
  model: string,
): ModelLimits | undefined {
  const declared = model === yamlModel ? block : block.models[model];
  if (declared?.contextWindow === undefined) return undefined;
  return {
    provider,
    model,
    contextWindow: declared.contextWindow,
    ...(declared.maxOutputTokens !== undefined
      ? { maxOutputTokens: declared.maxOutputTokens }
      : {}),
  };
}

// bob#214: the agent's session budget — bob.yaml's `session:` block over its
// role's role.json `session`, key by key. The role is read the same way the tool
// policy reads it (bob.yaml `agent.role`); a role that cannot be loaded is the
// same load error it is there.
export function resolveSessionBudget(yamlText: string): {
  compactionThreshold?: number;
  thinking?: ThinkingSetting;
} {
  const own = readSessionBudget(yamlText);
  const role = loadRole(readAgentRole(yamlText) as BobRole).session ?? {};
  const compactionThreshold = own.compactionThreshold ?? role.compactionThreshold;
  const thinking = own.thinking ?? role.thinking;
  return {
    ...(compactionThreshold !== undefined ? { compactionThreshold } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

// bob#279: the exploration budget for this agent — bob.yaml `run.exploration_budget`
// over the role's role.json `exploration_budget`. Undefined when neither sets one
// (the budget is OFF: a run that is meant to read and report is never told to
// edit). `builder-local` ships a role default of 20.
export function resolveExplorationBudget(yamlText: string): number | undefined {
  const own = readExplorationBudget(yamlText);
  const role = loadRole(readAgentRole(yamlText) as BobRole).exploration_budget;
  return own ?? role;
}

export function resolveRequireEditOrBlocked(yamlText: string): boolean {
  return loadRole(readAgentRole(yamlText) as BobRole).require_edit_or_blocked === true;
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
  const {
    provider,
    providerRecord: selectedRow,
    model: yamlModel,
  } = resolveProviderAndModel(yamlText, opts.name, opts.registry);

  // Per-call override wins, mirroring the old `--model` flag semantics.
  const model = opts.model ?? yamlModel;
  // bob#214: the declared limits of the model this session runs — bob.yaml's
  // provider.context_window for provider.model, or a provider.models entry for
  // a per-call override. Bound to the pair it describes; a model with no
  // declared window leaves this undefined, and the factory refuses that session
  // with the remedy.
  const modelLimits = declaredModelLimits(
    readProviderLimits(yamlText, opts.registry),
    provider,
    yamlModel,
    model,
  );
  const appendSystemPrompt = readSoul(agentDir);

  // The ONE effective-config resolver. For an ADOPTED agent (a host grant
  // exists) it applies the grant/position/override/secret layers through every
  // session entry path. For an agent with NO grant it returns undefined and the
  // ordinary resolution below is used untouched — that is what keeps an existing
  // `bob init` agent booting unchanged.
  const adopted = resolveAdoptedConfig({
    name: opts.name,
    agentDir,
    yamlText,
    ...(opts.hostRoot !== undefined ? { hostRoot: opts.hostRoot } : {}),
    ...(opts.positionsRoot !== undefined ? { positionsRoot: opts.positionsRoot } : {}),
    ...(opts.persistent !== undefined ? { persistent: opts.persistent } : {}),
  });

  let toolPolicy: ToolPolicy;
  let extensionSources: string[];
  let capabilityBySource: Record<string, string>;
  let capabilityEnv: Record<string, string>;
  let capabilities: ResolvedCapability[];
  if (adopted) {
    toolPolicy = {
      tools: adopted.tools,
      excludeTools: adopted.excludeTools,
      resident: adopted.resident,
      allowResidentShell: adopted.allowResidentShell,
    };
    extensionSources = adopted.extensionSources;
    capabilityBySource = adopted.capabilityBySource;
    capabilityEnv = adopted.capabilityEnv;
    // The grant-narrowed set (local disables applied), from the SAME resolution
    // as the extension sources above — never bob.yaml's raw capabilities: list.
    capabilities = adopted.resolvedCapabilities;
  } else {
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
    toolPolicy = resolveAgentToolPolicy(yamlText, { persistent: opts.persistent });
    extensionSources = resolution.extensionSources;
    capabilityBySource = Object.fromEntries(
      resolution.capabilities.map((c) => [c.piPackage, c.name]),
    );
    capabilityEnv = capabilityConfigEnv(resolution);
    capabilities = resolution.capabilities;
  }

  // bob#214: the session budget (bob.yaml `session:` over role.json `session`),
  // resolved after the tool policy so a config the policy already refuses is
  // reported by that refusal first.
  const budget = resolveSessionBudget(yamlText);
  // bob#279: the exploration budget (bob.yaml `run.exploration_budget` over
  // role.json `exploration_budget`), or undefined when neither sets one.
  const explorationBudget = resolveExplorationBudget(yamlText);
  // bob#283: the role's edit-or-blocked opt-in.
  const requireEditOrBlocked = resolveRequireEditOrBlocked(yamlText);

  // bob#200: a mail turn narrows the resolved policy to the mail allowlist. It is
  // applied HERE, after both branches, so it binds an ADOPTED agent's grant
  // tools exactly as it binds an ordinary agent's role tools: no branch can
  // hand a mail turn a tool outside MAIL_TURN_ALLOWED_TOOLS.
  if (opts.mailTurn) toolPolicy = applyMailTurnPolicy(toolPolicy);

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

  // bob#230: the agent's credential files, collected from bob's own parsed
  // config: the validated capability configs resolved above, and bob.yaml's
  // `identity:`/`flair:` blocks read with the same block reader. A failure is
  // carried as a reason, never as an empty list.
  const credentials = collectCredentialPaths({
    yamlText,
    capabilities,
    piAgentDir: join(agentDir, ".pi-agent"),
    workspaceRoot: join(agentDir, "work"),
  });

  // bob#254 — the Flair coordinates the session bootstrap calls at start, when
  // the agent configures the flair capability. Resolved here (sync) from the
  // SAME validated capability config the session loads; the async call happens
  // in each runtime entry path (runAgent, runLaunch, startPersistent).
  const flairBootstrapTarget = resolveFlairBootstrapTarget(capabilities, opts.name);

  const config: RunSessionConfig = {
    provider,
    providerRecord: selectedRow,
    model,
    appendSystemPrompt,
    cwd: join(agentDir, "work"),
    piAgentDir: join(agentDir, ".pi-agent"),
    extensionSources,
    capabilityBySource,
    capabilityEnv,
    ...(opts.taskBinding !== undefined ? { taskBinding: opts.taskBinding } : {}),
    // bob#230: the residency decision the policy made, and the credential files
    // from the SAME parsed + validated config the capabilities receive.
    resident: toolPolicy.resident,
    ...(credentials.ok
      ? { credentialPaths: credentials.paths }
      : { credentialPathsUnavailable: credentials.reason }),
    // Always both: resolveAgentToolPolicy refuses an agent without an
    // allowlist, so there is no longer a "declared none" case here.
    tools: toolPolicy.tools,
    excludeTools: toolPolicy.excludeTools,
    ...(modelLimits !== undefined ? { modelLimits } : {}),
    yamlModel: { provider, model: yamlModel },
    ...(budget.compactionThreshold !== undefined
      ? { compactionThreshold: budget.compactionThreshold }
      : {}),
    ...(budget.thinking !== undefined ? { thinking: budget.thinking } : {}),
  };
  return {
    agentDir,
    provider,
    model,
    config,
    cron: parseCron(yamlText),
    agent,
    policy: toolPolicy,
    capabilities,
    toolLoopLimit: readToolLoopLimit(yamlText) ?? DEFAULT_TOOL_LOOP_LIMIT,
    runLimits: readRunLimits(yamlText),
    ...(explorationBudget !== undefined ? { explorationBudget } : {}),
    ...(requireEditOrBlocked ? { requireEditOrBlocked: true as const } : {}),
    ...(flairBootstrapTarget !== undefined ? { flairBootstrapTarget } : {}),
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
// persistent runtime passes a durable manager rooted in piAgentDir/sessions
// (the working window; Flair remains the long-term store).
export async function createPiRunSession(
  config: RunSessionConfig,
  sessionManagerFactory?: (cwd: string) => SessionManagerLike,
  registry?: ProviderRegistry,
): Promise<RunSession> {
  assertToolPolicy(config);
  const policy: ToolPolicy = {
    tools: config.tools,
    // resolveToolPolicy already folded the resident exclusions into
    // excludeTools, so the factory's job is simply to hand pi the resolved pair.
    excludeTools: config.excludeTools ?? [],
    // bob#230: the RESOLVED residency decision — bob.yaml `resident: true` OR
    // the persistent runtime — never `persistent` alone, so a one-shot run of a
    // resident agent gets the confined read too.
    resident: config.resident === true || config.persistent === true,
    allowResidentShell: false,
  };
  const makeSessionManager =
    sessionManagerFactory ?? ((cwd: string) => SessionManager.inMemory(cwd));
  const factory = createBobRuntimeFactory({
    config,
    policy,
    ...(registry !== undefined ? { registry } : {}),
  });
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
// mapped to pi's provider id through the provider registry, the SAME table
// init.ts's scaffold reads.
// The provider/runtime-key refusal the session resolver applies, factored out so
// callers that write BEFORE a session exists (hire scaffolds and runs the
// interview) can run it up front and leave nothing behind on a missing key.
// `provider` is pi's provider id (already mapped by mapBobProviderToPi); `label`
// names the caller for the message (e.g. "bob run <name>").
export function assertProviderRunnable(
  provider: string,
  label: string,
  registry?: ProviderRegistry,
): void {
  // Resolve the SELECTED row (by its runtime identity, then by name), never the
  // runtime string alone: a keyed row's runtime need not be its id, so a name
  // lookup would miss it.
  const reg = registry ?? DEFAULT_PROVIDER_REGISTRY;
  const row =
    reg.records().find((candidate) => candidate.runtime === provider) ?? reg.find(provider);
  if (row === undefined || row.auth.kind !== "env") return;
  const variable = row.auth.variable;
  if ((process.env[variable] ?? "").trim()) return;
  if (providerKeyWasConsumed(variable)) {
    throw new Error(`${label}: ${providerKeyConsumedMessage(variable, row.id)}`);
  }
  throw new Error(
    row.id === "openrouter"
      ? `${label}: OPENROUTER_API_KEY is not set. Remedy: export OPENROUTER_API_KEY=<key> before running — bob never writes the key to bob.yaml or the pi config.`
      : `${label}: ${variable} is not set for provider row "${row.id}". Remedy: export ${variable}=<key> before running — bob never writes the key to bob.yaml or the pi config.`,
  );
}

function resolveProviderAndModel(
  yamlText: string,
  name: string,
  registry?: ProviderRegistry,
): { provider: string; providerRecord?: ProviderRecord; model: string } {
  const bobProvider = readProviderField(yamlText, "name");
  const model = declaredProviderModel(yamlText);
  if (!bobProvider || model === undefined) {
    throw new Error(`bob run ${name}: bob.yaml is missing provider.name and/or provider.model`);
  }
  const provider = mapBobProviderToPi(bobProvider, registry);
  // The openrouter key is read from the environment AT RUN TIME and never written
  // to bob.yaml or the pi config — so a missing key is a REFUSAL here, before any
  // request is made (bob#183). The check is shared with `bob hire`'s pre-write
  // validation so both refuse identically.
  assertProviderRunnable(provider, `bob run ${name}`, registry);
  return { provider, providerRecord: providerRecord(bobProvider, registry), model };
}

// provider.model as the session resolver reads it: the scalar text under
// `provider:`, surrounding quotes stripped; an empty value is not a model.
// Exported so `bob doctor` decides whether a model is declared the same way a
// session does (bob#225): `model: 123` is the model "123" to both.
export function declaredProviderModel(yamlText: string): string | undefined {
  const model = readProviderField(yamlText, "model");
  return model ? model : undefined;
}

function readProviderField(yamlText: string, key: string): string | undefined {
  const provider = parseBobYamlBlock(yamlText, "provider");
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
    return undefined;
  }
  const value = (provider as Record<string, unknown>)[key];
  if (value === null || value === undefined) return undefined;
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new Error(`bob: provider.${key} must be a scalar`);
  }
  const text = typeof value === "string" ? value.trim() : String(value).trim();
  return text === "" ? undefined : text.replace(/^["']|["']$/g, "");
}

// Map a bob provider name to pi's provider id, reading the provider registry:
// `exe-dev-gateway` is bob's term for "anthropic API shape via the exe.dev
// gateway", so its row's runtime identity is pi's `anthropic` (the gateway
// baseUrl override lives in .pi-agent/models.json). An undeclared name is its
// own runtime identity. Exported so onboarding/alignment map a caller's
// provider override through the same table.
export function mapBobProviderToPi(bobProvider: string, registry?: ProviderRegistry): string {
  return resolveRuntimeProviderName(bobProvider, registry);
}

// Read soul.md (the appended persona). Returns "" when absent so the session
// falls back to pi's default system prompt.
function readSoul(agentDir: string): string {
  const soulPath = join(agentDir, "soul.md");
  if (!existsSync(soulPath)) return "";
  return readFileSync(soulPath, "utf8");
}
