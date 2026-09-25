// `bob run <name> [prompt]` — invoke an onboarded agent for a short-lived,
// `claude -p`-style task: spin up a fresh session, send one prompt, capture
// the assistant's final text, exit.
//
// PHASE-1 MIGRATION: previously this spawned the agent's generated `bin/<name>`
// launcher as a subprocess (`exec pi --provider … --model …`). It now embeds pi
// via its SDK (`createAgentSession`/`AgentSession`) in-process. One embedded-pi
// path, no subprocess. The PERSISTENT variant (the agent keeps running) lives in
// persistent.ts and shares this file's session builder — `bob run` is the
// short-lived `-p`-style lifespan, persistent is the warm long-lived one. The
// remaining spawn sites (onboard/align launcher generation) migrate in later
// PRs — see the `// TODO(phase1): migrate to SDK` markers there.
//
// Config resolution mirrors the launcher `init.ts` generates exactly:
//   - provider + model come from ~/agents/<name>/bob.yaml (`provider:` block)
//   - soul.md is appended to pi's system prompt (--append-system-prompt
//     equivalent), preserving the agent's persona
//   - per-agent credentials live in ~/agents/<name>/.pi-agent/{auth,models}.json
//     (PI_CODING_AGENT_DIR in the old launcher) — we point pi's AuthStorage +
//     ModelRegistry at that dir so the exe-dev-gateway baseUrl override and
//     auth.json are honored without env juggling.
//
// Model override is per-call (`opts.model`): it replaces the bob.yaml model
// for this invocation only, same semantics as the old `--model` flag.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readCron } from "./bob-yaml.js";
import { capabilityConfigEnv, resolveCapabilities } from "./capability-loader.js";
import type { CronEntry } from "./index.js";

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
// DEFAULT_RUNLOG_CAP_BYTES: the per-run size cap. Once a single run's log
// reaches this, delta (message_update) events stop being written, but
// non-delta events — tool calls, results, errors, lifecycle, the done line —
// keep coming, and exactly one line records that the cap was hit.
const DEFAULT_RUNLOG_CAP_BYTES = 50 * 1024 * 1024; // 50 MB

// RUNLOG_KEEP / RUNLOG_BUDGET_BYTES: on run start, the newest RUNLOG_KEEP logs
// are always kept; older ones are deleted oldest-first once their combined size
// exceeds RUNLOG_BUDGET_BYTES. A log still being written is never touched
// (retention runs before the current run's file exists, and a live sibling's
// fresh mtime keeps it in the newest-K window).
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

// True when `logPath` has a sidecar lock (`<logPath>.lock`) that names a PID
// still alive — i.e. a run is still writing that log. Retention skips such logs
// (a live run's writer would keep writing to a path that is no longer on disk).
// A missing lock, or a lock whose PID is dead or unparseable, marks the run as
// finished, so the log is prunable like any other.
//
// `process.kill(pid, 0)` probes liveness without signaling the target: it throws
// ESRCH for a dead PID and EPERM for a live PID we can't signal (different uid),
// so "no throw, or EPERM" means the run is live.
function logHasLiveLock(logPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(`${logPath}.lock`, "utf8");
  } catch {
    // No readable lock -> the run is finished; the log is prunable.
    return false;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = a live PID we aren't allowed to signal (still alive). ESRCH = gone.
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

// Recursively drop every `partial` field from a value. Streamed `message_update`
// events carry `partial` — the whole assistant message so far, repeated and
// growing on every token — which is what made the run-log quadratic. The delta
// alone reconstructs the message and `message_end` carries the final one once, so
// dropping `partial` at any nesting level is safe and keeps the log linear.
function scrubPartial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubPartial);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === "partial") continue;
      out[k] = scrubPartial(v);
    }
    return out;
  }
  return value;
}

// A minimal view of what a `run` task needs from a pi AgentSession. Keeping
// our own slim type (rather than pi's full AgentSession) is what lets tests
// inject a fake session without standing up the whole SDK.
export interface RunSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
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
  // auth.json/models.json. pi's AuthStorage + ModelRegistry read from here.
  piAgentDir: string;
  // pi extension sources for the agent's declared capabilities, in order.
  // Each is an npm:/git:/local-path spec handed to pi's resource loader as an
  // `additionalExtensionPaths` entry (the SDK equivalent of settings.json
  // `packages`/`extensions`). Resolved from bob.yaml `capabilities:` against
  // the blessed catalog before the factory runs, so a fake factory in tests
  // doesn't need the catalog or filesystem. Empty when the agent declares none.
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
}

