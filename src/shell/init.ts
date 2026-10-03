// `bob init` — bootstrap a new Bob-shaped agent on disk.
//
// PR-2 lands the directory + file generation. Flair pair (Ed25519 key
// + Agent record) is PR-3; mail consumer is PR-4; Discord+cron are PR-5+.
//
// Layout written:
//   ~/agents/<name>/
//     ├── bob.yaml         # canonical config (tps-mail left commented: it
//     │                    #   needs a senders: allow-list onboard cannot know)
//     ├── soul.md             # role's seed soul (caller-editable)
//     ├── bin/<name>          # generated launcher
//     ├── work/               # working dir (empty)
//     ├── memory/             # local memory cache (empty)
//     └── .pi-agent/          # pi-coding-agent state (empty; populated on first run)

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerBaseUrlRefusal } from "./bob-yaml.js";
import { lookupCapability } from "./capability-catalog.js";
import { type FlairPairResult, flairPair } from "./flair-pair.js";
import type { BobRole } from "./index.js";
import {
  DEFAULT_PROVIDER_REGISTRY,
  PROVIDER_API_OPENAI_COMPLETIONS,
  type ProviderRegistry,
  providerApiFlavour,
  providerEndpoint,
  providerReadsKeyFromEnv,
  providerUsesGatewayIdentity,
  resolveRuntimeProviderName,
} from "./provider-registry.js";
import { loadRole } from "./role-loader.js";
import { PI_BUILTIN_TOOLS } from "./tool-allowlist.js";

// Same character class loadRole uses — agent names are filesystem paths,
// keep them strict-safe.
const AGENT_NAME = /^[a-z0-9-]+$/;

// The capabilities `bob init` stamps into every new agent's bob.yaml. One
// constant, so the capabilities: list and the allowlist computed from it cannot
// drift apart.
export const STAMPED_CAPABILITIES: readonly string[] = ["flair"];

// The allowlist a fresh agent is stamped with: the role's ceiling INTERSECTED
// with the tools that can actually exist for this agent — pi's built-ins plus
// the tools of the capabilities being stamped. Anything the role allows that no
// stamped capability provides (or pi ships) is dropped, so a fresh agent of
// every role starts with a policy that loads: a stamped agent never boots with
// an allowlisted name nothing can register.
export function stampedToolAllowlist(
  roleCeiling: readonly string[],
  capabilities: readonly string[] = STAMPED_CAPABILITIES,
): string[] {
  const resolvable = new Set<string>(PI_BUILTIN_TOOLS);
  for (const name of capabilities) {
    for (const tool of lookupCapability(name)?.manifest.provides?.tools ?? []) {
      resolvable.add(tool);
    }
  }
  return roleCeiling.filter((name) => resolvable.has(name));
}

// Flair connection defaults shared by bob.yaml and the launcher. Stock
// `flair init` serves HTTP on 19926 (flair cli.ts DEFAULT_PORT) — the old
// :9926 default here pointed every fresh agent at a dead port (#90; same
// bug as tpsdev-ai/flair#1347 in pi-flair).
export const DEFAULT_FLAIR_URL = "http://127.0.0.1:19926";

// Where the agent's Ed25519 private key lives, in bob.yaml's `~` form.
// The launcher swaps `~` for `$HOME` (expanded at runtime, not render time).
function flairKeyFile(name: string): string {
  return `~/.flair/keys/${name}.key`;
}

export interface InitOptions {
  name: string;
  role: BobRole;
  provider: string;
  model: string;
  // Where the agent lives. Defaults to ~/agents/<name>/. Tests override.
  agentsRoot?: string;
  // Used for the launcher's PATH hint. Defaults to the Bun runtime we expect.
  bunPath?: string;
  // If true, refuse to overwrite an existing agent dir. Defaults to true.
  noClobber?: boolean;
  // Where Ed25519 keys live. Defaults to ~/.flair/keys/. Tests override.
  // When undefined AND skipFlair is false, defaults apply.
  flairKeysDir?: string;
  // If true, skip Ed25519 keypair generation entirely. For dry-runs or
  // hostless tests that don't want the .flair dir polluted.
  skipFlair?: boolean;
  // Flair REST base URL baked into bob.yaml + the launcher. Defaults to
  // DEFAULT_FLAIR_URL. Set it when the agent belongs to a hub rather than a
  // local spoke.
  flairUrl?: string;
  // The capabilities: list to stamp (defaults to STAMPED_CAPABILITIES). A
  // position materializes its own default capability set here.
  capabilities?: readonly string[];
  // The tools: allowlist to stamp (defaults to the role's ceiling intersected
  // with the tools the stamped capabilities can provide). A position supplies
  // its own requested tool set.
  toolAllow?: readonly string[];
  // The persona BODY to write under the identity header (defaults to the role's
  // template soul). A position supplies its packaged soul here, so the seed soul
  // is the agent's OWN identity plus the position's persona — never the generic
  // role template alone.
  soulBody?: string;
  // bob#214: the context window (tokens) the server enforces for `model`,
  // written to bob.yaml as provider.context_window. Every session refuses to
  // start without one, so an agent scaffolded without it gets a commented
  // placeholder and a warning, and must have it set before it runs.
  contextWindow?: number;
  baseUrl?: string;
  // The provider registry the scaffold reads its identity records from.
  // Defaults to the built-in table; tests supply one with a row of their own.
  registry?: ProviderRegistry;
}

