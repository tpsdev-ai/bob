// bob login <agent> [provider] / bob logout <agent> (bob#241).
//
// HOW PI'S LOGIN ACTUALLY RUNS. The pinned pi (0.84.3) has NO login subcommand
// or flag — `pi auth` only prints credentials. Its CLI startup arguments are
// handed to `session.prompt` (see
// node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:859),
// and its `/login` and `/logout` handlers run only on EDITOR submits
// (dist/modes/interactive/interactive-mode.js:2454, inside
// setupEditorSubmitHandler). So there is no way to start the flow
// non-interactively-but-attached; passing "/login" as an argument would send
// that text to the model instead. bob therefore runs pi's TUI attached to the
// operator's terminal, in the agent's own directory, with PI_CODING_AGENT_DIR
// set, and tells the operator to type `/login` (or `/logout`).
//
// bob composes the agent's pi config directory for every session, so the
// operator does not need to know it: this module reuses the SAME session
// composer — `resolveRunConfig`, whose `config.piAgentDir` IS the agent's
// `.pi-agent` directory — and never re-derives the path. bob never prints, logs
// or copies the token; it reports only WHICH providers the store holds a
// credential for.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_LOGIN_STORE } from "./confined-read.js";
import { agentDirFor } from "./position-runtime.js";
import { resolveRunConfig } from "./run.js";

const AGENT_NAME = /^[a-z0-9-]+$/;

// pi's subscription OAuth providers: the provider bundles whose OAuth config
// carries `isSubscription: true` —
// node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/{anthropic,
// openai-codex,github-copilot,xai,kimi-coding}.js. These are the providers
// `bob login` is for and the set the doctor check covers. pi also offers an
// API-key path for some of them (xAI, Kimi), so a stored API key counts.
export const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai-codex",
  "github-copilot",
  "xai",
  "kimi-coding",
]);

// Values `bob init` writes into auth.json as a scaffold placeholder. pi's
// schema accepts them, but they are not credentials an agent can send, so they
// are not counted as "the store holds a credential".
const PLACEHOLDER_CREDENTIALS: ReadonlySet<string> = new Set([
  "REPLACE_WITH_YOUR_API_KEY",
  "exe-gateway-placeholder",
]);

// The environment names the child keeps. Everything else — any ambient provider
// API key above all — is dropped, so the login uses the store and no stray
// credential reaches pi. PI_CODING_AGENT_DIR is set by the caller.
const PASSED_ENV = [
  "PATH",
  "HOME",
  "TERM",
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
] as const;

export interface LoginDeps {
  agentsRoot?: string;
  homeDir?: string;
  // The pi executable. Defaults to the pinned one (resolvePiBin).
  piBin?: string;
  // Test seams for the terminal check. Default: process.stdin / process.stdout.
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  // Test seam: the spawn function.
  spawnFn?: typeof spawn;
  // Test seams: where bob's own messages go. Default: console.
  out?: (line: string) => void;
  err?: (line: string) => void;
}

// The provider names the agent's auth store holds a credential for. A store that
// is absent is "none"; a store pi would reject, or one that cannot be read or
// parsed, is a REASON, never "none" — a failed read must not read as "no
// credential".
export type StoredProviders = { ok: true; providers: string[] } | { ok: false; reason: string };

// Does pi's credential reader accept this entry? Mirrors `ReadOnlyAuthStorage.load`
// (node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js:180-202):
// an entry is a credential iff it is an object whose `type` is "api_key" (with
// `key` undefined or a string, and `env` undefined or a map of strings) or
// "oauth" (with string `access`, string `refresh` and a finite number
// `expires`). Anything else makes pi reject the WHOLE store.
function piAcceptsCredential(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (e.type === "api_key") {
    const validKey = e.key === undefined || typeof e.key === "string";
    const validEnv =
      e.env === undefined ||
      (typeof e.env === "object" &&
        e.env !== null &&
        !Array.isArray(e.env) &&
        Object.values(e.env).every((v) => typeof v === "string"));
    return validKey && validEnv;
  }
  if (e.type === "oauth") {
    return (
      typeof e.access === "string" &&
      typeof e.refresh === "string" &&
      typeof e.expires === "number" &&
      Number.isFinite(e.expires)
    );
  }
  return false;
}