// The injectable seam. Production builds a real pi AgentSession; tests inject a
// fake that returns canned assistant text without any LLM call. Replaces the
// old `spawnFn` injection point.
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
  // Per-run run-log size cap in bytes (see DEFAULT_RUNLOG_CAP_BYTES). Past it,
  // delta (message_update) events stop being written; non-delta events (tool
  // calls, errors, lifecycle, the done line) keep coming. Tests set a small cap
  // to exercise the cap without writing gigabytes.
  runLogCapBytes?: number;
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

  const root = opts.agentsRoot ?? join(homedir(), "agents");
  const { agentDir, provider, model, config } = resolveRunConfig({
    name: opts.name,
    agentsRoot: root,
    model: opts.model,
  });

  const factory = opts.sessionFactory ?? createPiRunSession;
  const session = await factory(config);

  // Tee every session event to a per-run JSONL log so a mid-run death (e.g. an
  // ollama rate-limit/cap) is post-mortem-able instead of leaving no trace.
  // The filename is the run's start timestamp with `:`/`.` swapped so it's a
  // filesystem-safe name. Logging is strictly best-effort — a logging failure
  // must never break the run — and writeRunLog swallows everything.
  const runsDir = join(agentDir, "runs");
  mkdirSync(runsDir, { recursive: true });

  // Retention first: keep the newest few logs and delete older ones oldest-first
  // past a total budget, so a 15 GB / 40 GB disk can't silently fill a runs dir
  // and kill a long run. This runs BEFORE the current run's file is created, so
  // it never touches a run still being written.
  try {
    pruneOldRunLogs(runsDir, {});
  } catch {
    // Retention is best-effort; never let it abort the run.
  }

  const runLogPath = join(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  process.stderr.write(`run log: ${runLogPath}\n`);

  // Sidecar lock: while this run is writing its log it drops `<log>.lock`
  // holding its PID. Retention reads it to leave a live run's log alone (a
  // dead-PID lock means the run has finished). Removed at run end.
  const runLogLockPath = `${runLogPath}.lock`;
  try {
    appendFileSync(runLogLockPath, String(process.pid));
  } catch {
    // Best-effort: if we can't drop the lock, retention can't tell liveness and
    // treats the log as finished — the safe default.
  }

  // Synchronous writer: appendFileSync commits each record to disk before it
  // returns — exactly the post-mortem property this log exists for (a hard crash
  // leaves every record written before it on disk). With `partial` stripped each
  // record is small, so there is no per-write cost worth buffering. A failed
  // append (disk full, race, perms) is swallowed: logging is best-effort and must
  // never throw into the run.
  const capBytes = opts.runLogCapBytes ?? DEFAULT_RUNLOG_CAP_BYTES;
  let logBytes = 0; // running total of bytes committed to this log
  let capHit = false; // set once we cross the cap; then deltas stop

  // Write one log record.
  // - `isDelta` marks streamed message_update events: the only kind the cap drops,
  //   because their `partial` field (the whole message so far) made the log
  //   quadratic.
  // - message_update events are logged WITHOUT `partial`: the delta alone
  //   reconstructs the message and message_end carries the final message once.
  // - non-delta events (tool calls, results, errors, lifecycle, the done line) are
  //   ALWAYS written, even past the cap, so the log stays a faithful post-mortem.
  const writeRunLog = (record: unknown, isDelta: boolean): void => {
    try {
      let out: unknown = record;
      if (isDelta) {
        const rec = record as Record<string, unknown>;
        const ev = rec.event as Record<string, unknown> | undefined;
        if (ev) {
          const stripped = scrubPartial(ev) as Record<string, unknown>;
          // message_update also carries a growing shallow-copy `message` (its
          // content grows in place); drop it too — message_end carries the final
          // message once, so the log line keeps only the small delta.
          delete stripped.message;
          out = { ...rec, event: stripped };
        }
      }
      // Past the cap: drop deltas, keep everything else.
      if (isDelta && capHit) return;
      const line = `${JSON.stringify(out)}\n`;
      const n = Buffer.byteLength(line);
      appendFileSync(runLogPath, line);
      logBytes += n;
      if (!capHit && logBytes >= capBytes) {
        // One line, ever, recording that the per-run cap was hit.
        capHit = true;
        const capLine = `${JSON.stringify({
          t: new Date().toISOString(),
          cap: true,
          bytes: logBytes,
          capBytes,
        })}\n`;
        appendFileSync(runLogPath, capLine);
        logBytes += Buffer.byteLength(capLine);
      }
    } catch {
      // Best-effort: never throw from the logger (disk full, races, etc.).
    }
  };

  let captured = "";
  const unsubscribe = session.subscribe((event) => {
    // Post-mortem trail first: record EVERY event (tool calls, results, errors,
    // retries), not just text — that's what makes a death diagnosable.
    writeRunLog({ t: new Date().toISOString(), event }, event.type === "message_update");
    // Stream the assistant's text deltas — same event shape the SDK
    // quickstart and every examples/sdk/*.ts use. UNCHANGED: the captured
    // accumulation stays byte-identical so the returned final text is stable.
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      captured += event.assistantMessageEvent.delta;
    }
  });

  let exitCode = 0;
  try {
    try {
      await session.prompt(opts.prompt);
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
      unsubscribe();
    }

    // Final record, so a reader can tell a clean completion from a truncated log.
    // A synchronous append is on disk when writeRunLog returns, so a mid-run crash
    // leaves every record written before it — the post-mortem trail this log exists
    // for.
    writeRunLog({ done: true, exitCode }, false);
  } finally {
    // Run end: drop the sidecar lock so retention no longer sees this log as
    // live. Best-effort — a leaked lock names a now-dead PID, which the next
    // sweep treats as finished.
    try {
      unlinkSync(runLogLockPath);
    } catch {
      // best-effort: the lock may already be gone
    }
  }

  // Fallback: if no text_delta events were observed (some transports don't
  // stream), pull the last assistant text from session state.
  if (captured.length === 0) {
    const fromState = lastAssistantText(session);
    if (fromState !== undefined) captured = fromState;
  }

  session.dispose();

  return {
    exitCode,
    agentDir,
    provider,
    model,
    ...(opts.captureStdout ? { stdout: captured } : {}),
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
}

