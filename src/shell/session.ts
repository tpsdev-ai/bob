// The ONE bob session factory, adapted to pi's runtime-factory contract.
//
// `bob` never spawns the pi CLI and never assembles argv: every session —
// `bob run`, the persistent runtime, the launcher with a prompt, the mail
// consumer, `bob launch` (interactive), the hiring interview and `bob align` —
// comes from the factory below, through pi's own SDK entry points.
//
// The factory returns the session TOGETHER WITH its matching services (pi's
// runtime-factory shape), because the session can only be audited against the
// cwd-bound services it was created from. What it guarantees:
//
//   (a) the EFFECTIVE policy — the role ceiling intersected with bob.yaml,
//       minus `exclude` and the resident exclusions — is what the session is
//       created with (resolved by run.ts; it is REQUIRED, see RunSessionConfig);
//   (b) pi's settings and resource sources are built HERE, isolated: project
//       trust off, no configured package installed, and the ambient user and
//       project extension, skill, prompt-template and theme paths are never
//       LOADED (package resolution still enumerates the user-level ones before the
//       flags that drop them apply; with project trust off, project resource
//       directories are not scanned). Context files are not enumerated at all: pi skips
//       context-file discovery outright under `noContextFiles`, so no ambient
//       context file is read either — and no global SYSTEM.md / APPEND_SYSTEM.md
//       either. The only extensions that load are the declared capabilities'
//       paths. A reload re-reads exactly these isolated sources — it cannot reach
//       anything else;
//   (c) the audit — the tool policy, and for a session that holds `web` the
//       composition rule (data-class.ts, bob#244) — runs at creation, again
//       after the mode binds extensions (that
//       is a bindExtensions, which emits session_start and extends resources
//       from the extensions) and after EVERY session.reload() — NOT from inside
//       the reload, where pi has not rebuilt the tool list yet. pi's TUI shows
//       a reload error and carries on, so throwing is not enough: a failed
//       audit disposes the session and ends the process with the named error
//       before another turn can run. A reload or a bind that THROWS is a failed
//       audit too — the session may be half-rebuilt, and the mode would
//       otherwise stay open on a tool state nobody audited.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { streamSimple as openaiCompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type DefaultResourceLoader,
  type InlineExtension,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { confinedReadCustomTools } from "./confined-read.js";
import {
  assertWebComposition,
  configCompositionView,
  holdsWeb,
  restoredHistoryEntries,
  type StartupSource,
  sessionCompositionView,
  sessionWebSurface,
  WEB_SESSION_CWD,
  WEB_SESSION_SYSTEM_PROMPT,
} from "./data-class.js";
import { ADMIN_PASS_ENV } from "./flair-pair.js";
import {
  applyModelLimits,
  capOutputStream,
  compactionSettingsFor,
  installMidRunCompaction,
  type MidRunCompactionSession,
  type ModelLimits,
  requireModelLimits,
  type StreamFunction,
} from "./model-budget.js";
import type { RunSession, RunSessionConfig } from "./run.js";
import {
  appendContractOverride,
  buildContractBlock,
  type ContractGuardDeps,
  createContractGuardExtension,
} from "./system-prompt-contract.js";
import { PI_BUILTIN_TOOLS, type ToolPolicy } from "./tool-allowlist.js";
import { admissionEventBus } from "./turn-admission.js";
import { createWriteSoulExtension } from "./write-soul.js";

// pi does not export DefaultResourceLoaderOptions at the package root, so
// derive the loader-option shape from the class: cwd/agentDir/settingsManager
// are supplied by createAgentSessionServices, and this is the rest.
type LoaderOptions = Omit<
  ConstructorParameters<typeof DefaultResourceLoader>[0],
  "cwd" | "agentDir" | "settingsManager"
>;

// The FIXED policy onboarding and alignment run under. They are privileged
// local setup commands (see README "Stated exceptions"): the interview has to
// READ the seed persona and WRITE the refined one, so the setup policy is
// exactly read + write_soul — the two tools that job needs, and nothing else.
//
// `write_soul` is BOB-OWNED (write-soul.ts): it takes content only and its one
// target is the agent's own soul.md, resolved by bob. It replaced pi's generic
// `write` in bob#204, where a setup session could otherwise rewrite bob.yaml,
// overrides, grants, launchers, or any file outside the agent directory.
//
// It may still exceed the role's ceiling on purpose: a `reviewer` agent is hired
// by a human at the keyboard who is already allowed to edit that human's files,
// and the interview is a privileged local setup step. But the excess is now a
// single soul.md write, not an unrestricted one.
export const SETUP_TOOL_POLICY: ToolPolicy = {
  tools: ["read", "write_soul"],
  excludeTools: [],
  resident: false,
  allowResidentShell: false,
};

// SETUP_TOOL_POLICY is the policy of EVERY setup session, an ADOPTED agent's
// included. bob#195 slice 1 gave an adopted agent's setup session the grant's
// resolved tools plus pi's `write`; bob#204 replaces that too: pi's `write`
// accepts any path, and a grant's tools can include a shell, so either would let
// the interview write files other than soul.md. The grant still governs every
// other session of an adopted agent (resolveRunConfig), and its setup session
// still runs the agent's grant-resolved config (capabilities, cwd).

// ── openrouter: bob OWNS the provider (bob#183 round 3; round 6: transport) ────
//
// Round 2 pinned the endpoint with a CHECK against `.pi-agent/models.json` — and
// a check that has to enumerate pi's precedence rules will always lag them. Round
// 3 changed the SHAPE to a construction-time registration. Round 6 changes it
// AGAIN, because a capability can still (1) call `pi.setModel({...ctx.model,
// baseUrl: "https://evil.example/api/v1"})` — pi sends to THAT model's URL while
// bob's check reads the unchanged registry — or (2) race an async re-assertion
// that runs on `before_provider_request`. So the KEY IS BOUND TO THE ENDPOINT AT
// TRANSPORT and pi holds only a NON-SECRET placeholder. Round 7 closes the last
// path: OPENROUTER_API_KEY is DELETED from process.env when the runtime factory
// first builds a session (after pi's ModelRuntime is created, before capabilities,
// extensions and tools load),
// so pi's BUILT-IN openrouter provider (which reads the env) has nothing to send.
// What holds is KEY CONTAINMENT: the key is not in the environment and not in
// pi's auth, provider config or model data; bob keeps it in the runtime factory's
// closure and the transport's closure only, so a provider pi installs in place
// of bob's has no key to send. `ModelRuntime.refresh()` CAN replace the effective
// provider: on a composition failure pi falls back to its BUILT-IN openrouter
// provider (`model-runtime.js` recomposeProvider installs the `base` provider on
// the catch path), and once it does, bob's transport is NOT on the request path
// and NO wrapper around `refresh()` can intercept the request that follows — the
// containment above is what still holds. STATED LIMIT: this removes the
// IN-PROCESS path only; a same-user process can still read a process's initial
// environment block (/proc/<pid>/environ on Linux, `ps eww` on macOS) —
// isolating the agent's own tools from that is bob#189. The key also lives in
// the bob process's memory (the runtime-factory and transport closures), so a
// same-user process that can read another process's memory (a debugger,
// /proc/<pid>/mem, or a core dump) can recover it; isolating that is bob#189.
// Operator symptom of the fallback: after a refresh() that breaks composition
// pi's built-in openrouter provider is effective and has no key, so a turn
// fails with an auth error while the operator's key is valid — check first
// whether a .pi-agent/models.json entry defines openrouter (an extension
// cannot: the registration guard refuses it).

/** The one endpoint bob's transport sends to. (A refresh fallback can replace the effective provider; see above.) */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** The api id pi must resolve for the openrouter model (and the transport). */
export const OPENROUTER_API = "openai-completions";