export interface InitResult {
  agentDir: string;
  files: string[];
  // Populated unless skipFlair=true. Registration with Flair is a
  // separate step (registerWithFlair) — initAgent only generates the
  // keypair on disk to keep the function sync + filesystem-only.
  flair?: FlairPairResult;
  // The Flair wiring this scaffold actually emitted, so the caller registers
  // against the SAME url/key it wrote into bob.yaml and the launcher instead
  // of re-deriving the defaults and drifting from them. Undefined when
  // skipFlair=true. `keyFile` is bob.yaml's `~`-prefixed form; `keyPath` is
  // the absolute path on this machine.
  flairConfig?: {
    url: string;
    agentId: string;
    keyFile: string;
    keyPath: string;
  };
}

export function initAgent(opts: InitOptions): InitResult {
  if (!AGENT_NAME.test(opts.name)) {
    throw new Error(`invalid agent name: ${opts.name} (must match ${AGENT_NAME})`);
  }
  if (
    opts.contextWindow !== undefined &&
    (!Number.isSafeInteger(opts.contextWindow) || opts.contextWindow <= 0)
  ) {
    throw new Error(
      `bob: the context window must be a positive whole number of tokens (got ${String(opts.contextWindow)})`,
    );
  }
  if (opts.baseUrl !== undefined) {
    const refusal = providerBaseUrlRefusal(
      opts.provider,
      opts.baseUrl,
      opts.registry ?? DEFAULT_PROVIDER_REGISTRY,
    );
    if (refusal !== undefined) throw new Error(`bob: ${refusal}`);
    opts = { ...opts, baseUrl: new URL(opts.baseUrl).href };
  }
  // Validates the role + loads the template. Throws on unknown / unsafe role.
  const template = loadRole(opts.role);
  const root = opts.agentsRoot ?? join(homedir(), "agents");
  const agentDir = join(root, opts.name);
  const noClobber = opts.noClobber !== false;

  if (existsSync(agentDir) && noClobber) {
    throw new Error(`agent dir already exists: ${agentDir} (pass --force to overwrite)`);
  }

  const written: string[] = [];

  // Top-level + subdirs
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  mkdirSync(join(agentDir, "work"), { recursive: true });
  mkdirSync(join(agentDir, "memory"), { recursive: true });
  mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });

  // soul.md (identity header + role template; user editable). The role
  // template only describes the ROLE — the header stamps WHO the agent is
  // (name, id, role), so a --no-interactive agent still boots knowing its
  // own identity (#89). The hiring interview overwrites the file with a
  // refined persona; this header is the floor, not the ceiling.
  const soulPath = join(agentDir, "soul.md");
  writeFileSync(soulPath, renderSoulIdentityHeader(opts) + (opts.soulBody ?? template.soul));
  written.push(soulPath);

  // bob.yaml — canonical config. The tools: allowlist is the role's ceiling
  // intersected with the tools that can actually exist here (pi's built-ins +
  // the stamped capabilities' tools), so a freshly initialised agent of EVERY
  // role loads with a policy that holds.
  const yamlPath = join(agentDir, "bob.yaml");
  writeFileSync(
    yamlPath,
    renderBobYaml(
      opts,
      opts.toolAllow !== undefined
        ? [...opts.toolAllow]
        : stampedToolAllowlist(template.tools.allow),
      opts.capabilities ?? STAMPED_CAPABILITIES,
    ),
  );
  written.push(yamlPath);

  // .pi-agent/{models.json,auth.json} — required for pi 0.75+ to find
  // credentials AND resolve the model when PI_CODING_AGENT_DIR is set
  // (launcher exports it). Written for every provider — see
  // writePiAgentConfig's doc comment for why bare baseUrl configs aren't
  // enough for `bob run`.
  written.push(...writePiAgentConfig(opts, agentDir));
  if (opts.contextWindow === undefined) {
    console.error(
      `⚠ Set provider.context_window in ${yamlPath} before running — bob refuses to start a session without the model's context window.`,
    );
  }

  // bin/<name> launcher
  const binPath = join(agentDir, "bin", opts.name);
  writeFileSync(binPath, renderLauncher(opts));
  chmodSync(binPath, 0o755);
  written.push(binPath);

  // Flair Ed25519 keypair. Registration is a separate ASYNC step — initAgent
  // stays sync + filesystem-only — but it is no longer an OPTIONAL one: the
  // caller (cli.ts's onboard) runs provisionFlairIdentity() with the
  // flairConfig returned below, and fails loudly if it cannot. Leaving a key
  // on disk with no Agent record is the defect of #93.
  let flair: FlairPairResult | undefined;
  let flairConfig: InitResult["flairConfig"];
  if (!opts.skipFlair) {
    flair = flairPair({
      name: opts.name,
      keysDir: opts.flairKeysDir,
    });
    written.push(flair.privateKeyPath, flair.publicKeyPath);
    flairConfig = {
      url: flairUrlFor(opts),
      agentId: opts.name,
      keyFile: flairKeyFile(opts.name),
      keyPath: flair.privateKeyPath,
    };
  }

  return { agentDir, files: written, flair, flairConfig };
}

