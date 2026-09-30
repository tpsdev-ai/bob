// bob login <agent> [provider] / bob logout <agent> [provider] (bob#241).
//
// An operator moving an agent to a subscription provider (ChatGPT Plus/Pro
// through pi's openai-codex, and the other providers pi logs into) otherwise has
// to run pi by hand with the agent's config directory:
//   PI_CODING_AGENT_DIR=<agentDir>/.pi-agent pi    (then type /login)
// bob composes that directory for every session, so the operator should not need
// to know it. This module reuses the SAME session composer — `resolveRunConfig`,
// whose `config.piAgentDir` IS the agent's `.pi-agent` directory — and never
// re-derives the path.
//
// The child is pi's interactive login, spawned with an allowlisted environment
// plus PI_CODING_AGENT_DIR for THIS agent only, so the token lands in the
// agent's own auth store and nowhere else. bob never prints, logs or copies the
// token; after the child exits it reports only WHICH providers the store holds a
// credential for.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_LOGIN_STORE } from "./confined-read.js";
import { agentDirFor } from "./position-runtime.js";
import { resolveRunConfig } from "./run.js";

const AGENT_NAME = /^[a-z0-9-]+$/;

// pi providers a user signs in to with a SUBSCRIPTION — pi's OAuth
// `isSubscription` providers (see pi's provider bundles: openaiCodexOAuth,
// xaiOAuth, kimiCodingOAuth). When bob.yaml names one and the agent's auth store
// holds no credential for it, `bob doctor` fails with the `bob login` remedy.
// bob's own API-key providers are not in this set: an API key in the store is
// already a credential.
export const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set([
  "openai-codex", // OpenAI (ChatGPT Plus/Pro)
  "xai", // xAI (SuperGrok / X Premium)
  "kimi-coding", // Kimi Code
]);

// What `bob init` writes into auth.json as a scaffold PLACEHOLDER: present in the
// file, but not a credential an agent can send. The check below treats one as
// "no credential", so a freshly scaffolded agent is not reported as signed in.
const PLACEHOLDER_CREDENTIALS: ReadonlySet<string> = new Set([
  "REPLACE_WITH_YOUR_API_KEY",
  "exe-gateway-placeholder",
]);

// The environment names the child keeps. Everything else — any ambient provider
// API key above all — is dropped, so a login uses the store and no stray
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
  // The pi binary. Defaults to "pi", looked up on PATH.
  piBin?: string;
  // Test seams for the terminal check. Default: process.stdin / process.stdout.
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  // Test seam: the spawn function.
  spawnFn?: typeof spawn;
}

// The provider names the agent's auth store holds a real credential for. A store
// that is absent is "none"; a store that cannot be read or parsed is a REASON,
// never "none" — a failed read must not read as "no credential".
export type StoredProviders = { ok: true; providers: string[] } | { ok: false; reason: string };