/** The NON-SECRET placeholder pi holds in place of the real key. */
export const OPENROUTER_API_KEY_PLACEHOLDER = "bob-openrouter-placeholder-not-a-secret";

/** pi's extension provider-definition shape (not exported by pi at the root). */
export type OpenrouterProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];

/** Header names bob refuses to let a caller supply on an openrouter request. */
const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|cf-aig-authorization|x-api-key|api-key|x-auth-token|cookie)$/i;

/**
 * The fetch wrapper the transport delegates through: it refuses, BEFORE calling
 * `baseFetch`, any request URL that does not start with `baseUrl + "/"`. Exported
 * so a test can call it directly (round 6 (t5)).
 */
export function guardedOpenrouterFetch(
  baseUrl: string,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return ((url: unknown, init?: unknown) => {
    // (4) Canonical URL check: accept ONLY a string or a URL — never a Request.
    if (typeof url !== "string" && !(url instanceof URL)) {
      return Promise.reject(
        new Error(
          `bob: refusing an openrouter request whose URL is a ${url instanceof Request ? "Request object" : typeof url} — bob's transport accepts only a string or URL`,
        ),
      );
    }
    const asString = typeof url === "string" ? url : url.href;
    let parsed: URL;
    try {
      parsed = new URL(asString);
    } catch {
      return Promise.reject(
        new Error(`bob: refusing an openrouter request to ${asString} — not a valid URL`),
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "openrouter.ai" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      !parsed.pathname.startsWith("/api/v1/")
    ) {
      return Promise.reject(
        new Error(
          `bob: refusing an openrouter request to ${asString} — bob's transport sends only to https://openrouter.ai/api/v1/ (no credentials in the URL, default port, /api/v1/ path)`,
        ),
      );
    }
    // Non-canonical inputs (e.g. a `%2e%2e` path or a missing trailing slash)
    // parse to a href that differs from the input: refuse.
    if (asString !== parsed.href) {
      return Promise.reject(
        new Error(
          `bob: refusing a non-canonical openrouter request URL ${asString} (canonical form: ${parsed.href})`,
        ),
      );
    }
    return baseFetch(parsed.href, {
      ...(init && typeof init === "object" ? (init as Record<string, unknown>) : {}),
      redirect: "error",
    } as never).catch((err: unknown) => {
      // bob#192: refuse to FOLLOW a redirect with the key. `redirect: "error"`
      // (set above, overriding any caller value) makes the runtime reject a 3xx
      // instead of following it. Re-throw that as a bob error that NAMES the
      // refused redirect and never the credentials.
      const text = `${(err as { message?: unknown })?.message ?? ""} ${(err as { cause?: { message?: unknown } })?.cause?.message ?? ""}`;
      if (/redirect/i.test(text)) {
        return Promise.reject(
          new Error(
            `bob: refusing an openrouter redirect from ${parsed.href} — bob's transport does not follow redirects (redirect: "error")`,
          ),
        );
      }
      return Promise.reject(err);
    });
  }) as typeof globalThis.fetch;
}

/**
 * bob's OpenRouter TRANSPORT (round 6). pi calls the registered `streamSimple` as
 * `streamSimple(prepared.model, context, prepared.options)` with the FINAL model
 * and options (pi-coding-agent `core/provider-composer.js` streamWith → an
 * extension's streamSimple when `model.api === extension.api`). This function is
 * where the real key lives; it
 *   (a) refuses, by THROWING before any network call, unless
 *       `prepared.model.baseUrl === baseUrl` AND `prepared.model.api === api`;
 *   (b) refuses if `options.headers` carries any credential-bearing header
 *       (case-insensitive) — bob sets the Authorization itself;
 *   (c) delegates to pi-ai's openai-completions `streamSimple` with `apiKey` set
 *       to the real key and `fetch` set to a wrapper that refuses any request URL
 *       not under `baseUrl + "/"`.
 */
export function openrouterTransport(input: {
  baseUrl: string;
  api: string;
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
}): NonNullable<OpenrouterProviderConfig["streamSimple"]> {
  const baseFetch = input.fetchImpl ?? globalThis.fetch;
  // A SECOND check, on the request the SDK actually makes.
  const guardedFetch = guardedOpenrouterFetch(input.baseUrl, baseFetch);

  const transport = (model: unknown, context: unknown, options?: unknown) => {
    const prepared = (model ?? {}) as { baseUrl?: unknown; api?: unknown };
    if (prepared.baseUrl !== input.baseUrl || prepared.api !== input.api) {
      throw new Error(
        `bob: refusing an openrouter request to ${JSON.stringify(prepared.baseUrl)} (api ${JSON.stringify(prepared.api)}) — bob's openrouter transport sends only to ${input.baseUrl} (${input.api})`,
      );
    }
    const opts = (options ?? {}) as { headers?: Record<string, string | null> };
    // The EFFECTIVE headers the delegate will send: the model's own headers AND
    // the caller's options.headers. A credential-bearing name in either refuses.
    const preparedHeaders = (prepared as { headers?: Record<string, string | null> }).headers ?? {};
    for (const name of [...Object.keys(preparedHeaders), ...Object.keys(opts.headers ?? {})]) {
      if (CREDENTIAL_HEADER.test(name)) {
        const value = opts.headers?.[name] ?? preparedHeaders[name];
        if (value != null) {
          throw new Error(
            `bob: refusing an openrouter request with a credential-bearing ${name} header — bob sets the openrouter Authorization itself`,
          );
        }
      }
    }
    return openaiCompletionsStreamSimple(
      prepared as never,
      context as never,
      {
        ...(opts as object),
        apiKey: input.apiKey,
        fetch: guardedFetch,
      } as never,
    );
  };
  return transport as unknown as NonNullable<OpenrouterProviderConfig["streamSimple"]>;
}

/**
 * The provider definition bob builds IN MEMORY for `openrouter`: the FIXED
 * endpoint, the api, and the declared model with NO per-model `baseUrl`. pi holds
 * only the NON-SECRET placeholder key; the real key lives in the transport.
 */
export function buildOpenrouterProvider(input: {
  model: string;
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
}): OpenrouterProviderConfig {
  return {
    name: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: OPENROUTER_API_KEY_PLACEHOLDER,
    api: OPENROUTER_API,
    streamSimple: openrouterTransport({
      baseUrl: OPENROUTER_BASE_URL,
      api: OPENROUTER_API,
      apiKey: input.apiKey,
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    }),
    models: [
      {
        id: input.model,
        name: input.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  };
}

/**
 * Refuse when the on-disk pi config carries ANY `openrouter` entry: bob owns the
 * provider, and an entry in the editable `models.json` (a provider block, a
 * per-model `baseUrl`, a `providers.openrouter.apiKey`) or a stored credential
 * in `auth.json` is never merged. Names the file. A MISSING file is "absent" (no
 * entry); any OTHER read or parse failure REFUSES — bob cannot prove the file
 * carries no openrouter entry. pi accepts comments in `models.json`, so a
 * commented file is refused here ON PURPOSE as unparseable.
 */
export function assertNoOnDiskOpenrouter(piAgentDir: string): void {
  const modelsPath = join(piAgentDir, "models.json");
  const authPath = join(piAgentDir, "auth.json");
  // ENOENT is "absent" (no entry). Any OTHER read or parse failure — unreadable,
  // or JSON that does not parse after stripping a leading UTF-8 BOM — is a
  // REFUSAL: bob cannot PROVE the file carries no openrouter entry. pi accepts a
  // BOM in both files and comments in models.json, so we strip the BOM before
  // parsing (a BOM-prefixed file WITH an entry is still caught), and a commented
  // models.json fails the parse and refuses rather than reading as "no entry".
  const load = (path: string): Record<string, unknown> => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      throw new Error(
        `bob: refusing to start an openrouter session — bob cannot prove ${path} carries no openrouter entry (could not read it: ${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch (err) {
      throw new Error(
        `bob: refusing to start an openrouter session — bob cannot prove ${path} carries no openrouter entry (could not parse it: ${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  };
  const providers = (load(modelsPath).providers ?? {}) as Record<string, unknown>;
  if (Object.hasOwn(providers, "openrouter")) {
    throw new Error(
      `bob: refusing to start an openrouter session — ${modelsPath} carries a providers.openrouter entry; bob owns the openrouter provider (fixed endpoint, OPENROUTER_API_KEY). Remove this entry.`,
    );
  }
  if (Object.hasOwn(load(authPath), "openrouter")) {
    throw new Error(
      `bob: refusing to start an openrouter session — ${authPath} carries a stored openrouter credential; bob owns the openrouter provider (fixed endpoint, OPENROUTER_API_KEY). Remove this entry.`,
    );
  }
}

/**
 * After the session services EXIST (capabilities have loaded and may have called
 * pi's `registerProvider`), resolve the openrouter provider/model the way pi will
 * use it and refuse unless it is still bob's definition (round 4, item 2). bob
 * registers before `createAgentSessionServices`; a later `registerProvider` would
 * silently move the endpoint or the key, so the EFFECTIVE result is asserted, not
 * the registration intent.
 */
export async function assertOpenrouterRuntimeUnchanged(
  modelRuntime: ModelRuntime,
  input: { model: string; expected: OpenrouterProviderConfig; apiKey: string },
): Promise<void> {
  const providerId = "openrouter";
  const problems: string[] = [];
  const model = modelRuntime.getModel(providerId, input.model);
  if (!model) {
    problems.push(`no model ${providerId}/${input.model}`);
  } else {
    if (model.baseUrl !== input.expected.baseUrl) {
      problems.push(
        `the selected model's baseUrl is ${model.baseUrl}, not ${input.expected.baseUrl}`,
      );
    }
    if (model.api !== input.expected.api) {
      problems.push(
        `the selected model's api is ${JSON.stringify(model.api)}, not ${JSON.stringify(input.expected.api)}`,
      );
    }
  }
  const reg = modelRuntime.getRegisteredProviderConfig?.(providerId);
  if (!reg) {
    problems.push("there is no registered openrouter provider config");
  } else {
    if (reg.baseUrl !== input.expected.baseUrl) {
      problems.push(
        `the registered baseUrl is ${JSON.stringify(reg.baseUrl)}, not ${input.expected.baseUrl}`,
      );
    }
    if (reg.api !== input.expected.api) {
      problems.push(
        `the registered api is ${JSON.stringify(reg.api)}, not ${JSON.stringify(input.expected.api)}`,
      );
    }
    const m0 = (reg.models ?? [])[0] as { baseUrl?: string } | undefined;
    if (m0 && m0.baseUrl !== undefined) {
      problems.push(`the model entry carries a per-model baseUrl (${m0.baseUrl})`);
    }
  }
  // The key pi holds. Round 6: pi holds ONLY the NON-SECRET placeholder; the real
  // key lives in the transport. STRICT (round 4 item 4): a resolution that throws
  // ANY value — including `throw undefined` — refuses via a SEPARATE caught flag,
  // and a non-string or non-placeholder key refuses.
  let auth: Awaited<ReturnType<ModelRuntime["getAuth"]>> | undefined;
  let caught = false;
  try {
    auth = await modelRuntime.getAuth(providerId);
  } catch (err) {
    caught = true;
    problems.push(
      `the auth resolution for openrouter threw (${err instanceof Error ? err.message : String(err)}) — bob cannot prove pi holds its placeholder`,
    );
  }
  if (!caught) {
    const resolvedKey = auth?.auth?.apiKey;
    if (typeof resolvedKey !== "string") {
      problems.push(
        "the resolved openrouter apiKey is undefined — bob cannot prove pi holds its placeholder",
      );
    } else if (resolvedKey !== input.apiKey) {
      problems.push(
        "the resolved openrouter apiKey is not bob's placeholder — something replaced it",
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `bob: refusing to start an openrouter session — after the session services were built, the effective openrouter provider is no longer bob's: ${problems.join("; ")}. Something registered openrouter during session creation.`,
    );
  }
}

/** The env key, or a refusal naming the variable (never read from disk). */
export function requireOpenrouterApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env.OPENROUTER_API_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "bob: OPENROUTER_API_KEY is not set. Remedy: export OPENROUTER_API_KEY=<key> before running — bob never writes the key to disk.",
    );
  }
  return key;
}

/**
 * Read the key, then DELETE it from process.env so pi's built-in openrouter
 * provider (which reads OPENROUTER_API_KEY from process.env) has nothing to
 * send. The runtime factory calls this once and keeps the value in its closure
 * and in the transport closure built from it. Callers that can be invoked more than once
 * (the session factory, for /new and /resume) must cache the result themselves
 * rather than call this again — the environment no longer carries it.
 */
// Whether takeOpenrouterApiKey() has already read and deleted the key in this
// process (a boolean, never the key). A later call that finds the variable empty gets a
// precise refusal instead of the misleading "not set". The key itself is
// deliberately NOT cached at module scope: an exported cache would let any
// importer of this module read it.
let openrouterKeyConsumed = false;

/** True once takeOpenrouterApiKey() has read and deleted OPENROUTER_API_KEY in this process. */
export function openrouterKeyWasConsumed(): boolean {
  return openrouterKeyConsumed;
}

/** The refusal when OPENROUTER_API_KEY is empty after an earlier takeOpenrouterApiKey() read in this process. */
export const OPENROUTER_KEY_CONSUMED_MESSAGE =
  "bob: OPENROUTER_API_KEY was already read and deleted from the environment earlier in this process, and is not set now. Remedy: start a new bob process to build another openrouter runtime.";

export function takeOpenrouterApiKey(): string {
  if (openrouterKeyConsumed && !(process.env.OPENROUTER_API_KEY ?? "").trim()) {
    throw new Error(OPENROUTER_KEY_CONSUMED_MESSAGE);
  }
  const key = requireOpenrouterApiKey();
  delete process.env.OPENROUTER_API_KEY;
  openrouterKeyConsumed = true;
  return key;
}

/**
 * The whole openrouter step, run inside the ONE factory (every entry path goes
 * through it): refuse an on-disk openrouter entry, require the env key, then
 * REGISTER bob's in-memory provider so pi resolves openrouter from bob, not the
 * file. Returns the constructed definition (for a test to assert on).
 */
export function registerOpenrouterProvider(
  modelRuntime: ModelRuntime,
  input: { model: string; piAgentDir: string; env?: NodeJS.ProcessEnv; apiKey?: string },
): OpenrouterProviderConfig {
  assertNoOnDiskOpenrouter(input.piAgentDir);
  const provider = buildOpenrouterProvider({
    model: input.model,
    apiKey: input.apiKey ?? requireOpenrouterApiKey(input.env),
  });
  modelRuntime.registerProvider("openrouter", provider);
  return provider;
}

/**
 * GUARD THE VERB (round 5, item 1). pi makes a LATER `registerProvider("openrouter",
 * …)` effective IMMEDIATELY — from a capability's `session_start`, from
 * `before_agent_start`, and from a print-mode bind that loads extensions AFTER the
 * factory returns. bob registers its own provider FIRST, then wraps the runtime's
 * registration verbs ONCE, so any later call naming `openrouter` is REFUSED
 * (throwing, before it takes effect) with an error naming the caller path and the
 * attempted `baseUrl` — every hook path goes through this seam. Wrapped idempotently:
 * a second call is a no-op.
 */
export function guardOpenrouterRegistration(modelRuntime: ModelRuntime): void {
  const runtime = modelRuntime as unknown as {
    registerProvider: (id: string, config: OpenrouterProviderConfig) => void;
    unregisterProvider?: (id: string) => void;
    registerNativeProvider?: (provider: { id?: string; name?: string; baseUrl?: string }) => void;
    getRegisteredProviderConfig?: (
      id: string,
    ) => { apiKey?: unknown; streamSimple?: unknown } | undefined;
    __bobOpenrouterGuarded?: boolean;
  };
  if (runtime.__bobOpenrouterGuarded) return;
  runtime.__bobOpenrouterGuarded = true;

  const refuse = (verb: string, id: string, attempted?: unknown): never => {
    const baseUrl =
      attempted && typeof attempted === "object" && "baseUrl" in attempted
        ? (attempted as { baseUrl?: unknown }).baseUrl
        : undefined;
    const caller =
      new Error().stack
        ?.split("\n")
        .slice(2, 5)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.includes("session.ts"))
        .slice(0, 2)
        .join(" <- ") ?? "unknown caller";
    throw new Error(
      `bob: refusing a ${verb} of the openrouter provider after bob registered its own — the EFFECTIVE openrouter provider is bob's (fixed ${OPENROUTER_BASE_URL}, OPENROUTER_API_KEY). ` +
        `Attempted baseUrl ${JSON.stringify(baseUrl)}; caller ${caller}.`,
    );
  };

  const originalRegister = runtime.registerProvider.bind(modelRuntime);
  runtime.registerProvider = (id: string, config: OpenrouterProviderConfig) => {
    if (id === "openrouter") refuse("registerProvider", id, config);
    return originalRegister(id, config);
  };
  if (typeof runtime.unregisterProvider === "function") {
    const originalUnregister = runtime.unregisterProvider.bind(modelRuntime);
    runtime.unregisterProvider = (id: string) => {
      if (id === "openrouter") refuse("unregisterProvider", id);
      return originalUnregister(id);
    };
  }
  if (typeof runtime.registerNativeProvider === "function") {
    const originalNative = runtime.registerNativeProvider.bind(modelRuntime);
    runtime.registerNativeProvider = (provider: {
      id?: string;
      name?: string;
      baseUrl?: string;
    }) => {
      const id = provider?.id ?? provider?.name;
      if (id === "openrouter") refuse("registerNativeProvider", id, provider);
      return originalNative(provider);
    };
  }
  // REFRESH IS NOT WRAPPED (round 8). `ModelRuntime.refresh()` re-reads models.json
  // and CAN replace the effective openrouter provider: on a composition failure pi
  // falls back to its BUILT-IN openrouter provider (`model-runtime.js`
  // recomposeProvider installs the `base` provider on the catch path). bob's
  // transport is then NOT on the request path, and NO wrapper around `refresh()`
  // can intercept the request that follows. The guarantee bob holds is KEY
  // CONTAINMENT: the key is not in process.env (round 7 deletes it) and not in
  // pi's auth, provider config or model data (pi holds only the NON-SECRET
  // placeholder); bob keeps it in its factory and transport closures, so a
  // provider pi installs in its place has no key to send. The registration seam above
  // (register / unregister / native) is still a real layer and stays.
}

// Diagnostics + the process-exit seam, injectable so a test can watch a failed
// audit end the session without killing the test runner.
export interface SessionDeps {
  log?: (msg: string) => void;
  exit?: (code: number) => void;
}

// What the audit needs from a created session (structural, so a test can hand
// in a fake without standing up pi). Exported under both names: run.ts's public
// surface calls this ActiveToolSource.
export interface AuditSession {
  getActiveToolNames(): string[];
}
export type ActiveToolSource = AuditSession;

// What the audit needs from the loaded extensions (structural).
export interface AuditExtensions {
  getExtensions(): {
    extensions: Array<{ path: string; tools: Map<string, unknown> }>;
  };
}

// Isolated settings: in-memory, so NO user or project settings.json is read —
// no configured package, extension, skill, prompt or theme path can reach the
// loader, which is also what makes "nothing is installed" true (there is no
// package to resolve). projectTrusted:false keeps project discovery off
// regardless of any trust.json on disk.
//
// bob#214: the one setting bob DOES put here is pi's compaction reserve, derived
// from the session's compaction threshold (model-budget.ts
// compactionSettingsFor) — configuring pi's own trigger rather than adding one.
export function isolatedSettings(compaction?: { reserveTokens: number }): SettingsManager {
  return SettingsManager.inMemory(compaction !== undefined ? { compaction } : {}, {
    projectTrusted: false,
  });
}

/**
 * bob#214: the declared limits of the pair a session config runs, or the named
 * refusal (requireModelLimits). The factory's first check, before any key is
 * read or any runtime built; exported so a caller's resolved config can be
 * checked the same way without building a session.
 */
export function sessionModelLimits(
  config: Pick<RunSessionConfig, "provider" | "model" | "modelLimits" | "yamlModel" | "piAgentDir">,
): ModelLimits {
  return requireModelLimits({
    provider: config.provider,
    model: config.model,
    limits: config.modelLimits,
    bobYamlPath: join(dirname(config.piAgentDir), "bob.yaml"),
    ...(config.yamlModel !== undefined ? { yamlModel: config.yamlModel } : {}),
  });
}

/**
 * bob#214: install the model budget on a session pi just built — the
 * output-cap backstop on its stream function and the compaction check between
 * model calls.
 * Both hook pi's PUBLIC agent surfaces (`agent.streamFunction`,
 * `agent.shouldStopAfterTurn`); a session without them cannot carry the budget
 * and is refused rather than run unbudgeted.
 */
export function installSessionBudget(
  session: unknown,
  deps?: { log?: (message: string) => void },
): void {
  const s = session as Partial<MidRunCompactionSession> & {
    agent?: { streamFunction?: StreamFunction };
  };
  if (
    typeof s?.agent?.streamFunction !== "function" ||
    typeof s.settingsManager?.getCompactionSettings !== "function" ||
    typeof s.steer !== "function" ||
    typeof s.subscribe !== "function"
  ) {
    throw new Error(
      "bob: refusing a session that does not expose pi's agent stream function, compaction settings, steer() and subscribe() — bob installs the output-cap backstop and the between-calls compaction check on those (bob#214)",
    );
  }
  s.agent.streamFunction = capOutputStream(s.agent.streamFunction, deps);
  installMidRunCompaction(s as MidRunCompactionSession, deps);
}

// The isolated resource-loader options: nothing ambient, only the agent's
// declared capabilities — plus, when the agent has a contract (#145), the
// contract block appended as LITERAL TEXT and bob's guard loaded as an INLINE
// extension.
//
// The contract is appended through `appendSystemPromptOverride`, never as an
// `appendSystemPrompt` source: pi resolves a source string that happens to name
// an existing file as that FILE's contents (core/resource-loader.js
// `resolvePromptInput`), which would silently turn a task into whatever is on
// disk at that path. `appendContractOverride` is called after pi has
// turned its sources into text, so what it returns is used as text, full stop.
//
// `extensionFactories` is where the guard goes: pi appends inline extensions
// AFTER every path-loaded one (core/resource-loader.js `loadExtensionFactories`
// / `loadFinalExtensionSet`), and runs `before_provider_request` handlers in
// list order, so the guard sees the payload last — after every declared
// capability has had its turn.
export function isolatedLoaderOptions(
  config: Pick<RunSessionConfig, "appendSystemPrompt" | "extensionSources" | "piAgentDir"> & {
    contractBlock?: string;
    turnAdmission?: RunSessionConfig["turnAdmission"];
  },
  extra?: { guard?: InlineExtension; toolExtensions?: InlineExtension[]; webSession?: boolean },
): LoaderOptions {
  const contractBlock = config.contractBlock;
  // Inline extensions pi appends AFTER every path-loaded one: the setup tool
  // first, then bob's contract guard (which must run its request handler LAST).
  const inlineFactories = [
    ...(extra?.toolExtensions ?? []),
    ...(extra?.guard ? [extra.guard] : []),
  ];
  return {
    // The only extensions are the declared capabilities' paths. With
    // noExtensions the loader uses exactly these (temporary CLI scope) and
    // nothing else.
    additionalExtensionPaths: [...config.extensionSources],
    ...(config.turnAdmission ? { eventBus: admissionEventBus(config.turnAdmission) } : {}),
    // No ambient discovery of anything.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // An explicit (empty) prompt source disables SYSTEM.md discovery — the
    // global APPEND_SYSTEM.md too. The append source is exactly soul.md.
    systemPrompt: "",
    // bob#244: a web session gets bob's reviewed prompt in place of pi's
    // template, which names local paths (data-class.ts). As an override, never
    // a source: pi reads a source that names an existing file as that file.
    ...(extra?.webSession === true
      ? { systemPromptOverride: () => WEB_SESSION_SYSTEM_PROMPT }
      : {}),
    appendSystemPrompt: config.appendSystemPrompt.length > 0 ? [config.appendSystemPrompt] : [],
    ...(contractBlock !== undefined
      ? { appendSystemPromptOverride: appendContractOverride(contractBlock) }
      : {}),
    ...(inlineFactories.length > 0 ? { extensionFactories: inlineFactories } : {}),
  };
}

// The audit: every name in the effective policy is active, and no tool name is
// provided by more than one source (a pi built-in or a declared capability).
//
// pi ignores an unknown name in `tools` silently, so an allowlisted name that
// nothing registered would just be absent; a name TWO sources provide is
// ambiguous — which implementation wins is pi's load order, not a decision the
// role made.
//
// Duplicate registrations INSIDE one declared capability are not observable
// after load and are out of scope: declared capabilities are bob's own code, so
// that is a bob bug pinned by bob's own tests, not an agent configuration
// surface.
export function auditToolSources(
  config: Pick<RunSessionConfig, "tools" | "excludeTools" | "capabilityBySource">,
  extensions: Array<{ path: string; tools: Map<string, unknown> }>,
): void {
  const allowed = config.tools ?? [];
  const excluded = new Set(config.excludeTools ?? []);
  const builtins = new Set<string>(PI_BUILTIN_TOOLS);
  const sourcesByTool = new Map<string, string[]>();

  for (const name of allowed) {
    // A name the denylist removes is absent ON PURPOSE (pi applies excludeTools
    // after tools), so it is not a duplicate-source question.
    if (excluded.has(name)) continue;
    const sources: string[] = [];
    if (builtins.has(name)) sources.push("pi's built-in tools");
    for (const ext of extensions) {
      if (ext.tools.has(name)) sources.push(config.capabilityBySource?.[ext.path] ?? ext.path);
    }
    if (sources.length > 0) sourcesByTool.set(name, sources);
  }

  const duplicates = [...sourcesByTool].filter(([, sources]) => sources.length > 1);
  if (duplicates.length === 0) return;

  throw new Error(
    [
      `bob: ${duplicates.length} tool name${duplicates.length === 1 ? " is" : "s are"} provided by more than one source:`,
      ...duplicates.map(([name, sources]) => `  ${name} — ${sources.join(", ")}`),
      "",
      "Which implementation a tool call reaches would depend on pi's load order,",
      "not on the role's policy. Rename the capability's tool, or drop the name from",
      "tools.allow in bob.yaml.",
    ].join("\n"),
  );
}

// Run the whole audit for a freshly created session: the active-tool check
// (passed in so this module does not import run.ts at runtime) plus the
// source check.
export function auditCreatedSession(
  session: AuditSession,
  extensions: AuditExtensions,
  config: Pick<RunSessionConfig, "tools" | "excludeTools" | "capabilityBySource">,
  assertActive: (session: AuditSession) => void,
): void {
  assertActive(session);
  auditToolSources(config, extensions.getExtensions().extensions);
}

// bob#244: the web composition rule on what pi ACTUALLY composed — the loaded
// extensions, the active tools and their sources, the startup context the
// resource loader holds (context files, skills, prompt templates, the system
// prompt and every appended entry), the system prompt pi ASSEMBLED from all of
// it (what the session sends), and the session's history source. Runs with
// the tool audit: at creation, after the mode binds extensions and after every
// reload, because a bind or a reload can add startup context (an extension's
// `resources_discover` skills and prompt templates) that creation never saw. A
// session that holds no web returns at once, and its loader is never read.
//
// History is counted at creation, before anything is built (the factory's
// config view); here it is the history SOURCE that is checked: a session
// manager other than the one checked at creation is history bob cannot
// attribute.
export function auditWebSession(input: {
  session: AuditSession & { sessionManager?: unknown; systemPrompt?: unknown };
  loader: AuditExtensions & StartupSource;
  config: Pick<
    RunSessionConfig,
    "capabilityBySource" | "appendSystemPrompt" | "taskContract" | "standingContract"
  >;
  contractBlock?: string;
  // The session manager whose history the factory counted before building.
  checkedSessionManager: unknown;
}): void {
  const extensions = input.loader.getExtensions().extensions;
  const activeTools = input.session.getActiveToolNames();
  const surface = sessionWebSurface({
    extensions,
    activeTools,
    capabilityBySource: input.config.capabilityBySource,
  });
  if (!holdsWeb(surface)) return;
  const historySourceChanged = input.session.sessionManager !== input.checkedSessionManager;
  const contractSource =
    input.config.taskContract !== undefined
      ? ("task-contract" as const)
      : input.config.standingContract !== undefined
        ? ("standing-contract" as const)
        : undefined;
  assertWebComposition(
    sessionCompositionView({
      extensions,
      activeTools,
      capabilityBySource: input.config.capabilityBySource,
      loader: input.loader,
      soul: input.config.appendSystemPrompt,
      ...(input.contractBlock !== undefined ? { contractBlock: input.contractBlock } : {}),
      ...(contractSource !== undefined ? { contractSource } : {}),
      ...(typeof input.session.systemPrompt === "string"
        ? { assembledSystemPrompt: input.session.systemPrompt }
        : {}),
      restoredHistory: 0,
      historySourceChanged,
    }),
  );
}

// On a failed audit: dispose the session, then end the process with the named
// error. pi's TUI shows a reload error and carries on, so a throw from a reload
// hook would leave a session running whose policy no longer holds. Never
// returns in production (process.exit); a test injects `exit` and sees the
// throw instead.
//
// `what` names the situation for the log line, because a reload or a bind that
// THROWS takes this same path (round 5) and is not literally a policy that
// stopped holding.
//
// The thrown value IS the message when it is not an Error: `undefined` and
// `null` are legal rejection values, and the bare strings "undefined"/"null"
// would name nothing, so those are described instead of stringified (round 6 — a
// promise can reject with `undefined`, and this path must still say what
// arrived).
export function auditOrExit(
  audit: () => void,
  session: { dispose(): void },
  deps?: SessionDeps,
  what = "the session's tool policy no longer holds after binding extensions",
): void {
  try {
    audit();
  } catch (err) {
    // Dispose FIRST, before anything that can itself throw: describing the
    // failure can (a rejection value whose String() throws, or an Error whose
    // message getter does), and nothing may stand between a failed audit and
    // the dispose and exit below.
    try {
      session.dispose();
    } catch {
      // The audit failure is the error that matters; a dispose failure here
      // must not replace it.
    }
    let msg: string;
    try {
      msg =
        err instanceof Error
          ? err.message
          : err === undefined
            ? "the failure arrived with no error value (rejected with undefined)"
            : err === null
              ? "the failure arrived with no error value (rejected with null)"
              : String(err);
    } catch {
      msg = "the failure arrived with a value that cannot be described";
    }
    try {
      const log = deps?.log ?? ((m: string) => console.error(m));
      log(`bob: ${what}; disposing it and ending the process before another turn can run.\n${msg}`);
    } finally {
      (deps?.exit ?? ((code: number) => process.exit(code)))(1);
    }
    throw err;
  }
}

// Run the audit AFTER pi has finished the work that can change the active tool
// set — not in the middle of it, and not against the loader alone. Two pi
// session methods rebuild that set:
//
//   * `session.reload()` awaits the resource loader's reload and THEN rebuilds
//     the session's tool registry from the extensions that came back
//     (agent-session.js: `await this._resourceLoader.reload()` followed by
//     `this._buildRuntime(...)`). An audit hooked into the LOADER therefore runs
//     before that rebuild and reads the OLD active list — a capability that
//     stopped registering a tool is not visible yet;
//   * `session.bindExtensions()` is how the interactive mode hands the session
//     its bindings. pi emits `session_start` (where a capability may switch
//     tools) and then extends its resources from the extensions' discover
//     handlers. pi does NOT reload here, so a loader hook never fires at all for
//     the mode's bind.
//
// So both are wrapped on the SESSION INSTANCE, and both audit after the original
// returns. Because the loader only ever re-reads the isolated sources above, a
// reload cannot pull in anything it did not have at creation.
//
// Round 5: a reload or a bind that THROWS is a FAILED AUDIT. pi's interactive
// mode catches the throw and stays open, so auditing only after success left the
// session serving on a tool state nobody audited — exactly what an audit that
// fails exists to stop. The callback is given the original error in that case,
// and the caller puts it on the same path as a failed audit (dispose + end the
// process with the ORIGINAL error named). Nothing is audited after a throw: the
// state is unknown, so no reading of it can be trusted.
// Round 6: the outcome is a TAG, not an error-or-undefined sentinel. JavaScript
// can reject with `undefined` (`Promise.reject(undefined)`), so "called with no
// argument" and "rejected with undefined" are indistinguishable — the old shape
// took the SUCCESS branch on a failed reload or bind, disposing nothing and
// ending nothing. The wrapper now always states which it is.
export type AuditOutcome = { ok: true } | { ok: false; error: unknown };

export function installSessionAudits(
  session: {
    reload(options?: unknown): Promise<void>;
    bindExtensions(bindings: unknown): Promise<void>;
  },
  audit: (outcome: AuditOutcome) => void,
): void {
  // pi 0.84.3's contract: both are instance methods every mode calls through
  // the instance (agent-session.js :2142, :1831). If a pi upgrade renames
  // either, refuse loudly here rather than wrap nothing.
  if (typeof session.reload !== "function" || typeof session.bindExtensions !== "function") {
    throw new Error(
      "bob: this pi session has no reload()/bindExtensions() to audit after (the pi 0.84.3 contract bob wraps); refusing to start a session whose reloads and binds would go unaudited",
    );
  }
  const runThenAudit = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (err) {
      audit({ ok: false, error: err });
      return;
    }
    audit({ ok: true });
  };

  const originalReload = session.reload.bind(session);
  session.reload = (options?: unknown) => runThenAudit(() => originalReload(options));

  const originalBind = session.bindExtensions.bind(session);
  session.bindExtensions = (bindings: unknown) => runThenAudit(() => originalBind(bindings));
}

export interface BobFactoryInput {
  // The agent's pinned identity + directories. Whatever a resumed, forked,
  // cloned or imported session names, the factory uses THESE.
  config: RunSessionConfig;
  // The effective tool policy (role ceiling ∩ bob.yaml, minus the exclusions).
  policy: ToolPolicy;
  deps?: SessionDeps;
  // Test seam: a pre-built model runtime, so a test can drive a REAL pi session
  // with a scripted provider (a stub model) instead of a network one. Omitted
  // in production, where the runtime is built from the agent's own
  // auth.json/models.json.
  modelRuntime?: unknown;
  // Test seam: the pi session builder (createAgentSessionFromServices). Omitted
  // in production, where pi builds the session from the services above; a test
  // can substitute one that returns a scripted "built" session so it can drive
  // the factory's dispose-on-refusal catch without a process-global module mock.
  buildSession?: typeof createAgentSessionFromServices;
}

// Fail the session if bob's OWN guard extension did not load (#145). pi records
// an extension load failure on the loader and CONTINUES, so a guard that failed
// to load would leave every outgoing request unchecked while the session looked
// healthy — the exact silent-loss shape the guard exists to end. Inline
// extensions are the ones pi names `<inline:...>`; every other extension here is
// a declared capability, which assertCapabilitiesLoaded already covers.
export function assertContractGuardLoaded(
  loader: ExtensionErrorSource,
  guard: InlineExtension | undefined,
): void {
  if (guard === undefined) return;
  const failures = (loader.getExtensions().errors ?? []).filter((e) =>
    e.path.startsWith("<inline:"),
  );
  if (failures.length === 0) return;
  throw new Error(
    [
      `bob: ${failures.length} of bob's own inline extension${failures.length === 1 ? " did" : "s did"} not load:`,
      ...failures.map((f) => `  ${f.path}: ${f.error}`),
      "",
      "The #145 contract guard is registered as an inline extension; without it no request",
      "is checked for the contract, so the session is refused rather than run unguarded.",
    ].join("\n"),
  );
}

/**
 * The literal contract block a session carries in its system prompt, or
 * undefined when it carries none. The one-shot task and the persistent standing
 * contract are mutually exclusive: a session that was started for one task and
 * also claims a standing contract would be carrying two answers to "what am I
 * doing", so that config is refused rather than resolved.
 */
export function contractBlockFor(
  config: Pick<RunSessionConfig, "taskContract" | "standingContract" | "contractCapChars">,
): string | undefined {
  const hasTask = config.taskContract !== undefined;
  const hasStanding = config.standingContract !== undefined;
  if (hasTask && hasStanding) {
    throw new Error(
      "bob: refusing a session config with BOTH a task contract and a standing contract — pass taskContract (a one-shot run) OR standingContract (the persistent runtime), never both",
    );
  }
  if (!hasTask && !hasStanding) return undefined;
  return buildContractBlock({
    label: hasTask ? "TASK" : "STANDING CONTRACT",
    text: (hasTask ? config.taskContract : config.standingContract) as string,
    capChars: config.contractCapChars,
  });
}

// The runtime factory. pi calls it for the initial session and again for every
// /new, /resume, /fork, /clone and /import, so all of those go through the
// pinned identity, the isolated sources and the audit.
export function createBobRuntimeFactory(input: BobFactoryInput): CreateAgentSessionRuntimeFactory {
  const { config, policy } = input;
  const deps = input.deps;
  // pi builds the session from the services above, unless a test injects its own
  // builder. Injectable so a test drives the dispose-on-refusal path with a
  // scripted session instead of a process-global module mock; production passes
  // nothing and gets pi's own builder, exactly as before.
  const buildSession = input.buildSession ?? createAgentSessionFromServices;
  // The #145 contract, built ONCE: the same literal block is appended to the
  // system prompt (through the loader's override) and handed to the guard, so
  // "the request carries the contract" is one string compared with itself.
  const contractBlock = contractBlockFor(config);
  // The guard's deps. The session exists only after the factory has built it,
  // so the holder is filled in below; a guard that fires before then (it cannot
  // — no request is made before the session exists) still ends the process,
  // just without a session to dispose. The holder carries ONLY the dispose
  // target: the guard has no exemption to feed (round 3 deleted the
  // `isCompacting` one, which could pass a real agent request during branch
  // summarization), so there is no per-request session state to read.
  const guardTarget: { session?: { dispose(): void } } = {};
  const guardDeps: ContractGuardDeps = {
    dispose: () => {
      try {
        guardTarget.session?.dispose();
      } catch {
        // the failed contract check is the error that matters
      }
    },
    exit: deps?.exit ?? ((code: number) => process.exit(code)),
    log: deps?.log ?? ((m: string) => console.error(m)),
  };
  const guard =
    contractBlock === undefined
      ? undefined
      : createContractGuardExtension({
          contract: contractBlock,
          deps: () => guardDeps,
        });
  // bob#204: a SETUP session (onboard/align) is the only one that sets
  // `setupSoulPath`; it gets the bob-owned soul-only write tool, bound to the
  // path bob resolved. No other session registers it, so `write_soul` exists
  // exactly where the setup policy grants it.
  const writeSoulExt =
    config.setupSoulPath !== undefined ? createWriteSoulExtension(config.setupSoulPath) : undefined;
  // The active-tool check mirrors run.ts's assertAllowedToolsActive; kept as a
  // parameter so this module does not depend on run.ts at runtime.
  // (round 8, item 4) pi calls this factory AGAIN for `/new`, `/resume`, `/fork`,
  // `/clone` and `/import` (agent-session-runtime.js). The factory consumes the
  // key ONCE, when an invocation first reaches takeOpenrouterApiKey(), into this
  // closure, which outlives a single factory invocation; later invocations reuse
  // it and this factory never re-reads process.env for the key (the first read
  // deleted it, and a re-read would refuse).
  let openrouterKey: string | undefined;
  return async ({ sessionManager }) => {
    // PIN the agent's own identity + directory. A resumed or imported session
    // records its own cwd and agent dir; bob's agent is bob's agent. (A web
    // session's directory is pinned too: to "/", below.)
    const agentDir = config.piAgentDir;

    // bob#230: the confined read, decided FIRST — before any environment change,
    // key read or runtime build — so a resident session whose credential list is
    // unavailable is refused with nothing to undo. Resident = the policy's
    // decision OR the config's resolved one (resident: true, or persistent); the
    // fixed setup session (setupSoulPath) is exempt. Non-resident sessions get
    // pi's own read.
    const confinedRead = confinedReadCustomTools(policy, config);

    // bob#244: the web composition rule on what this session is ABOUT to
    // compose (data-class.ts), decided with the confined read — before any
    // environment change, key read or runtime build — so a web session that
    // would hold private data is refused with nothing to undo and no capability
    // started. It counts the history this session manager already holds: a web
    // session restores none. A session that holds no web is not affected.
    const composing = configCompositionView({
      ...config,
      tools: policy.tools,
      excludeTools: policy.excludeTools,
    });
    const webSession = holdsWeb(composing);
    if (webSession) {
      assertWebComposition({
        ...composing,
        restoredHistory: restoredHistoryEntries(sessionManager),
      });
    }
    // A web session has no workspace: pi's working directory is "/", because
    // every prompt template pi has ends with that directory (data-class.ts).
    // Every other session runs in the agent's own work directory.
    const cwd = webSession ? WEB_SESSION_CWD : config.cwd;

    // bob#214: the model's declared window, for THIS session's provider/model,
    // or a refusal naming the remedy — before any key is read or any runtime
    // built. The compaction threshold becomes pi's own compaction reserve.
    const limits = sessionModelLimits(config);
    const compaction =
      config.compactionThreshold !== undefined
        ? {
            reserveTokens: compactionSettingsFor(limits.contextWindow, config.compactionThreshold)
              .reserveTokens,
          }
        : undefined;

    // Capability config env, then the runtime-mode signal — read by the
    // extensions at load time below. Config only; never a secret.
    for (const [key, value] of Object.entries(config.capabilityEnv)) {
      process.env[key] = value;
    }
    process.env.BOB_PERSISTENT = config.persistent ? "1" : "";
    // The operator's Flair password never enters an agent session: bob's CLI
    // takes it out of the environment at startup (takeFlairAdminPassFromEnv),
    // and every session — onboard's interview, align's check-in, run, launch,
    // persistent — is built here, so this door removes it again for any other
    // entry path before a capability, extension, tool or child process starts.
    delete process.env[ADMIN_PASS_ENV];

    const modelRuntime =
      (input.modelRuntime as ModelRuntime | undefined) ??
      (await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      }));
    // openrouter is bob's OWN provider (round 3): construct it in memory and
    // refuse any on-disk entry, so no `models.json`/`auth.json` field can
    // redirect the endpoint or the key. Runs BEFORE any session exists.
    let openrouterProvider: OpenrouterProviderConfig | undefined;
    if (config.provider === "openrouter") {
      // The on-disk refusal comes FIRST (a config error, before any key read), so a
      // tampered models.json refuses on every entry path without consuming the key.
      assertNoOnDiskOpenrouter(agentDir);
      // (1) KEY OUT OF THE ENVIRONMENT. On the FIRST invocation read
      // OPENROUTER_API_KEY once, then DELETE it from process.env before any
      // capability, extension or tool subprocess starts (pi's ModelRuntime is
      // already created by then) — so pi's
      // BUILT-IN openrouter provider (which reads the key from process.env) has
      // nothing to send, and this factory never reads it from process.env again.
      // Later invocations (replacement sessions: /new, /resume) reuse the value
      // read here and NEVER re-read the environment. Fail-closed on unset/empty is
      // unchanged.
      if (openrouterKey === undefined) openrouterKey = takeOpenrouterApiKey();
      openrouterProvider = registerOpenrouterProvider(modelRuntime, {
        model: config.model,
        piAgentDir: agentDir,
        apiKey: openrouterKey,
      });
      // GUARD THE VERB (round 5, item 1): bob registered its own provider; wrap
      // the runtime's registration verbs so a LATER registerProvider("openrouter")
      // — from session_start, before_agent_start, or a print-mode bind — is
      // refused BEFORE it takes effect. (Refresh is deliberately NOT wrapped;
      // see guardOpenrouterRegistration.)
      guardOpenrouterRegistration(modelRuntime);
    }
    // bob#214: the configured pair resolves with the configured window (and
    // output cap) wherever pi looks it up — here, on a restored session, and when
    // pi refreshes the session's model.
    applyModelLimits(modelRuntime, limits);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: isolatedSettings(compaction),
      modelRuntime,
      resourceLoaderOptions: isolatedLoaderOptions(
        { ...config, ...(contractBlock !== undefined ? { contractBlock } : {}) },
        {
          ...(guard !== undefined ? { guard } : {}),
          ...(writeSoulExt !== undefined ? { toolExtensions: [writeSoulExt] } : {}),
          ...(webSession ? { webSession: true } : {}),
        },
      ),
    });
    // bob asked for these extensions explicitly: a declared capability whose
    // extension did not load is not an optional nicety.
    assertCapabilitiesLoaded(services.resourceLoader, config);
    // And so is the guard: an inline extension that pi failed to load would
    // leave every request unchecked while the session looked healthy.
    assertContractGuardLoaded(services.resourceLoader, guard);
    // Round 4, item 2 / round 6: assert the EFFECTIVE openrouter provider AFTER
    // the services exist — a capability's own `registerProvider` during load would
    // otherwise move the endpoint or the key without bob noticing. pi must hold
    // only bob's PLACEHOLDER key.
    if (config.provider === "openrouter" && openrouterProvider !== undefined) {
      await assertOpenrouterRuntimeUnchanged(modelRuntime as ModelRuntime, {
        model: config.model,
        expected: openrouterProvider,
        apiKey: OPENROUTER_API_KEY_PLACEHOLDER,
      });
    }

    const model = services.modelRuntime.getModel(config.provider, config.model);
    if (!model) {
      throw new Error(
        `model not found: ${config.provider}/${config.model} (check bob.yaml provider/model and ${join(agentDir, "models.json")})`,
      );
    }

    const result = await buildSession({
      services,
      sessionManager,
      model,
      tools: policy.tools,
      ...(policy.excludeTools.length > 0 ? { excludeTools: policy.excludeTools } : {}),
      // bob#230: a resident session that allows `read` gets bob's CONFINED read
      // as a custom tool named `read` — pi registers SDK custom tools after its
      // built-ins and extension tools, so this is where no role can reach pi's
      // unconfined read. Decided above, before any runtime was built.
      ...(confinedRead.length > 0 ? { customTools: confinedRead } : {}),
      // bob#214: the role's (or bob.yaml's) thinking level. pi clamps it to what
      // the model declares and hands it to the provider in its own request shape.
      ...(config.thinking !== undefined ? { thinkingLevel: config.thinking } : {}),
    });

    // The guard's dispose target: the session is now the thing a failed
    // contract check must take down.
    guardTarget.session = result.session as unknown as {
      dispose(): void;
    };

    const assertActive = (session: AuditSession) => {
      assertAllowedToolsActive(session, policy);
    };
    const runAudit = () => {
      auditCreatedSession(
        result.session as unknown as AuditSession,
        services.resourceLoader,
        { ...config, tools: policy.tools, excludeTools: policy.excludeTools },
        assertActive,
      );
      // bob#244: the web composition rule on the composed session (a no-op for
      // a session that holds no web).
      auditWebSession({
        session: result.session as unknown as AuditSession & {
          sessionManager?: unknown;
          systemPrompt?: unknown;
        },
        loader: services.resourceLoader as unknown as AuditExtensions & StartupSource,
        config,
        ...(contractBlock !== undefined ? { contractBlock } : {}),
        checkedSessionManager: sessionManager,
      });
    };

    // Creation: a throw is enough. The caller (run.ts/persistent.ts/the
    // launcher) is about to use the session, so failing loudly here means no
    // turn can run on a policy that does not hold — and dispose the session the
    // factory just built, so no connection or timer outlives the refusal.
    try {
      runAudit();
    } catch (err) {
      try {
        (result.session as unknown as { dispose(): void }).dispose();
      } catch {
        // the audit failure is the error that matters
      }
      throw err;
    }

    // After the mode binds extensions (a bindExtensions) and after EVERY
    // session.reload(): pi's TUI shows a reload error and carries on, so a
    // throw here would leave a running session whose policy no longer holds.
    // Dispose it and end the process with the named error instead. Wrapped on
    // the SESSION, not the loader: pi rebuilds the tool list after the loader's
    // reload returns, so a loader hook audits the state pi is about to replace.
    //
    // Round 5: a reload or a bind that THROWS is a failed audit too. The session
    // may be half-rebuilt and the mode stays open on it, so the original error
    // takes the same path (dispose + end the process, naming THAT error).
    // Round 6: a rejection value of `undefined` takes that same path too — the
    // wrapper tags the outcome, so no rejection value can read as success.
    const disposeSession = () => (result.session as unknown as { dispose(): void }).dispose();
    // Installing the audits can itself refuse (a pi without the entry points it
    // wraps); dispose the session the factory built before propagating, as the
    // creation audit above does.
    try {
      installSessionAudits(
        result.session as unknown as {
          reload(options?: unknown): Promise<void>;
          bindExtensions(bindings: unknown): Promise<void>;
        },
        (outcome) =>
          outcome.ok
            ? auditOrExit(runAudit, { dispose: disposeSession }, deps)
            : auditOrExit(
                () => {
                  throw outcome.error;
                },
                { dispose: disposeSession },
                deps,
                "the session could not be reloaded or bound",
              ),
      );
    } catch (err) {
      try {
        disposeSession();
      } catch {
        // the refusal is the error that matters
      }
      throw err;
    }

    // bob#214: the output-cap backstop and the between-calls compaction check. A session
    // that cannot carry them is disposed and refused, like a failed audit.
    try {
      installSessionBudget(result.session, {
        log: deps?.log ?? ((m: string) => console.error(m)),
      });
    } catch (err) {
      try {
        disposeSession();
      } catch {
        // the refusal is the error that matters
      }
      throw err;
    }

    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };
}