// A credential pi accepts (above) that is also not one of bob's scaffold
// placeholders — the value is only ever compared to bob's own constants.
function isPlaceholder(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  for (const field of ["key", "access", "refresh", "token", "apiKey"]) {
    const value = e[field];
    if (typeof value === "string" && PLACEHOLDER_CREDENTIALS.has(value)) return true;
  }
  return false;
}

export function storedCredentialProviders(piAgentDir: string): StoredProviders {
  const path = join(piAgentDir, PROVIDER_LOGIN_STORE);
  if (!existsSync(path)) return { ok: true, providers: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? String(err)})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${path} is not a provider map` };
  }
  const providers: string[] = [];
  for (const [provider, entry] of Object.entries(parsed as Record<string, unknown>)) {
    // Validate the WHOLE store, as pi does: one entry pi rejects makes the store
    // unreadable to pi, so no provider in it can be trusted.
    if (!piAcceptsCredential(entry)) {
      return {
        ok: false,
        reason: `${path} holds a credential pi would reject for provider "${provider}"`,
      };
    }
    if (!isPlaceholder(entry)) providers.push(provider);
  }
  return { ok: true, providers: providers.sort() };
}

// bob#241 — the doctor check. When bob.yaml names a subscription provider, the
// agent's auth store must hold a credential pi would accept for it. `ok` when
// the check is satisfied or does not apply; `fail` (with a fix line) when the
// provider has no stored credential, or when the store is one pi would reject —
// neither a store that cannot be read nor one pi rejects is a pass.
export function subscriptionCredentialCheck(input: {
  name: string;
  provider: string;
  piAgentDir: string;
}): { status: "ok"; detail: string } | { status: "fail"; detail: string; fix: string } {
  const { name, provider, piAgentDir } = input;
  if (!SUBSCRIPTION_PROVIDERS.has(provider)) {
    return { status: "ok", detail: `provider ${provider} is not a subscription provider` };
  }
  const stored = storedCredentialProviders(piAgentDir);
  if (!stored.ok) {
    return {
      status: "fail",
      detail: stored.reason,
      fix: `fix ${join(piAgentDir, PROVIDER_LOGIN_STORE)}, then re-run 'bob doctor ${name}'`,
    };
  }
  if (stored.providers.includes(provider)) {
    return { status: "ok", detail: `credential stored for ${provider}` };
  }
  return {
    status: "fail",
    detail: `no credential stored for ${provider} (stored: ${stored.providers.join(", ") || "none"})`,
    fix: `bob login ${name} ${provider}`,
  };
}

// The pi executable bob pins: pi's package.json `bin` is `dist/bundle/cli.js`,
// and the package's `.` export resolves to `dist/index.js`, so the bin is its
// sibling. Falls back to `pi` on PATH.
// The pi executable bob pins: pi's package.json `bin` is `dist/bundle/cli.js`.
// Resolve it from bob's OWN module directory by walking up to the nearest
// node_modules, so a stray `pi` on PATH is not used. Falls back to `pi`.
export function resolvePiBin(): string {
  const rel = join(
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const bin = join(dir, rel);
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "pi";
}

// Resolve the agent's directory, its pi config directory and its provider. The
// `.pi-agent` path comes from the ONE session composer (resolveRunConfig),
// never a second `join`, so it cannot drift from what a session uses. An agent
// that does not exist is refused BY NAME, naming the agents directory searched.
function resolveAgent(
  name: string,
  agentsRoot: string,
  verb: string,
): { agentDir: string; piAgentDir: string; provider: string } {
  if (!AGENT_NAME.test(name)) {
    throw new Error(`bob ${verb}: invalid agent name ${JSON.stringify(name)}`);
  }
  if (!existsSync(agentDirFor(agentsRoot, name))) {
    throw new Error(
      `bob ${verb}: no agent "${name}" under ${agentsRoot} — run 'bob onboard ${name}' first.`,
    );
  }
  const { agentDir, provider, config } = resolveRunConfig({ name, agentsRoot });
  return { agentDir, piAgentDir: config.piAgentDir, provider };
}

function loginChildEnv(piAgentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: piAgentDir };
  for (const name of PASSED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function requireInteractive(verb: string, deps: LoginDeps): void {
  const stdinTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutTTY = deps.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdinTTY || !stdoutTTY) {
    throw new Error(
      `bob ${verb}: pi's /${verb} flow is interactive — run it in a terminal (stdin ${stdinTTY ? "is" : "is not"} a TTY, stdout ${stdoutTTY ? "is" : "is not"})`,
    );
  }
}

