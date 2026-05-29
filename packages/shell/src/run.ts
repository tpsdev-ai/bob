// `bob run <name> [prompt]` — invoke an onboarded agent for a short-lived,
// `claude -p`-style task: spin up a fresh session, send one prompt, capture
// the assistant's final text, exit.
//
// PHASE-1 MIGRATION (this PR): previously this spawned the agent's generated
// `bin/<name>` launcher as a subprocess (`exec pi --provider … --model …`).
// It now embeds pi via its SDK (`createAgentSession`/`AgentSession`) in-process.
// One embedded-pi path, no subprocess. The other spawn sites
// (onboard/align/mail-consumer/discord-serve/init launcher generation) migrate
// in later PRs — see the `// TODO(phase1): migrate to SDK` markers there.
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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { resolveCapabilities } from "./capability-loader.js";

// Same regex as init.ts AGENT_NAME — names are filesystem paths, keep them
// strict-safe (no `..`, no `/`, no newlines).
const AGENT_NAME = /^[a-z0-9-]+$/;

// A minimal view of what a `run` task needs from a pi AgentSession. Keeping
// our own slim type (rather than pi's full AgentSession) is what lets tests
// inject a fake session without standing up the whole SDK.
export interface RunSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  // Best-effort final assistant text, used as a fallback when no text_delta
  // events were observed (e.g. providers/transports that don't stream).
  readonly messages?: ReadonlyArray<unknown>;
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
  const agentDir = join(root, opts.name);
  if (!existsSync(agentDir)) {
    throw new Error(
      `bob run ${opts.name}: agent dir not found at ${agentDir} (run 'bob onboard ${opts.name}' first)`,
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
  // under-equipped agent. Produces the pi extension sources the session loads.
  const { extensionSources } = resolveCapabilities({ yamlText });

  const config: RunSessionConfig = {
    provider,
    model,
    appendSystemPrompt,
    cwd: join(agentDir, "work"),
    piAgentDir: join(agentDir, ".pi-agent"),
    extensionSources,
  };

  const factory = opts.sessionFactory ?? createPiRunSession;
  const session = await factory(config);

  let captured = "";
  const unsubscribe = session.subscribe((event) => {
    // Stream the assistant's text deltas — same event shape the SDK
    // quickstart and every examples/sdk/*.ts use.
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      captured += event.assistantMessageEvent.delta;
    }
  });

  let exitCode = 0;
  try {
    await session.prompt(opts.prompt);
  } catch (_err) {
    exitCode = 1;
  } finally {
    unsubscribe();
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

// Real SDK factory: stand up a fresh, in-memory pi AgentSession for the agent,
// scoped to its own .pi-agent credentials dir and work cwd, with soul.md
// appended to the system prompt. In-memory session manager = ephemeral (a
// `run` task is short-lived; nothing to persist).
async function createPiRunSession(config: RunSessionConfig): Promise<RunSession> {
  // Point auth + model resolution at the agent's own .pi-agent dir, exactly
  // like the old launcher's PI_CODING_AGENT_DIR export. This honors the
  // exe-dev-gateway baseUrl override (models.json) and auth.json.
  const authStorage = AuthStorage.create(join(config.piAgentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(config.piAgentDir, "models.json"));

  // find() resolves both built-in models and custom ones from models.json,
  // without requiring a valid API key at lookup time. We deliberately use
  // find() over pi-ai's getModel() — getModel/Model aren't re-exported from
  // the main package and pi-ai is only a transitive dep.
  const model = modelRegistry.find(config.provider, config.model);
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
  const resourceLoader = new DefaultResourceLoader(loaderOpts);
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: config.cwd,
    agentDir: config.piAgentDir,
    model,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(config.cwd),
  });

  return session as unknown as RunSession;
}

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
