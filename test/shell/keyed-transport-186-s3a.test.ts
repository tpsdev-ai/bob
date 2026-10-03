// bob#186 slice 3a — the generic keyed OpenAI-compatible transport, proven on
// `openrouter` (already bob/env) plus an operator fixture loaded from nested
// YAML. No network: every request is driven through a stub fetch.
//
// Fixture row (neutral names): id `keyed-fixture`, alias
// `keyed-fixture-alias`, runtime `keyed-fixture-runtime`, endpoint
// https://keyed-fixture.example/v1, derived variable
// `BOB_PROVIDER_KEYED_FIXTURE_KEY`.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { applyModelScaffold } from "../../src/shell/models.js";
import {
  BOB_CAPABILITY_ENV_PREFIX,
  BOB_ENV_NAME_CONSTANTS,
  BOB_LAUNCHER_EXPORTS,
  bobOwnedEnvironmentNames,
  deriveOperatorVariable,
  isBobOwnedEnvironmentName,
  isOperatorVariableName,
  OPERATOR_VARIABLE_PREFIX,
  OPERATOR_VARIABLE_SUFFIX,
  PI_CREDENTIAL_TABLE,
  piCredentialEnvNames,
} from "../../src/shell/provider-custody.js";
import {
  assertCustodyImplemented,
  CUSTODY_IMPLEMENTATIONS,
  CUSTODY_PINS,
  loadProviderRegistry,
  PROVIDER_RECORDS,
  type ProviderRegistry,
  reservedProviderNames,
} from "../../src/shell/provider-registry.js";
import { assertProviderRunnable, resolveRunConfig } from "../../src/shell/run.js";
import {
  assertKeyedRuntimeUnchanged,
  createBobRuntimeFactory,
  guardedKeyedFetch,
  guardProviderRegistration,
  installKeyedDeferredRefusal,
  type KeyedRow,
  keyedPlaceholder,
  providerKeyConsumedMessage,
  registerKeyedProvider,
  takeProviderKey,
} from "../../src/shell/session.js";

const MODEL = "fixture/model";
const ENDPOINT = "https://keyed-fixture.example/v1";
const RUNTIME = "keyed-fixture-runtime";
const VARIABLE = "BOB_PROVIDER_KEYED_FIXTURE_KEY";
const PLACEHOLDER = "bob-keyed-fixture-placeholder-not-a-secret";
const SENTINEL = "sk-fixture-THIS-IS-A-SENTINEL-KEY-DO-NOT-WRITE";
const SENTINEL2 = "sk-fixture-SECOND-SENTINEL-KEY";

const FIXTURE_YAML = `version: 1
providers:
  - id: keyed-fixture
    aliases: [keyed-fixture-alias]
    runtime: keyed-fixture-runtime
    auth: bob/env
    endpoint: https://keyed-fixture.example/v1
    api: openai-completions
`;

const CTX = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
};

function sse(): string {
  return (
    'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
    'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
    "data: [DONE]\n\n"
  );
}

/** A stub global fetch that records every URL + Authorization. */
function stubFetch() {
  const seen: Array<{ url: string; auth?: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { headers?: HeadersInit }) => {
    const u = typeof url === "string" ? url : (url as { url: string }).url;
    const h = new Headers(init?.headers ?? {});
    seen.push({ url: u, auth: h.get("authorization") ?? undefined });
    return new Response(sse(), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return {
    seen,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

let tmpRoot: string;
let keysRoot: string;
let providerDir: string;
let servers: Server[] = [];
const credentialNames = piCredentialEnvNames();
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "bob-186s3a-"));
  keysRoot = mkdtempSync(join(tmpdir(), "bob-186s3a-keys-"));
  providerDir = mkdtempSync(join(tmpdir(), "bob-186s3a-reg-"));
  for (const name of [...credentialNames, VARIABLE, "KEYED_FIXTURE_API_KEY"]) {
    savedEnv.set(name, process.env[name]);
  }
});
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(keysRoot, { recursive: true, force: true });
  rmSync(providerDir, { recursive: true, force: true });
});