export interface ResolvedRunConfig {
  agentDir: string;
  provider: string;
  model: string;
  config: RunSessionConfig;
  // bob.yaml `cron:` entries (validated). Only the PERSISTENT runtime uses
  // these (it schedules them into the live session); `bob run` ignores them.
  cron: CronEntry[];
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
  };
  return { agentDir, provider, model, config, cron: parseCron(yamlText) };
}

// The minimum of pi's resource loader this check needs. Structural so tests can
// hand in a stub without constructing a real loader.
export interface ExtensionErrorSource {
  getExtensions(): { errors: Array<{ path: string; error: string }> };
}

// Fail the session if any capability's extension didn't load.
//
// pi records extension load failures on the loader and CONTINUES — the agent
// comes up, just without those tools. That silence is precisely what let a
// catalog full of unresolvable paths ship: nothing anywhere said "discord did
// not load". Bob asked for these extensions explicitly, so for Bob they are not
// optional. Errors from extensions Bob didn't ask for (a user's own settings.json
// packages) are pi's business and are left alone.
export function assertCapabilitiesLoaded(
  loader: ExtensionErrorSource,
  config: Pick<RunSessionConfig, "extensionSources" | "capabilityBySource">,
): void {
  if (config.extensionSources.length === 0) return;
  const ours = new Set(config.extensionSources);
  const failures = (loader.getExtensions().errors ?? []).filter((e) => ours.has(e.path));
  if (failures.length === 0) return;

  const lines = failures.map((f) => {
    const name = config.capabilityBySource?.[f.path];
    const who = name ? `capability "${name}"` : "capability";
    return `  ${who} (${f.path}): ${f.error}`;
  });
  throw new Error(
    [
      `bob: ${failures.length} declared capabilit${failures.length === 1 ? "y" : "ies"} failed to load:`,
      ...lines,
      "",
      "The agent would have started without those tools. Fix the capability or remove",
      "it from capabilities: in bob.yaml rather than running under-equipped.",
    ].join("\n"),
  );
}

