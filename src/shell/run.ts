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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { readAgentRole, readCron, readResident, readTools } from "./bob-yaml.js";
import { capabilityConfigEnv, resolveCapabilities } from "./capability-loader.js";
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
  // declares none. With round 3 this is the ONLY extension source that loads:
  // ambient pi extensions, skills and packages are not read at all.
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
  // must never break the run — hence appendRunLog swallows everything.
  const runsDir = join(agentDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const runLogPath = join(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  process.stderr.write(`run log: ${runLogPath}\n`);
  const appendRunLog = (record: unknown) => {
    try {
      appendFileSync(runLogPath, `${JSON.stringify(record)}\n`);
    } catch {
      // Best-effort: never throw from the logger (disk full, races, etc.).
    }
  };

  let captured = "";
  const unsubscribe = session.subscribe((event) => {
    // Post-mortem trail first: record EVERY event (tool calls, results, errors,
    // retries), not just text — that's what makes a death diagnosable.
    appendRunLog({ t: new Date().toISOString(), event });
    // Stream the assistant's text deltas — same event shape the SDK
    // quickstart and every examples/sdk/*.ts use. UNCHANGED: the captured
    // accumulation stays byte-identical so the returned final text is stable.
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      captured += event.assistantMessageEvent.delta;
    }
  });

  let exitCode = 0;
  try {
    // bob's own runner: the text IS the prompt (no command/template/skill
    // expansion — see session.ts promptSession).
    await promptSession(session, opts.prompt);
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

  // Final record so a reader can tell a clean completion from a truncated log.
  appendRunLog({ done: true, exitCode });

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
  return { agentDir, provider, model, config, cron: parseCron(yamlText), policy: toolPolicy };
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