function writeRegistry(text: string): string {
  const path = join(providerDir, "providers.yaml");
  writeFileSync(path, text);
  return path;
}
function fixtureRegistry(): ProviderRegistry {
  return loadProviderRegistry({ path: writeRegistry(FIXTURE_YAML) });
}
function scaffold(name: string, registry: ProviderRegistry) {
  const r = initAgent({
    name,
    role: "coder",
    provider: "keyed-fixture",
    model: MODEL,
    contextWindow: 200_000,
    agentsRoot: tmpRoot,
    flairKeysDir: keysRoot,
    skipFlair: true,
    registry,
  });
  return { agentDir: r.agentDir, piDir: join(r.agentDir, ".pi-agent") };
}
function fixtureRow(registry: ProviderRegistry): KeyedRow {
  const row = registry.find("keyed-fixture");
  if (row === undefined || row.auth.kind !== "env") throw new Error("fixture row missing");
  return {
    id: row.id,
    runtime: row.runtime,
    endpoint: row.endpoint as string,
    api: row.api as string,
    variable: row.auth.variable,
  };
}
async function buildFixtureSession(name: string, registry: ProviderRegistry) {
  scaffold(name, registry);
  const { config, policy } = resolveRunConfig({ name, agentsRoot: tmpRoot, registry });
  const factory = createBobRuntimeFactory({ config, policy, registry });
  const result = await factory({ sessionManager: SessionManager.inMemory(config.cwd) });
  return { config, result };
}

// ── K1–K6: the generic transport, over the fixture ───────────────────────────

describe("K1 — endpoint-only delivery", () => {
  it("the sentinel goes exactly once, only to <endpoint>/chat/completions; pi holds only the placeholder; the variable is gone from the environment and a child process", async () => {
    const registry = fixtureRegistry();
    process.env[VARIABLE] = SENTINEL;
    const stub = stubFetch();
    const { config, result } = await buildFixtureSession("fxk1", registry);
    try {
      const rt = result.services.modelRuntime as unknown as ModelRuntime;
      const model = rt.getModel(RUNTIME, MODEL)!;
      const stream = rt
        .getProvider(RUNTIME)!
        .streamSimple(model as never, CTX as never, {} as never);
      await stream.result?.().catch(() => undefined);
      expect(stub.seen.length).toBe(1);
      expect(stub.seen[0]!.url).toBe(`${ENDPOINT}/chat/completions`);
      expect(stub.seen[0]!.auth).toBe(`Bearer ${SENTINEL}`);
      const auth = await rt.getAuth(RUNTIME);
      expect(auth?.auth?.apiKey).toBe(PLACEHOLDER);
      const blob = JSON.stringify({
        auth,
        cfg: rt.getRegisteredProviderConfig(RUNTIME),
        model: rt.getModel(RUNTIME, MODEL),
      });
      expect(blob).not.toContain(SENTINEL);
      expect(blob).toContain(PLACEHOLDER);
      expect(process.env[VARIABLE]).toBeUndefined();
      const child = spawnSync("printenv", [VARIABLE], { env: process.env, encoding: "utf8" });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stdout).toBe("");
    } finally {
      (result.session as unknown as { dispose(): void }).dispose();
      stub.restore();
      expect(config.provider).toBe(RUNTIME);
    }
  });
});

describe("K2 — redirects are refused; the target receives nothing", () => {
  it("a 3xx refuses and the target is never hit", async () => {
    let otherHit = 0;
    const other = createServer((_req, res) => {
      otherHit++;
      res.end("leaked");
    });
    servers.push(other);
    const otherPort = await new Promise<number>((res) =>
      other.listen(0, "127.0.0.1", () => res((other.address() as { port: number }).port)),
    );
    const stub = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/leak` });
      res.end();
    });
    servers.push(stub);
    const stubPort = await new Promise<number>((res) =>
      stub.listen(0, "127.0.0.1", () => res((stub.address() as { port: number }).port)),
    );
    const base = ((url: unknown, init?: unknown) =>
      fetch(
        String(url).replace(ENDPOINT, `http://127.0.0.1:${stubPort}`),
        init as RequestInit,
      )) as typeof globalThis.fetch;
    const f = guardedKeyedFetch({ id: "keyed-fixture", endpoint: ENDPOINT }, base);
    const err: any = await f(`${ENDPOINT}/chat/completions`, {
      headers: { authorization: `Bearer ${SENTINEL}` },
    }).catch((e: unknown) => e);
    expect(String(err?.message)).toMatch(/redirect/i);
    expect(String(err?.message)).not.toContain(SENTINEL);
    expect(otherHit).toBe(0);
  });
});