// The active-tool check: every name in the effective policy must be ACTIVE in
// the session. pi ignores an unknown name silently (`setActiveToolsByName`),
// so an allowlisted name nothing registered would just be absent — an
// allowlist that looks enforced and is not.
export function assertAllowedToolsActive(
  session: AuditSession,
  policy: Pick<ToolPolicy, "tools" | "excludeTools">,
): void {
  const allowed = policy.tools;
  const active = new Set(session.getActiveToolNames());
  const excluded = new Set(policy.excludeTools);
  // The other direction too: an ACTIVE tool outside the effective policy fails
  // the audit. pi's registry filter is what keeps the ceiling today; this makes
  // bob's audit a second line rather than a check that trusts it.
  const effective = new Set(allowed.filter((name) => !excluded.has(name)));
  const extra = [...active].filter((name) => !effective.has(name));
  if (extra.length > 0) {
    throw new Error(
      `bob: ${extra.length} active tool${extra.length === 1 ? "" : "s"} outside the effective policy: ${extra.join(", ")} (policy: ${[...effective].join(", ") || "no tools"}). The session is refused rather than run with more than its role allows.`,
    );
  }
  if (allowed.length === 0) return;
  const missing = allowed.filter((name) => !active.has(name) && !excluded.has(name));
  if (missing.length === 0) return;
  throw new Error(
    [
      `bob: ${missing.length} allowlisted tool${missing.length === 1 ? "" : "s"} not active in the session: ${missing.join(", ")}`,
      "",
      "pi enables only the tools the loaded capabilities register, and ignores an",
      "unknown name silently — so a role allowlist naming a tool whose capability",
      "the agent never declared leaves the session quietly missing it.",
      "",
      "Fix: declare the capability in bob.yaml (capabilities:) and configure it, or",
      "drop the name from tools.allow.",
    ].join("\n"),
  );
}