// Single resolution point for the agent's Flair URL: bob.yaml, the launcher's
// FLAIR_URL export, and the registration the caller performs all read THIS, so
// none of them can drift from the others.
function flairUrlFor(opts: Pick<InitOptions, "flairUrl">): string {
  return opts.flairUrl ?? DEFAULT_FLAIR_URL;
}

function renderBobYaml(
  opts: InitOptions,
  toolsAllow: string[],
  capabilities: readonly string[],
): string {
  // Hand-rolled to avoid pulling in a yaml dependency for the surface PR.
  // PR-3 (Flair pair) will swap in a real yaml emitter.
  const tools = toolsAllow.map((t) => `    - ${t}`).join("\n");
  return `# Bob config — generated by 'bob init'. Edit freely.
agent:
  id: ${opts.name}
  name: ${capitalize(opts.name)}
  role: ${opts.role}

provider:
  name: ${opts.provider}
  model: ${opts.model}
${
  opts.contextWindow !== undefined
    ? `  # The context window the server enforces for this model (tokens).
  context_window: ${opts.contextWindow}`
    : `  # REQUIRED before this agent runs: the context window (tokens) the server
  # enforces for this model. bob refuses to start a session without it.
  # context_window: <tokens>`
}${
  opts.baseUrl !== undefined
    ? `
  base_url: ${opts.baseUrl}`
    : ""
}

identity:
  # Ed25519 keypair on disk + the Flair Agent record registered at onboard.
  flair_url: ${flairUrlFor(opts)}
  key_file: ${flairKeyFile(opts.name)}
  pub_file: ~/.flair/keys/${opts.name}.pub

# TPS mail is OFF until you configure it (bob#200). To let this agent answer
# TPS mail, add tps-mail to capabilities: below and uncomment this block.
# senders: is REQUIRED and is the trust boundary: exact TPS agent ids, no globs.
# Allow-listing a sender grants it this agent's read scope (what a mail turn can
# read — its Flair memory — can end up in the reply), so list only principals
# already entitled to it.
# tps-mail:
#   inbox: ~/.tps/mail/${opts.name}
#   senders:
#     - <sender-id>

# Add cron entries here:
# cron:
#   - name: morning_briefing
#     schedule: "0 9 * * *"
#     prompt: "Compose Nathan's morning briefing."

tools:
  allow:
${tools}

capabilities:
${capabilities.map((c) => `  - ${c}`).join("\n")}

flair:
  url: ${flairUrlFor(opts)}
  agentId: ${opts.name}
  keyFile: ${flairKeyFile(opts.name)}
`;
}

// Identity header stamped above the role template in soul.md (#89).
// soul.md is the only thing the launcher/run.ts feed the model
// (--append-system-prompt), so if the name/id aren't HERE, the agent
// doesn't know who it is — it can only guess from cwd or how it's
// addressed. Mirrors the hiring interview's framing (onboard.ts
// META_PROMPT: a new agent named "<name>" in the "<role>" role).
function renderSoulIdentityHeader(opts: InitOptions): string {
  const displayName = capitalize(opts.name);
  return `# You are ${displayName} (\`${opts.name}\`)