describe("K3 — substitution with zero requests and a redacted error", () => {
  it("a credential header from the model or caller, a substituted baseUrl/api, a non-canonical URL and a Request object all refuse", async () => {
    const registry = fixtureRegistry();
    process.env[VARIABLE] = SENTINEL;
    const stub = stubFetch();
    const { result } = await buildFixtureSession("fxk3", registry);
    try {
      const rt = result.services.modelRuntime as unknown as ModelRuntime;
      const provider = rt.getProvider(RUNTIME)!;
      // Substituted baseUrl.
      let res = await provider
        .streamSimple(
          { ...rt.getModel(RUNTIME, MODEL), baseUrl: "https://evil.example/v1" } as never,
          CTX as never,
          {} as never,
        )
        .result?.();
      expect((res as { stopReason?: string })?.stopReason).toBe("error");
      expect(String((res as { errorMessage?: string })?.errorMessage)).toMatch(
        /mismatched endpoint or API/,
      );
      // Substituted api.
      res = await provider
        .streamSimple(
          { ...rt.getModel(RUNTIME, MODEL), api: "anthropic-messages" } as never,
          CTX as never,
          {} as never,
        )
        .result?.();
      expect((res as { stopReason?: string })?.stopReason).toBe("error");
      // Caller credential header.
      res = await provider
        .streamSimple(
          rt.getModel(RUNTIME, MODEL) as never,
          CTX as never,
          {
            headers: { Authorization: "Bearer attacker" },
          } as never,
        )
        .result?.();
      expect(String((res as { errorMessage?: string })?.errorMessage)).toMatch(/Authorization/);
      expect(stub.seen).toEqual([]);
    } finally {
      (result.session as unknown as { dispose(): void }).dispose();
      stub.restore();
    }
    // Non-canonical URL + Request object, direct on the wrapper.
    let called = 0;
    const base = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const f = guardedKeyedFetch({ id: "keyed-fixture", endpoint: ENDPOINT }, base);
    await expect(f(`${ENDPOINT}/%2e%2e/evil`)).rejects.toThrow(/keyed-fixture request/);
    await expect(f(new Request(`${ENDPOINT}/chat/completions`))).rejects.toThrow(/Request object/);
    await expect(f("https://keyed-fixture.example/other/chat/completions")).rejects.toThrow(
      /sends only to/,
    );
    expect(called).toBe(0);
  });
});

describe("K4 / K4b — refresh with a tampered models.json", () => {
  it("after refresh() the fixture's provider is off-endpoint or absent, and no sentinel is sent anywhere", async () => {
    const registry = fixtureRegistry();
    process.env[VARIABLE] = SENTINEL;
    const stub = stubFetch();
    const { config, result } = await buildFixtureSession("fxk4", registry);
    try {
      const rt = result.services.modelRuntime as unknown as ModelRuntime;
      const before = rt.getModel(RUNTIME, MODEL);
      expect(before).toBeDefined();
      const modelsPath = join(config.piAgentDir, "models.json");
      writeFileSync(modelsPath, JSON.stringify({ providers: { [RUNTIME]: { oauth: "radius" } } }));
      await rt.refresh({ allowNetwork: false }).catch(() => undefined);
      const after = rt.getModel(RUNTIME, MODEL);
      expect(after === undefined || after.baseUrl !== ENDPOINT).toBe(true);
      const auth = await rt.getAuth(RUNTIME).catch(() => undefined);
      expect(auth?.auth?.apiKey ?? null).not.toBe(SENTINEL);
      const evil = {
        ...(before as object),
        baseUrl: "https://evil.example/v1",
        api: "openai-completions",
      };
      await rt
        .streamSimple(evil as never, CTX as never, {} as never)
        .result()
        .catch(() => undefined);
      expect(stub.seen.filter((s) => String(s.auth).includes(SENTINEL))).toEqual([]);
    } finally {
      (result.session as unknown as { dispose(): void }).dispose();
      stub.restore();
    }
  });
});