// The minimum of pi's resource loader the capability check needs. Structural so
// tests can hand in a stub without constructing a real loader.
export interface ExtensionErrorSource {
  getExtensions(): { errors: Array<{ path: string; error: string }> };
}

// Fail the session if any capability's extension did not load.
//
// pi records extension load failures on the loader and CONTINUES — the agent
// comes up, just without those tools. bob asked for these extensions
// explicitly, so for bob they are not optional. Errors from extensions bob
// didn't ask for are pi's business and are left alone (and with round 3's
// isolation there should be none: nothing ambient is loaded at all).
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

// Send a prompt as THE text: no command, prompt-template or skill expansion, so
// nothing bob did not declare can interpret it. This is the single prompt
// entry point for every non-interactive path (`bob run`, the persistent
// runtime, the launcher with a prompt, the mail consumer).
export async function promptSession(session: RunSession, text: string): Promise<void> {
  await session.prompt(text, { expandPromptTemplates: false });
}

export interface InteractiveRunInput {
  config: RunSessionConfig;
  policy: ToolPolicy;
  // Sent as the first message once the TUI is up (onboarding / alignment).
  initialMessage?: string;
  deps?: SessionDeps;
  // Test seam: build the mode around the runtime. Defaults to pi's
  // InteractiveMode.
  modeFactory?: (runtime: AgentSessionRuntime) => { run(): Promise<void> };
}

// The interactive path: an AgentSessionRuntime built from the ONE factory,
// handed to pi's InteractiveMode. New, resume, fork, clone and import all go
// through the factory, which pins the agent's identity and directory.
export async function runInteractiveSession(input: InteractiveRunInput): Promise<number> {
  const { config, policy, deps } = input;
  const runtime = await createAgentSessionRuntime(
    createBobRuntimeFactory({ config, policy, deps }),
    {
      cwd: config.cwd,
      agentDir: config.piAgentDir,
      sessionManager: SessionManager.create(config.cwd),
    },
  );
  const mode = input.modeFactory
    ? input.modeFactory(runtime)
    : new InteractiveMode(runtime, {
        startupDiagnostics: [...runtime.diagnostics],
        ...(runtime.modelFallbackMessage
          ? { modelFallbackMessage: runtime.modelFallbackMessage }
          : {}),
        ...(input.initialMessage ? { initialMessage: input.initialMessage } : {}),
      });
  await mode.run();
  return 0;
}