You are ${displayName}, a new agent hired into the \`${opts.role}\` role; your Flair agent id is \`${opts.name}\`.

`;
}

function renderLauncher(opts: InitOptions): string {
  // sh shebang (NOT zsh) — re-sourcing ~/.zshenv on every invocation
  // clobbers env-prefix calls like FOO=bar <agent>. See
  // feedback_shebang_env_prefix in flint's memory.
  return `#!/bin/sh
# Generated by 'bob init'. Don't edit — re-run init to update.
# Edit ~/agents/${opts.name}/bob.yaml for config changes.

AGENT_DIR=${homedirEscape()}/agents/${opts.name}
export PI_CODING_AGENT_DIR="$AGENT_DIR/.pi-agent"
${renderLauncherFlairEnv(opts)}
# Identity for any git commits the agent makes
export GIT_AUTHOR_NAME="${capitalize(opts.name)}"
export GIT_AUTHOR_EMAIL="${opts.name}@tps.dev"
export GIT_COMMITTER_NAME="${capitalize(opts.name)}"
export GIT_COMMITTER_EMAIL="${opts.name}@tps.dev"

# Optional GitHub PAT for intel-gathering (releases.atom polling, REST API).
# Sourced from a 0600 file so the token never lands in process listings or
# env-dump output. If the file is missing the agent still runs — GitHub
# anonymous calls just get the ~60/hr rate limit instead of 5000/hr.
GH_PAT_FILE="$HOME/.tps/secrets/${opts.name}-github-pat"
if [ -r "$GH_PAT_FILE" ]; then
  GH_TOKEN=$(cat "$GH_PAT_FILE")
  export GH_TOKEN
fi

cd "$AGENT_DIR/work"
# EVERY session starts through \`bob launch\`, which resolves THIS agent's tool
# policy (role.json is the ceiling, bob.yaml narrows it) and builds the session
# itself — pi's SDK, in this process. bob launch takes at most ONE prompt and
# nothing else: "$@" is passed after --, so a prompt (even one starting with
# "-") arrives intact and anything that looks like a flag is refused by name.
#
# BOB_BIN picks which bob runs the session (a service unit with a minimal PATH,
# or a test). It defaults to \`bob\` on PATH; if that is missing the exec fails
# loudly, which is the right failure — no session rather than a session with no
# policy.
exec "\${BOB_BIN:-bob}" launch ${opts.name} -- "$@"
`;
}

// Flair env for the launcher (#90). pi-flair reads exactly these three
// vars — FLAIR_URL / FLAIR_AGENT_ID / FLAIR_KEY_PATH (verified against
// packages/pi-flair/src/index.ts on tpsdev-ai/flair main) — to sign
// requests as THIS agent; without them it guesses an identity from cwd
// (or errors) and the agent can't reach its own memory. Values mirror
// bob.yaml's flair block. skipFlair means no key was generated, so we
// omit the whole block rather than export paths to nothing.
function renderLauncherFlairEnv(opts: InitOptions): string {
  if (opts.skipFlair) return "";
  const keyPath = flairKeyFile(opts.name).replace(/^~/, "$HOME");
  return `
# Flair memory (pi-flair) — scope reads/writes to this agent's own identity.
export FLAIR_AGENT_ID="${opts.name}"
export FLAIR_URL="${flairUrlFor(opts)}"
export FLAIR_KEY_PATH="${keyPath}"
`;
}

// A bob provider name resolves to pi's provider id through the provider
// registry (`runtime`), not a mapper here: `exe-dev-gateway` is bob's term for
// "anthropic API shape, routed through the exe.dev VM-authenticated proxy", so
// it shares pi's `anthropic` runtime identity while its baseUrl override lives
// in .pi-agent/models.json (see writePiAgentConfig).

// pi 0.75+ reads its config from $PI_CODING_AGENT_DIR (the per-agent
// dir the launcher exports). Without these two files, the launcher
// fails at first invocation with either "No API key found for <provider>"
// (auth.json missing) or "model not found" from pi-coding-agent's
// ModelRegistry.find(provider, model) — which requires the model to be
// DECLARED under providers.<provider>.models, not just a bare baseUrl.
//
// We ALWAYS write both files for ANY provider, because `bob run` resolves
// models strictly (unlike pi's bare launcher, which tolerates a custom id
// with no declaration). Declaring the model is the core fix here.
//
// - envKey rows omit models.json and auth.json provider entries.
// - Disk-backed providers declare models = [{ id: opts.model }].
//   baseUrl uses provider.base_url or the row's optional endpoint.
// - auth.json: exe-dev-gateway gets its VM-identity placeholder key (the
//   literal value is never checked — the gateway authenticates via VM
//   identity). Endpoint overrides get bob's constant placeholder.