// Run pi's TUI attached to this terminal, with NO arguments (pi would send an
// argument to the model). pi's interactive mode opens in `cwd`.
function runPi(input: {
  piBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn: typeof spawn;
}): Promise<void> {
  const child = input.spawnFn(input.piBin, [], {
    cwd: input.cwd,
    env: input.env,
    stdio: "inherit",
  });
  return new Promise<void>((resolve, reject) => {
    child.on("error", (err) =>
      reject(
        new Error(
          `bob: could not start pi at '${input.piBin}': ${(err as NodeJS.ErrnoException).code ?? err.message}`,
        ),
      ),
    );
    child.on("exit", () => resolve());
  });
}

// bob login <agent> [provider] — sign the agent in to a subscription provider.
export async function runLogin(
  opts: { name: string; provider?: string } & LoginDeps,
): Promise<number> {
  const agentsRoot = opts.agentsRoot ?? join(opts.homeDir ?? homedir(), "agents");
  const out = opts.out ?? ((line: string) => console.log(line));
  const err = opts.err ?? ((line: string) => console.error(line));
  const {
    agentDir,
    piAgentDir,
    provider: yamlProvider,
  } = resolveAgent(opts.name, agentsRoot, "login");
  requireInteractive("login", opts);

  // The credential this run targets: the named provider, or bob.yaml's own.
  const target = opts.provider ?? yamlProvider;
  const command = opts.provider !== undefined ? `/login ${opts.provider}` : "/login";
  out(
    `bob login ${opts.name}: starting pi in ${agentDir} — type ${command} at the prompt to sign in.`,
  );
  out(
    `  pi stores the credential in ${join(piAgentDir, PROVIDER_LOGIN_STORE)}; bob never reads it.`,
  );

  await runPi({
    piBin: opts.piBin ?? resolvePiBin(),
    cwd: agentDir,
    env: loginChildEnv(piAgentDir),
    spawnFn: opts.spawnFn ?? spawn,
  });

  // Success is the POST-CONDITION, not pi's exit code: the store must now hold a
  // credential for the target provider. A zero exit with nothing stored (the
  // operator cancelled) is a failure.
  const stored = storedCredentialProviders(piAgentDir);
  if (!stored.ok) {
    err(`bob login ${opts.name}: ${stored.reason}`);
    return 1;
  }
  if (!stored.providers.includes(target)) {
    err(
      `bob login ${opts.name}: no credential was stored for ${target} (stored: ${stored.providers.join(", ") || "none"}).`,
    );
    return 1;
  }
  out(`bob login ${opts.name}: credential stored for ${target}.`);
  return 0;
}

// bob logout <agent> — the matching removal. pi's `/logout` is an interactive
// credential selector and takes no provider argument, so this command takes
// none either.
export async function runLogout(opts: { name: string } & LoginDeps): Promise<number> {
  const agentsRoot = opts.agentsRoot ?? join(opts.homeDir ?? homedir(), "agents");
  const out = opts.out ?? ((line: string) => console.log(line));
  const err = opts.err ?? ((line: string) => console.error(line));
  const { agentDir, piAgentDir } = resolveAgent(opts.name, agentsRoot, "logout");
  requireInteractive("logout", opts);

  const before = storedCredentialProviders(piAgentDir);
  if (!before.ok) {
    err(`bob logout ${opts.name}: ${before.reason}`);
    return 1;
  }
  out(
    `bob logout ${opts.name}: starting pi in ${agentDir} — type /logout at the prompt to remove a credential.`,
  );
  out(`  pi removes the credential from ${join(piAgentDir, PROVIDER_LOGIN_STORE)}.`);

  await runPi({
    piBin: opts.piBin ?? resolvePiBin(),
    cwd: agentDir,
    env: loginChildEnv(piAgentDir),
    spawnFn: opts.spawnFn ?? spawn,
  });

  // The post-condition: a credential was actually removed. A zero exit with an
  // unchanged store (the operator cancelled) is a failure.
  const after = storedCredentialProviders(piAgentDir);
  if (!after.ok) {
    err(`bob logout ${opts.name}: ${after.reason}`);
    return 1;
  }
  const removed = before.providers.filter((p) => !after.providers.includes(p));
  if (removed.length === 0) {
    err(
      `bob logout ${opts.name}: no credential was removed (stored: ${after.providers.join(", ") || "none"}).`,
    );
    return 1;
  }
  out(`bob logout ${opts.name}: removed ${removed.join(", ")}.`);
  return 0;
}
