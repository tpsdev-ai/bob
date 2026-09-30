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
// `.pi-agent` directory — and never re-derives the path. bob READS the agent's
// auth store locally to decide whether a sign-in happened (it parses auth.json);
// it does not print credential fields — it reports only WHICH providers the
// store holds a usable credential for.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_LOGIN_STORE } from "./confined-read.js";
import { agentDirFor } from "./position-runtime.js";
import { resolveRunConfig } from "./run.js";

const AGENT_NAME = /^[a-z0-9-]+$/;

// The SCOPE of the `bob doctor` subscription check — a policy choice, not a
// limit on `bob login`: login starts pi for any provider, and pi offers both a
// subscription OAuth path and, for some providers, an API-key path. This set is
// pi's subscription OAuth providers (pi's bundles mark anthropic, openai-codex,
// github-copilot, xai and kimi-coding with `isSubscription: true`,
// dist/bundle/chunks/*.js) minus anthropic, which bob's scaffold configures with
// an API key. The doctor check therefore simply does not cover anthropic; a
// provider outside this set produces no check at all.
export const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set([
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

// The environment names the child keeps. Everything else is dropped, so ambient
// provider-key ENVIRONMENT VARIABLES are omitted and the login uses the store.
// This is an environment allowlist only: pi still runs as the same user and keeps
// same-user file access. PI_CODING_AGENT_DIR is set by the caller.
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
  // The pi executable. Defaults to the package-path one (resolvePiBin).
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

// The provider names the agent's auth store holds a USABLE credential for (by
// bob's conservative rule), and separately the names whose record is stored but
// unusable (an entry bob's rule reads, but not as a usable key). A store that is
// absent is "none"; a store bob's validation refuses, or one that cannot be read
// or parsed, is a REASON, never "none" — a failed read must not read as "no
// credential".
export type StoredProviders =
  | { ok: true; providers: string[]; unusable: string[] }
  | { ok: false; reason: string };

// bob's conservative validation of one stored entry, mirroring pi's read-only
// validator `ReadOnlyAuthStorage.load`
// (node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js:180-202):
// an entry is acceptable iff it is an object whose `type` is "api_key" (with
// `key` undefined or a string, and `env` undefined or a map of strings) or
// "oauth" (with string `access`, string `refresh` and a finite number
// `expires`). This is bob's OWN rule: it is stricter than pi's live runtime,
// whose AuthStorage parser only JSON-parses the file (dist/core/auth-storage.js:294,
// used by ModelRuntime — dist/core/model-runtime.js:74). bob refuses the WHOLE
// store when any entry fails it, rather than trusting part of it.
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
// placeholders — the value is only ever compared to bob's own constants. A stored
// reference is not itself a placeholder, so an api_key's `key` is resolved (the
// same way pi and bob resolve it) before the comparison: `$KEY` where KEY holds a
// scaffold placeholder is a placeholder, and an unresolved reference is not one.
function isPlaceholder(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  for (const field of ["key", "access", "refresh", "token", "apiKey"]) {
    const value = e[field];
    if (typeof value === "string" && PLACEHOLDER_CREDENTIALS.has(value)) return true;
  }
  if (e.type === "api_key") {
    const resolved = resolveStoredKey(e.key, e.env);
    if (resolved !== undefined && PLACEHOLDER_CREDENTIALS.has(resolved)) return true;
  }
  return false;
}

// Does the entry hold a credential bob treats as USABLE — one pi's reader would
// resolve to a non-empty value? This is bob's conservative rule (see the
// validator note above), not a claim about pi's live runtime:
//  - api_key: `key` resolves (env references resolved, no command executed) to a
//    non-empty string;
//  - oauth:  `access` and `refresh` are non-empty strings, `expires` finite.
//
// pi resolves a stored api_key's `key` when it reads it (dist/core/auth-storage.js:369-376,
// `AuthStorage.read`, which returns `{...credential, key: resolveConfigValue(credential.key, credential.env)}`),
// resolving each `$NAME` with `env?.[name] || process.env[name] || undefined`
// (dist/core/resolve-config-value.js:72, `resolveEnvConfigValue`): a stored value
// that is empty falls back to the process variable, and only a name unset in BOTH
// resolves to no key (dist/core/resolve-config-value.js:85, `resolveTemplate`).
// bob mirrors that resolution WITHOUT executing a command reference: a `!cmd` key
// is treated as unresolved rather than run to make doctor pass.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function resolveStoredKey(key: unknown, entryEnv: unknown): string | undefined {
  if (typeof key !== "string") return undefined;
  if (key.startsWith("!")) return undefined;
  const env: Record<string, string> =
    entryEnv && typeof entryEnv === "object" && !Array.isArray(entryEnv)
      ? (entryEnv as Record<string, string>)
      : {};
  // pi's resolver, mirrored: a stored value that is empty falls back to the
  // process variable (dist/core/resolve-config-value.js:72, `resolveEnvConfigValue`:
  // `env?.[name] || process.env[name] || undefined`).
  const lookup = (name: string): string | undefined => env[name] || process.env[name] || undefined;
  let out = "";
  let i = 0;
  while (i < key.length) {
    const dollar = key.indexOf("$", i);
    if (dollar < 0) {
      out += key.slice(i);
      break;
    }
    out += key.slice(i, dollar);
    const next = key[dollar + 1];
    if (next === "$" || next === "!") {
      out += next;
      i = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = key.indexOf("}", dollar + 2);
      if (end < 0) {
        out += "$";
        i = dollar + 1;
        continue;
      }
      const name = key.slice(dollar + 2, end);
      if (ENV_NAME_RE.test(name)) {
        const value = lookup(name);
        if (value === undefined) return undefined;
        out += value;
      } else {
        out += key.slice(dollar, end + 1);
      }
      i = end + 1;
      continue;
    }
    const match = key.slice(dollar + 1).match(ENV_NAME_PREFIX_RE);
    if (match) {
      const value = lookup(match[0]);
      if (value === undefined) return undefined;
      out += value;
      i = dollar + 1 + match[0].length;
      continue;
    }
    out += "$";
    i = dollar + 1;
  }
  return out.length > 0 ? out : undefined;
}

function piTreatsAsConfigured(entry: unknown): boolean {
  if (!piAcceptsCredential(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (e.type === "api_key") {
    return resolveStoredKey(e.key, e.env) !== undefined;
  }
  return (
    typeof e.access === "string" &&
    e.access.length > 0 &&
    typeof e.refresh === "string" &&
    e.refresh.length > 0 &&
    typeof e.expires === "number" &&
    Number.isFinite(e.expires)
  );
}

type AuthStoreRead = { ok: true; entries: Record<string, unknown> } | { ok: false; reason: string };

// Read and conservatively validate the agent's auth store. A failed read or
// parse, or any entry bob's validation rule refuses, is a REASON — never "no
// credential".
function readAuthStore(piAgentDir: string): AuthStoreRead {
  const path = join(piAgentDir, PROVIDER_LOGIN_STORE);
  if (!existsSync(path)) return { ok: true, entries: {} };
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
  const entries = parsed as Record<string, unknown>;
  for (const [provider, entry] of Object.entries(entries)) {
    // bob's conservative rule (above): one entry it refuses makes the whole store
    // untrustworthy, so bob refuses to count entries from a partly invalid store.
    if (!piAcceptsCredential(entry)) {
      return {
        ok: false,
        reason: `${path}: the credential for provider "${provider}" fails bob's conservative store validation`,
      };
    }
  }
  return { ok: true, entries };
}

export function storedCredentialProviders(piAgentDir: string): StoredProviders {
  const store = readAuthStore(piAgentDir);
  if (!store.ok) return { ok: false, reason: store.reason };
  const providers: string[] = [];
  const unusable: string[] = [];
  for (const [provider, entry] of Object.entries(store.entries)) {
    // An entry bob's validator accepts is not necessarily one pi would resolve
    // to a usable key: a keyless `api_key`, an unresolved reference, or a bob
    // scaffold placeholder is stored but unusable. Only a usable credential counts.
    if (piTreatsAsConfigured(entry) && !isPlaceholder(entry)) providers.push(provider);
    else unusable.push(provider);
  }
  return { ok: true, providers: providers.sort(), unusable: unusable.sort() };
}

// A per-provider fingerprint of the STORED entry — a hash of its fields as
// stored, never printed — so a change to a DIFFERENT provider cannot masquerade
// as a change to this one. `fingerprint` is null when the provider has no entry.
export function storedCredentialFingerprint(
  piAgentDir: string,
  provider: string,
):
  | { ok: true; present: boolean; usable: boolean; fingerprint: string | null }
  | { ok: false; reason: string } {
  const store = readAuthStore(piAgentDir);
  if (!store.ok) return { ok: false, reason: store.reason };
  const entry = store.entries[provider];
  if (entry === undefined) return { ok: true, present: false, usable: false, fingerprint: null };
  return {
    ok: true,
    present: true,
    usable: piTreatsAsConfigured(entry) && !isPlaceholder(entry),
    fingerprint: createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
  };
}

// bob#241 — the doctor check. When bob.yaml names a provider IN THIS CHECK'S
// SCOPE, the agent's store must hold a usable credential for it. `ok` when the
// check is satisfied or the provider is out of scope; `fail` (with a fix line)
// when the provider has no usable credential, or when the store cannot be read
// or parsed, or fails bob's conservative validation — none of those is a pass.
export function subscriptionCredentialCheck(input: {
  name: string;
  provider: string;
  piAgentDir: string;
}): { status: "ok"; detail: string } | { status: "fail"; detail: string; fix: string } {
  const { name, provider, piAgentDir } = input;
  if (!SUBSCRIPTION_PROVIDERS.has(provider)) {
    return { status: "ok", detail: `provider ${provider} is outside this check's scope` };
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
  if (stored.unusable.includes(provider)) {
    return {
      status: "fail",
      detail: `credential record for ${provider} is stored but not usable — bob does not resolve it to a usable key (an empty key, an unresolved reference, or a placeholder value); stored: ${stored.providers.join(", ") || "none"}`,
      fix: `bob login ${name} ${provider}`,
    };
  }
  return {
    status: "fail",
    detail: `no credential stored for ${provider} (stored: ${stored.providers.join(", ") || "none"})`,
    fix: `bob login ${name} ${provider}`,
  };
}

// The pi executable from bob's OWN tree: pi's package.json `bin` is
// `dist/bundle/cli.js`. Resolve the PACKAGE-PATH executable by walking up from
// bob's own module directory to the nearest node_modules — this checks that the
// path exists, NOT the package's version — so a stray `pi` on PATH is never used.
// When it is not found the search REFUSES, naming every location it looked in;
// bob never falls back to a `pi` on PATH. (The optional start directory is a
// test seam; production callers pass none.)
export function resolvePiBin(startDir?: string): string {
  const rel = join(
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  const searched: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bin = join(dir, rel);
    searched.push(bin);
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `bob: could not find the pi executable at the package path (looked for ${rel} in ${searched.length} location(s): ${searched.join(", ")}). Run 'bun install' in the bob checkout so the pi package is present; bob never runs a 'pi' from PATH.`,
  );
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
// argument to the model). pi's interactive mode opens in `cwd`. Resolves with
// the child's exit status so the caller can treat an abnormal exit as a failure
// rather than discarding it.
function runPi(input: {
  piBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn: typeof spawn;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = input.spawnFn(input.piBin, [], {
    cwd: input.cwd,
    env: input.env,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.on("error", (err) =>
      reject(
        new Error(
          `bob: could not start pi at '${input.piBin}': ${(err as NodeJS.ErrnoException).code ?? err.message}`,
        ),
      ),
    );
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

// bob login <agent> [provider] — start pi for provider sign-in; the operator
// performs the sign-in itself.
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
    `  pi stores the credential in ${join(piAgentDir, PROVIDER_LOGIN_STORE)}; bob reads that store to check the result and never prints credential values.`,
  );

  // Record the TARGET provider's stored credential BEFORE launch (its presence,
  // usability and a fingerprint of its stored fields). Success is an OBSERVED
  // change to THIS provider — newly usable, or its stored value changed — never
  // pi's zero exit alone, and never a change to some OTHER provider. A store that
  // cannot be read before the run is refused: the change cannot be observed
  // without it.
  const before = storedCredentialFingerprint(piAgentDir, target);
  if (!before.ok) {
    err(`bob login ${opts.name}: ${before.reason}`);
    return 1;
  }

  const exit = await runPi({
    piBin: opts.piBin ?? resolvePiBin(),
    cwd: agentDir,
    env: loginChildEnv(piAgentDir),
    spawnFn: opts.spawnFn ?? spawn,
  });
  if (exit.code !== 0) {
    err(
      `bob login ${opts.name}: pi exited ${exit.signal ? `on signal ${exit.signal}` : `with status ${exit.code}`} — bob cannot confirm the sign-in completed.`,
    );
    return 1;
  }

  // The post-condition, about the TARGET provider only: it must now hold a usable
  // credential AND that credential must be new (not usable before) or changed
  // (its stored value differs). A zero exit that leaves the target's credential
  // pre-existing and unchanged — the operator cancelled, or signed in to another
  // provider — is a failure.
  const after = storedCredentialFingerprint(piAgentDir, target);
  if (!after.ok) {
    err(`bob login ${opts.name}: ${after.reason}`);
    return 1;
  }
  if (!after.usable) {
    err(
      `bob login ${opts.name}: no credential that passes bob's local credential checks is stored for ${target}.`,
    );
    return 1;
  }
  const added = !before.usable;
  const changed =
    before.present &&
    after.present &&
    before.fingerprint !== null &&
    before.fingerprint !== after.fingerprint;
  if (!added && !changed) {
    err(
      `bob login ${opts.name}: the credential for ${target} was already present and unchanged — bob cannot confirm a sign-in for it (did you cancel, or sign in to another provider?).`,
    );
    return 1;
  }
  out(`bob login ${opts.name}: credential stored for ${target}.`);
  return 0;
}

// bob logout <agent> — start pi so the operator can run `/logout`. This is NOT
// bound to `bob login`'s target: pi's `/logout` is an interactive selector over
// ANY stored credential, and takes no provider argument, so this command takes
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

  const exit = await runPi({
    piBin: opts.piBin ?? resolvePiBin(),
    cwd: agentDir,
    env: loginChildEnv(piAgentDir),
    spawnFn: opts.spawnFn ?? spawn,
  });
  if (exit.code !== 0) {
    err(
      `bob logout ${opts.name}: pi exited ${exit.signal ? `on signal ${exit.signal}` : `with status ${exit.code}`} — bob cannot confirm the logout completed.`,
    );
    return 1;
  }

  // The post-condition: a credential was actually removed. Every stored provider
  // NAME is compared for actual absence — a record that merely became unusable is
  // still stored, so it was not removed. A zero exit with an unchanged store (the
  // operator cancelled) is a failure.
  const after = storedCredentialProviders(piAgentDir);
  if (!after.ok) {
    err(`bob logout ${opts.name}: ${after.reason}`);
    return 1;
  }
  const beforeNames = [...before.providers, ...before.unusable];
  const afterNames = [...after.providers, ...after.unusable];
  const removed = beforeNames.filter((p) => !afterNames.includes(p));
  if (removed.length === 0) {
    err(
      `bob logout ${opts.name}: no credential was removed (stored: ${after.providers.join(", ") || "none"}).`,
    );
    return 1;
  }
  out(`bob logout ${opts.name}: removed ${removed.join(", ")}.`);
  return 0;
}