// The OpenAI-compatible provider shape for ollama.com/v1 (bob#132): pi drops a
// custom provider block that has no `api`. bob also writes the model's fields;
// bob.yaml can override the limits at session creation (bob#214).
const PI_MODEL_DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_MODEL_DEFAULT_MAX_TOKENS = 16_384;

/** The full model entry for an OpenAI-compatible provider (cost is zero: bob
 *  does not track this provider's pricing, so pi reports $0 for it). */
export function piOpenAiCompletionsModel(
  opts: Pick<InitOptions, "model" | "contextWindow">,
): Record<string, unknown> {
  return {
    id: opts.model,
    name: opts.model,
    reasoning: false,
    input: ["text"],
    contextWindow: opts.contextWindow ?? PI_MODEL_DEFAULT_CONTEXT_WINDOW,
    maxTokens: PI_MODEL_DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function writePiAgentConfig(opts: InitOptions, agentDir: string): string[] {
  const piDir = join(agentDir, ".pi-agent");
  // mkdirSync above already created it; defensive recreate in case caller
  // didn't go through the standard path.
  mkdirSync(piDir, { recursive: true });

  const registry = opts.registry ?? DEFAULT_PROVIDER_REGISTRY;
  const piProvider = resolveRuntimeProviderName(opts.provider, registry);
  const isGateway = providerUsesGatewayIdentity(opts.provider, registry);
  // `openrouter`'s key is read from the OPENROUTER_API_KEY env var AT RUN TIME and
  // is NEVER written here (bob#183) — so its auth.json carries no key entry.
  const isEnvKeyProvider = providerReadsKeyFromEnv(opts.provider, registry);
  // OpenAI-compatible providers also get `api`, `compat` and an explicit model
  // entry (bob#132).
  const isOpenAiCompatible =
    providerApiFlavour(opts.provider, registry) === PROVIDER_API_OPENAI_COMPLETIONS ||
    opts.baseUrl !== undefined;
  const baseUrl = opts.baseUrl ?? providerEndpoint(opts.provider, registry);
  const key =
    opts.baseUrl !== undefined
      ? "bob-base-url-placeholder-not-a-secret"
      : isGateway
        ? "exe-gateway-placeholder"
        : "REPLACE_WITH_YOUR_API_KEY";

  const modelsPath = join(piDir, "models.json");
  const authPath = join(piDir, "auth.json");

  // openrouter is bob's OWN provider (bob#183 round 3): its endpoint and its
  // model declaration are constructed IN MEMORY at session creation, and an
  // on-disk openrouter entry is REFUSED — so bob writes NO openrouter provider
  // block here. Every other provider still declares its model on disk.
  const providers = isEnvKeyProvider
    ? {}
    : {
        [piProvider]: {
          ...(baseUrl ? { baseUrl } : {}),
          ...(isOpenAiCompatible
            ? {
                api: PROVIDER_API_OPENAI_COMPLETIONS,
                compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
              }
            : {}),
          models: [
            isOpenAiCompatible
              ? piOpenAiCompletionsModel(opts)
              : { id: opts.model, name: opts.model },
          ],
        },
      };
  writeFileSync(modelsPath, `${JSON.stringify({ providers }, null, 2)}\n`);
  writeFileSync(
    authPath,
    `${JSON.stringify(isEnvKeyProvider ? {} : { [piProvider]: { type: "api_key", key } }, null, 2)}\n`,
  );
  chmodSync(authPath, 0o600);

  if (isEnvKeyProvider) {
    console.error(`⚠ Export OPENROUTER_API_KEY before running — bob never writes the key to disk.`);
  } else if (!isGateway && opts.baseUrl === undefined) {
    console.error(
      `⚠ Set your ${opts.provider} API key in ${join(agentDir, ".pi-agent", "auth.json")} before running.`,
    );
  }

  return [modelsPath, authPath];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function homedirEscape(): string {
  // Launcher script reads $HOME at runtime, not at generation time —
  // makes the launcher portable across users / hostnames.
  return "$HOME";
}