describe("K5 — registration refusal under each fixture name + the post-services check", () => {
  it("register/unregister/native under id, alias and runtime refuse; a moved endpoint is caught", async () => {
    const registry = fixtureRegistry();
    process.env[VARIABLE] = SENTINEL;
    const stub = stubFetch();
    const reserved = reservedProviderNames(registry);
    const { result } = await buildFixtureSession("fxk5", registry);
    try {
      const rt = result.services.modelRuntime as unknown as ModelRuntime;
      const names = ["keyed-fixture", "keyed-fixture-alias", "keyed-fixture-runtime"];
      for (const name of names) {
        expect(() =>
          rt.registerProvider(name, { baseUrl: "https://evil.example/v1" } as never),
        ).toThrow(/refusing.*registerProvider/);
      }
      if (
        typeof (rt as unknown as { unregisterProvider?: unknown }).unregisterProvider === "function"
      ) {
        for (const name of names) {
          expect(() =>
            (rt as never as { unregisterProvider: (id: string) => void }).unregisterProvider(name),
          ).toThrow(/refusing.*unregisterProvider/);
        }
      }
      if (
        typeof (rt as unknown as { registerNativeProvider?: unknown }).registerNativeProvider ===
        "function"
      ) {
        for (const name of names) {
          expect(() =>
            (
              rt as never as { registerNativeProvider: (p: { id: string }) => void }
            ).registerNativeProvider({ id: name }),
          ).toThrow(/refusing.*registerNativeProvider/);
        }
      }
      expect(reserved).toContain("keyed-fixture-runtime");
      expect(rt.getModel(RUNTIME, MODEL)?.baseUrl).toBe(ENDPOINT);
    } finally {
      (result.session as unknown as { dispose(): void }).dispose();
      stub.restore();
    }
  });

  it("the post-services assertion catches a replaced key", async () => {
    const registry = fixtureRegistry();
    const { piDir } = scaffold("fxk5b", registry);
    const rt = await ModelRuntime.create({
      authPath: join(piDir, "auth.json"),
      modelsPath: join(piDir, "models.json"),
    });
    const row = fixtureRow(registry);
    const expected = registerKeyedProvider(rt, {
      row,
      model: MODEL,
      piAgentDir: piDir,
      apiKey: SENTINEL,
    });
    guardProviderRegistration(rt, reservedProviderNames(registry));
    installKeyedDeferredRefusal(rt, row);
    await assertKeyedRuntimeUnchanged(rt, {
      row,
      model: MODEL,
      expected,
      apiKey: PLACEHOLDER,
    });
    const real = rt.getAuth.bind(rt);
    rt.getAuth = (async () => ({ auth: { apiKey: "someone-elses-key" } })) as typeof rt.getAuth;
    await expect(
      assertKeyedRuntimeUnchanged(rt, { row, model: MODEL, expected, apiKey: PLACEHOLDER }),
    ).rejects.toThrow(/apiKey is not bob's placeholder/);
    rt.getAuth = real;
  });
});

describe("K6 — replacement sessions reuse custody without re-reading the environment", () => {
  it("the second factory invocation sends only the FIRST sentinel", async () => {
    const registry = fixtureRegistry();
    scaffold("fxk6", registry);
    process.env[VARIABLE] = SENTINEL;
    const { config, policy } = resolveRunConfig({ name: "fxk6", agentsRoot: tmpRoot, registry });
    const stub = stubFetch();
    const factory = createBobRuntimeFactory({ config, policy, registry });
    const first = await factory({ sessionManager: SessionManager.inMemory(config.cwd) });
    (first.session as unknown as { dispose(): void }).dispose();
    // Between invocations the variable is re-set — the second session must NOT read it.
    process.env[VARIABLE] = SENTINEL2;
    const second = await factory({ sessionManager: SessionManager.inMemory(config.cwd) });
    try {
      expect(process.env[VARIABLE]).toBe(SENTINEL2); // untouched: the factory never re-read it
      const rt = second.services.modelRuntime as unknown as ModelRuntime;
      const model = rt.getModel(RUNTIME, MODEL)!;
      const stream = rt
        .getProvider(RUNTIME)!
        .streamSimple(model as never, CTX as never, {} as never);
      await stream.result?.().catch(() => undefined);
      expect(stub.seen.length).toBe(1);
      expect(stub.seen[0]!.auth).toBe(`Bearer ${SENTINEL}`);
      expect(stub.seen.some((s) => String(s.auth).includes(SENTINEL2))).toBe(false);
    } finally {
      (second.session as unknown as { dispose(): void }).dispose();
      stub.restore();
    }
  });
});

describe("K9 — deferred requests are refused before auth resolution", () => {
  it("fetchDeferred/cancelDeferred for the fixture refuse", async () => {
    const registry = fixtureRegistry();
    process.env[VARIABLE] = SENTINEL;
    const stub = stubFetch();
    const { result } = await buildFixtureSession("fxk9", registry);
    try {
      const rt = result.services.modelRuntime as unknown as ModelRuntime;
      const model = rt.getModel(RUNTIME, MODEL)!;
      if (typeof (rt as unknown as { fetchDeferred?: unknown }).fetchDeferred === "function") {
        await expect(
          (rt as never as { fetchDeferred: (...a: unknown[]) => Promise<unknown> }).fetchDeferred(
            model,
            {},
            {},
          ),
        ).rejects.toThrow(/does not support deferred requests/);
      }
      if (typeof (rt as unknown as { cancelDeferred?: unknown }).cancelDeferred === "function") {
        await expect(
          (rt as never as { cancelDeferred: (...a: unknown[]) => Promise<unknown> }).cancelDeferred(
            model,
            {},
            {},
          ),
        ).rejects.toThrow(/does not support deferred requests/);
      }
      expect(stub.seen).toEqual([]);
    } finally {
      (result.session as unknown as { dispose(): void }).dispose();
      stub.restore();
    }
  });
});

// ── K7: writers check first and preserve passing files ───────────────────────

describe("K7 — the writers run the reserved-name check before the first write", () => {
  const reserved = ["keyed-fixture", "keyed-fixture-alias", "keyed-fixture-runtime"];

  it("a reserved name in models.json refuses at init with no byte changed", () => {
    const registry = fixtureRegistry();
    const { agentDir, piDir } = scaffold("fxk7a", registry);
    const modelsPath = join(piDir, "models.json");
    const before = readFileSync(modelsPath);
    writeFileSync(modelsPath, JSON.stringify({ providers: { "keyed-fixture-runtime": {} } }));
    const tampered = readFileSync(modelsPath);
    expect(() =>
      initAgent({
        name: "fxk7a",
        role: "coder",
        provider: "keyed-fixture",
        model: MODEL,
        contextWindow: 200_000,
        agentsRoot: tmpRoot,
        flairKeysDir: keysRoot,
        skipFlair: true,
        registry,
        noClobber: false,
      }),
    ).toThrow(/providers\.keyed-fixture-runtime/);
    expect(readFileSync(modelsPath)).toEqual(tampered);
    void before;
    void agentDir;
  });

  it("a reserved name in auth.json refuses at init with no byte changed", () => {
    const registry = fixtureRegistry();
    const { piDir } = scaffold("fxk7b", registry);
    const authPath = join(piDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ "keyed-fixture-runtime": { type: "api_key" } }));
    const tampered = readFileSync(authPath);
    expect(() =>
      initAgent({
        name: "fxk7b",
        role: "coder",
        provider: "keyed-fixture",
        model: MODEL,
        contextWindow: 200_000,
        agentsRoot: tmpRoot,
        flairKeysDir: keysRoot,
        skipFlair: true,
        registry,
        noClobber: false,
      }),
    ).toThrow(/auth\.json entry for keyed-fixture-runtime/);
    expect(readFileSync(authPath)).toEqual(tampered);
  });

  it("a keyed init leaves passing files byte-identical", () => {
    const registry = fixtureRegistry();
    const { piDir } = scaffold("fxk7c", registry);
    const modelsPath = join(piDir, "models.json");
    const authPath = join(piDir, "auth.json");
    const modelsBefore = readFileSync(modelsPath);
    const authBefore = readFileSync(authPath);
    initAgent({
      name: "fxk7c",
      role: "coder",
      provider: "keyed-fixture",
      model: MODEL,
      contextWindow: 200_000,
      agentsRoot: tmpRoot,
      flairKeysDir: keysRoot,
      skipFlair: true,
      registry,
      noClobber: false,
    });
    expect(readFileSync(modelsPath)).toEqual(modelsBefore);
    expect(readFileSync(authPath)).toEqual(authBefore);
  });

  it("bob models refuses a reserved name (with a BOM, a `//` comment and a trailing comma) with no byte changed", () => {
    const registryYaml =
      "version: 1\nproviders:\n" +
      "  - id: models-provider\n    aliases: []\n    runtime: models-provider-runtime\n    auth: bob/none\n    endpoint: http://127.0.0.1:11434/v1\n    api: openai-completions\n    override: {}\n" +
      "  - id: keyed-fixture\n    aliases: []\n    runtime: keyed-fixture-runtime\n    auth: bob/env\n    endpoint: https://keyed-fixture.example/v1\n    api: openai-completions\n";
    let i = 0;
    for (const shape of [
      JSON.stringify({ providers: { "keyed-fixture-runtime": {} } }),
      `\uFEFF${JSON.stringify({ providers: { "keyed-fixture-runtime": {} } })}`,
      `// a comment\n{"providers":{"keyed-fixture-runtime":{}},}`,
    ]) {
      const registry = loadProviderRegistry({ path: writeRegistry(registryYaml) });
      const name = `fxk7d${i++}`;
      const r = initAgent({
        name,
        role: "coder",
        provider: "models-provider",
        model: MODEL,
        contextWindow: 200_000,
        baseUrl: "http://127.0.0.1:11434/v1",
        agentsRoot: tmpRoot,
        flairKeysDir: keysRoot,
        skipFlair: true,
        registry,
      });
      const modelsPath = join(r.agentDir, ".pi-agent", "models.json");
      writeFileSync(modelsPath, shape);
      const tampered = readFileSync(modelsPath);
      expect(() => applyModelScaffold(name, tmpRoot, registry)).toThrow(/keyed-fixture-runtime/);
      expect(readFileSync(modelsPath)).toEqual(tampered);
    }
  });

  it("an injected write failure leaves no file and no temp file", () => {
    if (process.getuid?.() === 0) return;
    const registry = fixtureRegistry();
    const { piDir } = scaffold("fxk7e", registry);
    rmSync(join(piDir, "models.json"), { force: true });
    chmodSync(piDir, 0o500);
    try {
      expect(() =>
        initAgent({
          name: "fxk7e",
          role: "coder",
          provider: "keyed-fixture",
          model: MODEL,
          contextWindow: 200_000,
          agentsRoot: tmpRoot,
          flairKeysDir: keysRoot,
          skipFlair: true,
          registry,
          noClobber: false,
        }),
      ).toThrow();
      expect(existsSync(join(piDir, "models.json"))).toBe(false);
      const leftover = readdirSync(piDir).filter((n) => n.includes(".tmp"));
      expect(leftover).toEqual([]);
    } finally {
      chmodSync(piDir, 0o700);
    }
  });
});