// The credential a single auth.json entry holds: the api key, or the oauth
// access/refresh token. Undefined when the entry carries none, or carries only
// one of bob's scaffold placeholders (which are not credentials). The value is
// compared to bob's own constants and never emitted.
function hasCredential(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  for (const field of ["key", "access", "refresh", "token", "apiKey"]) {
    const value = e[field];
    if (typeof value === "string" && value !== "" && !PLACEHOLDER_CREDENTIALS.has(value)) {
      return true;
    }
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
  const providers = Object.entries(parsed as Record<string, unknown>)
    .filter(([, entry]) => hasCredential(entry))
    .map(([provider]) => provider)
    .sort();
  return { ok: true, providers };
}

// bob#241 — the doctor check. When bob.yaml names a subscription provider, the
// agent's auth store must hold a credential for it. `ok` when the check is
// satisfied or does not apply; `fail` (with a fix line) when the provider is a
// subscription provider with no stored credential, or when the store cannot be
// read — a store that could not be read is NOT a pass.
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
      fix: `make ${join(piAgentDir, PROVIDER_LOGIN_STORE)} readable, then re-run 'bob doctor ${name}'`,
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

// Resolve the agent's directory and its pi config directory. The `.pi-agent`
// path comes from the ONE session composer (resolveRunConfig), never a second
// `join`, so it cannot drift from what a session uses. An agent that does not
// exist is refused BY NAME, naming the agents directory that was searched.
function resolveAgent(
  name: string,
  agentsRoot: string,
  verb: string,
): { agentDir: string; piAgentDir: string } {
  if (!AGENT_NAME.test(name)) {
    throw new Error(`bob ${verb}: invalid agent name ${JSON.stringify(name)}`);
  }
  if (!existsSync(agentDirFor(agentsRoot, name))) {
    throw new Error(
      `bob ${verb}: no agent "${name}" under ${agentsRoot} — run 'bob onboard ${name}' first.`,
    );
  }
  const { agentDir, config } = resolveRunConfig({ name, agentsRoot });
  return { agentDir, piAgentDir: config.piAgentDir };
}

function loginChildEnv(piAgentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: piAgentDir };
  for (const name of PASSED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function runPiLoginChild(input: {
  verb: string;
  piBin: string;
  message: string;
  piAgentDir: string;
  spawnFn: typeof spawn;
}): Promise<number> {
  const child = input.spawnFn(input.piBin, [input.message], {
    env: loginChildEnv(input.piAgentDir),
    stdio: "inherit",
  });
  return new Promise<number>((resolve, reject) => {
    child.on("error", (err) =>
      reject(
        new Error(
          `bob ${input.verb}: could not start '${input.piBin}': ${(err as NodeJS.ErrnoException).code ?? err.message}`,
        ),
      ),
    );
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function reportStored(name: string, verb: string, stored: StoredProviders): void {
  if (stored.ok) {
    console.log(
      `bob ${verb} ${name}: the store now holds credentials for: ${stored.providers.join(", ") || "none"}`,
    );
  } else {
    console.log(
      `bob ${verb} ${name}: could not read the credential store — ${stored.reason} (run 'bob doctor ${name}')`,
    );
  }
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

// bob login <agent> [provider] — sign the agent in to a subscription provider.
export async function runLogin(
  opts: { name: string; provider?: string } & LoginDeps,
): Promise<number> {
  const agentsRoot = opts.agentsRoot ?? join(opts.homeDir ?? homedir(), "agents");
  const { piAgentDir } = resolveAgent(opts.name, agentsRoot, "login");
  requireInteractive("login", opts);
  // pi's interactive `/login [provider]` — with no provider, pi shows its own
  // provider menu. The command is pi's initial message so the operator's own
  // terminal drives OAuth; the env keeps the token in THIS agent's store.
  const message = opts.provider !== undefined ? `/login ${opts.provider}` : "/login";
  const exitCode = await runPiLoginChild({
    verb: "login",
    piBin: opts.piBin ?? "pi",
    message,
    piAgentDir,
    spawnFn: opts.spawnFn ?? spawn,
  });
  reportStored(opts.name, "login", storedCredentialProviders(piAgentDir));
  return exitCode === 0 ? 0 : 1;
}

// bob logout <agent> [provider] — the matching removal.
export async function runLogout(
  opts: { name: string; provider?: string } & LoginDeps,
): Promise<number> {
  const agentsRoot = opts.agentsRoot ?? join(opts.homeDir ?? homedir(), "agents");
  const { piAgentDir } = resolveAgent(opts.name, agentsRoot, "logout");
  requireInteractive("logout", opts);
  // pi's interactive `/logout` (a credential selector; it takes no provider
  // argument). pi removes the credential from the agent's own store.
  const exitCode = await runPiLoginChild({
    verb: "logout",
    piBin: opts.piBin ?? "pi",
    message: "/logout",
    piAgentDir,
    spawnFn: opts.spawnFn ?? spawn,
  });
  reportStored(opts.name, "logout", storedCredentialProviders(piAgentDir));
  return exitCode === 0 ? 0 : 1;
}