// Real SDK factory: stand up a fresh, in-memory pi AgentSession for the agent,
// scoped to its own .pi-agent credentials dir and work cwd, with soul.md
// appended to the system prompt. In-memory session manager = ephemeral (a
// `run` task is short-lived; nothing to persist).
//
// Exported so the persistent runtime can build the SAME session via the
// `persistentSession` factory wrapper (which swaps the SessionManager for a
// durable one). Keeping a single builder here is the "one embedded-pi path"
// the spec mandates.
//
// `sessionManagerFactory` lets a caller supply the SessionManager — the
// ephemeral `run` path defaults to in-memory (nothing to persist); the
// persistent runtime passes `SessionManager.create(cwd)` so the warm session is
// durable on disk (the working window; Flair remains the long-term store).
export async function createPiRunSession(
  config: RunSessionConfig,
  sessionManagerFactory?: (cwd: string) => SessionManagerLike,
): Promise<RunSession> {
  // Point auth + model resolution at the agent's own .pi-agent dir, exactly
  // like the old launcher's PI_CODING_AGENT_DIR export. This honors the
  // exe-dev-gateway baseUrl override (models.json) and auth.json. pi 0.84.x
  // consolidates the old AuthStorage + ModelRegistry pair into a single
  // ModelRuntime (the "canonical model/auth runtime"); ModelRuntime.create is
  // async (the old sync constructors are gone), so we await it. allowModelNetwork
  // defaults false, so create() does no network catalog fetch — static built-ins
  // plus the agent's models.json customs are available for lookup immediately.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(config.piAgentDir, "auth.json"),
    modelsPath: join(config.piAgentDir, "models.json"),
  });

  // getModel() resolves both built-in models and custom ones from models.json,
  // synchronously and without requiring a valid API key at lookup time — the
  // runtime is already configured with the agent's models.json, so this is the
  // models.json-aware lookup (NOT pi-ai's standalone getModel(), which wouldn't
  // see the agent's custom exe-dev-gateway model). Same contract as the old
  // ModelRegistry.find().
  const model = modelRuntime.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(
      `model not found: ${config.provider}/${config.model} (check bob.yaml provider/model and ${config.piAgentDir}/models.json)`,
    );
  }

  // Append soul.md to pi's system prompt — the SDK equivalent of the old
  // launcher's `--append-system-prompt "$(cat soul.md)"`. When there's no
  // soul we leave the default prompt untouched.
  const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd: config.cwd,
    agentDir: config.piAgentDir,
  };
  if (config.appendSystemPrompt.length > 0) {
    loaderOpts.appendSystemPromptOverride = (base) => [...base, config.appendSystemPrompt];
  }
  // Compose the agent's capabilities into the session. Each is a pi extension
  // source (npm:/git:/local path); pi's resource loader resolves + loads them,
  // exposing their tools/hooks. This is the SDK equivalent of settings.json
  // `packages`/`extensions`. pi owns the rest.
  if (config.extensionSources.length > 0) {
    loaderOpts.additionalExtensionPaths = config.extensionSources;
  }
  // Hand each capability its validated config via the env var it reads. The
  // extensions are loaded in-process (jiti) by reload() below, so they see
  // these immediately. Config only — no secrets (see RunSessionConfig).
  for (const [key, value] of Object.entries(config.capabilityEnv)) {
    process.env[key] = value;
  }
  // Runtime-mode signal for "serving" capabilities (discord's inbound gateway):
  // set BEFORE the extensions load. "1" only for the persistent runtime; a
  // one-shot run clears it so capabilities stay outbound-only.
  process.env.BOB_PERSISTENT = config.persistent ? "1" : "";
  const resourceLoader = new DefaultResourceLoader(loaderOpts);
  await resourceLoader.reload();
  assertCapabilitiesLoaded(resourceLoader, config);

  const makeSessionManager =
    sessionManagerFactory ?? ((cwd: string) => SessionManager.inMemory(cwd));
  const { session } = await createAgentSession({
    cwd: config.cwd,
    agentDir: config.piAgentDir,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: makeSessionManager(config.cwd) as ReturnType<typeof SessionManager.inMemory>,
  });

  return session as unknown as RunSession;
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
  return { provider: resolvePiProvider(bobProvider), model };
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

// Mirror of init.ts's resolvePiProvider: `exe-dev-gateway` is bob's term for
// "anthropic API shape via the exe.dev gateway"; pi only knows `anthropic`
// (the gateway baseUrl override lives in .pi-agent/models.json).
function resolvePiProvider(bobProvider: string): string {
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