// ── K8: the custody gate ─────────────────────────────────────────────────────

describe("K8 — the gate refuses each case with its own reason, controls load", () => {
  it("an unimplemented API refuses; a corrected control loads", () => {
    const bad = writeRegistry(
      "version: 1\nproviders:\n  - id: keyed-fixture\n    aliases: []\n    runtime: keyed-fixture-runtime\n    auth: bob/env\n    endpoint: https://keyed-fixture.example/v1\n",
    );
    expect(() => loadProviderRegistry({ path: bad })).toThrow(/no implemented custody/);
    expect(() => loadProviderRegistry({ path: writeRegistry(FIXTURE_YAML) })).not.toThrow();
  });

  it("a declared variable refuses (any name); a corrected control loads", () => {
    for (const name of ["ACME_KEY", "OPENROUTER_API_KEY", "FLAIR_URL"]) {
      const bad = writeRegistry(
        `version: 1\nproviders:\n  - id: keyed-fixture\n    aliases: []\n    runtime: keyed-fixture-runtime\n    auth: bob/env(${name})\n    endpoint: https://keyed-fixture.example/v1\n    api: openai-completions\n`,
      );
      expect(() => loadProviderRegistry({ path: bad })).toThrow(
        /declares its own environment variable/,
      );
    }
    expect(() => loadProviderRegistry({ path: writeRegistry(FIXTURE_YAML) })).not.toThrow();
  });

  it("a three-way derived collision (a.b / a-b / a_b) refuses; a distinct control loads", () => {
    const rows = ["a.b", "a-b", "a_b"]
      .map(
        (id, i) =>
          `  - id: ${id}\n    aliases: []\n    runtime: rt-${i}\n    auth: bob/env\n    endpoint: https://e${i}.example/v1\n    api: openai-completions\n`,
      )
      .join("");
    const bad = writeRegistry(`version: 1\nproviders:\n${rows}`);
    expect(() => loadProviderRegistry({ path: bad })).toThrow(/derive the same keyed variable/);
    const control = writeRegistry(
      "version: 1\nproviders:\n  - id: a.b\n    aliases: []\n    runtime: rt-0\n    auth: bob/env\n    endpoint: https://e0.example/v1\n    api: openai-completions\n  - id: ab\n    aliases: []\n    runtime: rt-1\n    auth: bob/env\n    endpoint: https://e1.example/v1\n    api: openai-completions\n",
    );
    expect(() => loadProviderRegistry({ path: control })).not.toThrow();
  });

  it("a key present only under a non-derived name is never read", () => {
    const registry = fixtureRegistry();
    scaffold("fxk8d", registry);
    process.env.KEYED_FIXTURE_API_KEY = SENTINEL;
    delete process.env[VARIABLE];
    // resolveRunConfig refuses (the derived variable is unset) and never touches
    // the old-style name.
    expect(() => resolveRunConfig({ name: "fxk8d", agentsRoot: tmpRoot, registry })).toThrow(
      new RegExp(VARIABLE),
    );
    expect(process.env.KEYED_FIXTURE_API_KEY).toBe(SENTINEL);
  });

  it("an id, alias or runtime in pi's catalog refuses; a non-catalog control loads", () => {
    for (const field of ["id", "aliases", "runtime"]) {
      const id = field === "id" ? "groq" : "keyed-fixture";
      const aliases = field === "aliases" ? "[groq]" : "[]";
      const runtime = field === "runtime" ? "groq" : "keyed-fixture-runtime";
      const bad = writeRegistry(
        `version: 1\nproviders:\n  - id: ${id}\n    aliases: ${aliases}\n    runtime: ${runtime}\n    auth: bob/env\n    endpoint: https://keyed-fixture.example/v1\n    api: openai-completions\n`,
      );
      expect(() => loadProviderRegistry({ path: bad })).toThrow(/pi provider identity/);
    }
    expect(() => loadProviderRegistry({ path: writeRegistry(FIXTURE_YAML) })).not.toThrow();
  });

  it("a non-HTTPS endpoint, a root path or a trailing slash refuses; a proper control loads", () => {
    for (const endpoint of [
      "http://keyed-fixture.example/v1",
      "https://keyed-fixture.example/",
      "https://keyed-fixture.example/v1/",
    ]) {
      const bad = writeRegistry(
        `version: 1\nproviders:\n  - id: keyed-fixture\n    aliases: []\n    runtime: keyed-fixture-runtime\n    auth: bob/env\n    endpoint: ${endpoint}\n    api: openai-completions\n`,
      );
      expect(() => loadProviderRegistry({ path: bad })).toThrow(/endpoint/);
    }
    expect(() => loadProviderRegistry({ path: writeRegistry(FIXTURE_YAML) })).not.toThrow();
  });

  it("a pin mismatch refuses (direct unit); the pinned openrouter row loads", () => {
    const shipped = PROVIDER_RECORDS.find((row) => row.id === "openrouter")!;
    expect(() =>
      assertCustodyImplemented([{ ...shipped, endpoint: "https://other.example/v1" }]),
    ).toThrow(/pinned custody/);
    expect(() => assertCustodyImplemented([shipped])).not.toThrow();
  });
});

