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

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  providerRecord,
  providerUsesGatewayIdentity,
  reservedProviderNames,
  resolveRuntimeProviderName,
} from "./provider-registry.js";
import { mkdirOwned, type OnPublished } from "./publication-ledger.js";
import { loadRole } from "./role-loader.js";
import { assertNoReservedProviderEntries } from "./session.js";
import { PI_BUILTIN_TOOLS } from "./tool-allowlist.js";

export type { PublishedEntry } from "./publication-ledger.js";

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
  // Test seam: called with the agent directory before its non-recursive mkdir,
  // and with the path of each file published with link(2), after its temp
  // write.
  beforePublish?: (path: string) => void;
  // Publication ledger (bob#326): created directories are reported before
  // their identity read; files use descriptor identity before publication.
  // Flair keys outside the agent directory are not covered. Path substitution
  // after a directory check remains possible.
  onPublished?: OnPublished;
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

  const exists = `agent dir already exists: ${agentDir} (pass --force to overwrite)`;
  if (noClobber && fileExists(agentDir)) throw new Error(exists);

  // The reserved-name check runs BEFORE the first write (init --force and hire
  // included): a pi file that carries a bob-owned keyed entry, or that cannot be
  // proven free of one, refuses with nothing written.
  const registry = opts.registry ?? DEFAULT_PROVIDER_REGISTRY;
  assertNoReservedProviderEntries(join(agentDir, ".pi-agent"), reservedProviderNames(registry));

  const written: string[] = [];

  const onPublished = opts.onPublished;

  // Without --force, the agent directory is created here with a non-recursive
  // mkdir, and `publish` does not replace an existing entry. With --force,
  // `publish` writes over. Either way each file is reported to onPublished with
  // the identity of the temporary file this call created.
  const publish: Publish = noClobber
    ? (path, content, mode) =>
        writeFileExclusive(path, content, opts.beforePublish, mode, onPublished)
    : (path, content, mode) => writeFileReplacing(path, content, mode, onPublished);
  mkdirSync(root, { recursive: true });
  if (noClobber) opts.beforePublish?.(agentDir);
  // One level at a time: a directory is reported only when this mkdir created
  // it. Without --force an existing agent directory is refused; with --force it
  // is used, but it is not this call's, so it is not reported.
  if (mkdirOwned(agentDir, onPublished) === undefined && noClobber) throw new Error(exists);

  // Top-level + subdirs. An existing one (EEXIST) is used and not reported.
  for (const sub of ["bin", "work", "memory", ".pi-agent"]) {
    mkdirOwned(join(agentDir, sub), onPublished);
  }

  // soul.md (identity header + role template; user editable). The role
  // template only describes the ROLE — the header stamps WHO the agent is
  // (name, id, role), so a --no-interactive agent still boots knowing its
  // own identity (#89). The hiring interview overwrites the file with a
  // refined persona; this header is the floor, not the ceiling.
  const soulPath = join(agentDir, "soul.md");
  publish(soulPath, renderSoulIdentityHeader(opts) + (opts.soulBody ?? template.soul));
  written.push(soulPath);

  // bob.yaml — canonical config. The tools: allowlist is the role's ceiling
  // intersected with the tools that can actually exist here (pi's built-ins +
  // the stamped capabilities' tools), so a freshly initialised agent of EVERY
  // role loads with a policy that holds.
  const yamlPath = join(agentDir, "bob.yaml");
  publish(
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
  written.push(...writePiAgentConfig(opts, agentDir, publish));
  if (opts.contextWindow === undefined) {
    console.error(
      `⚠ Set provider.context_window in ${yamlPath} before running — bob refuses to start a session without the model's context window.`,
    );
  }

  // bin/<name> launcher
  const binPath = join(agentDir, "bin", opts.name);
  publish(binPath, renderLauncher(opts), 0o755);
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
// - Disk-backed providers declare models = [{ id: opts.model }].
//   baseUrl uses provider.base_url or the row's optional endpoint.
// - auth.json: exe-dev-gateway gets its VM-identity placeholder key (the
//   literal value is never checked — the gateway authenticates via VM
//   identity).

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

function writePiAgentConfig(opts: InitOptions, agentDir: string, publish: Publish): string[] {
  const piDir = join(agentDir, ".pi-agent");
  // initAgent created (or found) it above; defensive recreate in case a caller
  // didn't go through the standard path. Created here, it is reported too.
  mkdirOwned(piDir, opts.onPublished);

  const registry = opts.registry ?? DEFAULT_PROVIDER_REGISTRY;
  const piProvider = resolveRuntimeProviderName(opts.provider, registry);
  const isGateway = providerUsesGatewayIdentity(opts.provider, registry);
  // A keyed row's key is never written here.
  const isEnvKeyProvider = providerReadsKeyFromEnv(opts.provider, registry);
  const isKeyless = providerRecord(opts.provider, registry)?.auth.kind === "none";
  // OpenAI-compatible providers also get `api`, `compat` and an explicit model
  // entry (bob#132).
  const api = providerApiFlavour(opts.provider, registry);
  const isOpenAiCompatible = api === PROVIDER_API_OPENAI_COMPLETIONS;
  const baseUrl = opts.baseUrl ?? providerEndpoint(opts.provider, registry);
  const key =
    opts.baseUrl !== undefined
      ? "bob-base-url-placeholder-not-a-secret"
      : isGateway
        ? "exe-gateway-placeholder"
        : "REPLACE_WITH_YOUR_API_KEY";

  const modelsPath = join(piDir, "models.json");
  const authPath = join(piDir, "auth.json");

  // A keyed row has no on-disk provider block: its endpoint and model
  // declaration are constructed IN MEMORY at session creation, and an on-disk
  // entry is REFUSED. Every other provider still declares its model on disk.
  const providers = isEnvKeyProvider
    ? {}
    : {
        [piProvider]: {
          ...(baseUrl ? { baseUrl } : {}),
          ...(isOpenAiCompatible
            ? {
                api,
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
  const modelsContent = `${JSON.stringify({ providers }, null, 2)}\n`;
  const authContent = `${JSON.stringify(isEnvKeyProvider || isKeyless ? {} : { [piProvider]: { type: "api_key", key } }, null, 2)}\n`;

  if (isEnvKeyProvider) {
    // With --force, skip files present at the existence check. Publish the
    // others with mode 0600 without replacing an existing entry.
    const created: string[] = [];
    for (const [path, content] of [
      [modelsPath, modelsContent],
      [authPath, authContent],
    ] as const) {
      if (opts.noClobber === false && fileExists(path)) continue;
      writeFileExclusive(path, content, opts.beforePublish, 0o600, opts.onPublished);
      created.push(path);
    }
    const row = providerRecord(opts.provider, registry);
    const variable = row?.auth.kind === "env" ? row.auth.variable : "the provider key";
    console.error(`⚠ Export ${variable} before running — bob never writes the key to disk.`);
    return created;
  }

  publish(modelsPath, modelsContent);
  publish(authPath, authContent, 0o600);

  if (!isGateway && !isKeyless && opts.baseUrl === undefined) {
    console.error(
      `⚠ Set your ${opts.provider} API key in ${join(agentDir, ".pi-agent", "auth.json")} before running.`,
    );
  }

  return [modelsPath, authPath];
}

/** False only when stat reports ENOENT; any other failure is thrown. */
function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Writes `content` to `path`, with `mode` set exactly when given. */
type Publish = (path: string, content: string, mode?: number) => void;

function writeFileReplacing(
  path: string,
  content: string,
  mode?: number,
  onPublished?: OnPublished,
): void {
  if (mode === undefined) {
    try {
      const destination = lstatSync(path);
      if (destination.isFile()) mode = destination.mode & 0o7777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  withTempFile(path, content, mode, (temp) => renameSync(temp, path), onPublished);
}

/** Write an exclusive temp file, then publish it with link(2), which fails with
 *  EEXIST instead of replacing an existing entry. `mode` is set exactly when
 *  given; otherwise the process umask applies, as with writeFileSync. */
function writeFileExclusive(
  path: string,
  content: string,
  beforePublish?: (path: string) => void,
  mode?: number,
  onPublished?: OnPublished,
): void {
  withTempFile(
    path,
    content,
    mode,
    (temp) => {
      beforePublish?.(path);
      try {
        linkSync(temp, path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        throw new Error(
          `bob: refusing to write ${path}: an entry already exists there and bob does not replace it. Inspect it, then re-run.`,
        );
      }
    },
    onPublished,
  );
}

// The temp file is created exclusively, and its identity is read from ITS
// descriptor before it is published, so what onPublished records for `path` is
// this call's file even if another writer replaces `path` afterwards. `path` is
// reported as soon as `publish` returns, BEFORE the temp name is cleaned up; if
// that cleanup fails, the temp name (still this call's file) is reported too.
function withTempFile(
  path: string,
  content: string,
  mode: number | undefined,
  publish: (temp: string) => void,
  onPublished?: OnPublished,
): void {
  const temp = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode ?? 0o666,
  );
  let identity: { dev: bigint; ino: bigint } | undefined;
  const cleanUp = (): void => {
    try {
      rmSync(temp, { force: true });
    } catch (err) {
      if (identity !== undefined) onPublished?.({ path: temp, ...identity, kind: "file" });
      throw err;
    }
  };
  try {
    try {
      const st = fstatSync(fd, { bigint: true });
      identity = { dev: st.dev, ino: st.ino };
      writeFileSync(fd, content);
      if (mode !== undefined) fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    publish(temp);
    if (identity !== undefined) onPublished?.({ path, ...identity, kind: "file" });
  } finally {
    cleanUp();
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function homedirEscape(): string {
  // Launcher script reads $HOME at runtime, not at generation time —
  // makes the launcher portable across users / hostnames.
  return "$HOME";
}