// ── K10: messages name the row and its variable ──────────────────────────────

describe("K10 — messages name the selected row and its variable", () => {
  it("with the variable unset, run refuses naming the variable", () => {
    const registry = fixtureRegistry();
    scaffold("fxk10a", registry);
    delete process.env[VARIABLE];
    expect(() => resolveRunConfig({ name: "fxk10a", agentsRoot: tmpRoot, registry })).toThrow(
      new RegExp(VARIABLE),
    );
    expect(() => assertProviderRunnable(RUNTIME, "bob hire fxk10a", registry)).toThrow(
      new RegExp(VARIABLE),
    );
  });

  it("the init warning names the variable", () => {
    const registry = fixtureRegistry();
    const realError = console.error;
    const lines: string[] = [];
    console.error = (msg?: unknown) => {
      lines.push(String(msg));
    };
    try {
      initAgent({
        name: "fxk10b",
        role: "coder",
        provider: "keyed-fixture",
        model: MODEL,
        contextWindow: 200_000,
        agentsRoot: tmpRoot,
        flairKeysDir: keysRoot,
        skipFlair: true,
        registry,
      });
    } finally {
      console.error = realError;
    }
    expect(lines.join("\n")).toContain(VARIABLE);
  });

  it("a take after consumption names the row and variable", () => {
    process.env[VARIABLE] = SENTINEL;
    takeProviderKey(VARIABLE, RUNTIME);
    const msg = (() => {
      try {
        takeProviderKey(VARIABLE, RUNTIME);
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(msg).toBe(providerKeyConsumedMessage(VARIABLE, RUNTIME));
    expect(msg).toContain(VARIABLE);
    expect(msg).toContain(RUNTIME);
  });
});

// ── K11: drift tests ─────────────────────────────────────────────────────────

describe("K11 — code-owned tables stay aligned", () => {
  it("every pi catalog provider is classified in bob's credential table", () => {
    const catalog = getBuiltinProviders();
    expect(catalog.length).toBeGreaterThan(0);
    const classified = new Set(PI_CREDENTIAL_TABLE.map((entry) => entry.provider));
    for (const provider of catalog) {
      expect(classified.has(provider)).toBe(true);
    }
    // bob's table also carries names this catalog build omits (meta, radius).
    expect(classified.has("meta")).toBe(true);
    expect(classified.has("radius")).toBe(true);
  });

  it("every launcher export and environment-name constant is in the owned set", () => {
    const initSrc = readFileSync(new URL("../../src/shell/init.ts", import.meta.url), "utf8");
    const launcher = initSrc.split("function renderLauncher")[1] ?? "";
    const exports = [...launcher.matchAll(/export ([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1]);
    expect(exports.length).toBeGreaterThan(0);
    for (const name of exports) expect(isBobOwnedEnvironmentName(name)).toBe(true);
    for (const name of BOB_LAUNCHER_EXPORTS) expect(isBobOwnedEnvironmentName(name)).toBe(true);
    for (const name of BOB_ENV_NAME_CONSTANTS) expect(isBobOwnedEnvironmentName(name)).toBe(true);
  });

  it("the factory's removals read the pi credential table", () => {
    expect(piCredentialEnvNames()).toEqual([
      ...new Set(PI_CREDENTIAL_TABLE.flatMap((entry) => entry.variables)),
    ]);
  });

  it("AMENDMENT 2 — the operator namespace is disjoint from bob's owned names", () => {
    for (const name of bobOwnedEnvironmentNames()) {
      expect(isOperatorVariableName(name)).toBe(false);
    }
    expect(
      isOperatorVariableName(`${OPERATOR_VARIABLE_PREFIX}ACME${OPERATOR_VARIABLE_SUFFIX}`),
    ).toBe(true);
    expect(BOB_CAPABILITY_ENV_PREFIX.startsWith(OPERATOR_VARIABLE_PREFIX)).toBe(false);
    expect(deriveOperatorVariable("keyed-fixture")).toBe(VARIABLE);
  });

  it("AMENDMENT 3 — the namespace is referenced only in the derivation/custody module", () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          entry.name.endsWith(".ts") &&
          readFileSync(path, "utf8").includes(OPERATOR_VARIABLE_PREFIX)
        ) {
          found.push(path);
        }
      }
    };
    walk(new URL("../../src", import.meta.url).pathname);
    const offenders = found.filter((p) => !p.endsWith("provider-custody.ts"));
    expect(offenders).toEqual([]);
  });

  it("the shipped implementation and pins are the ones built", () => {
    expect(CUSTODY_IMPLEMENTATIONS).toEqual(["openai-completions"]);
    expect(CUSTODY_PINS.map((pin) => pin.runtime)).toEqual(["openrouter"]);
    expect(keyedPlaceholder("keyed-fixture")).toBe(PLACEHOLDER);
  });
});

afterAll(() => {
  for (const s of servers) s.close();
});
