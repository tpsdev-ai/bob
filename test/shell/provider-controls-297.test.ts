import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { providerBaseUrlRefusal } from "../../src/shell/bob-yaml.js";
import { runDoctor } from "../../src/shell/doctor.js";
import { initAgent } from "../../src/shell/init.js";
import { applyModelScaffold } from "../../src/shell/models.js";
import { hireAgent } from "../../src/shell/position-runtime.js";
import {
  loadProviderRegistry,
  PROVIDER_RECORDS,
  ProviderRegistry,
} from "../../src/shell/provider-registry.js";
import { declaredProviderModel, resolveRunConfig } from "../../src/shell/run.js";
import {
  assertNoReservedProviderEntries,
  assertOpenrouterRuntimeUnchanged,
  createBobRuntimeFactory,
  guardedOpenrouterFetch,
  guardOpenrouterRegistration,
  OPENROUTER_API_KEY_PLACEHOLDER,
  OPENROUTER_BASE_URL,
  openrouterTransport,
} from "../../src/shell/session.js";
import { spawnNode } from "../cli-spawn.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-297-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const row = {
  id: "keyless-row",
  aliases: ["keyless-alias"],
  runtime: "keyless-runtime",
  auth: { kind: "none" as const },
  endpoint: "http://keyless.example/v1",
  api: "openai-completions" as const,
  override: {},
};
const options = () => ({
  name: "control",
  role: "ea" as const,
  provider: "keyless-alias",
  model: "m",
  contextWindow: 262_144,
  agentsRoot: root,
  skipFlair: true,
});
function operator(fields: string): string {
  const path = join(root, "providers.yaml");
  writeFileSync(
    path,
    `version: 1\nproviders:\n  - id: unselected\n    aliases: []\n    runtime: unselected\n    auth: bob/none\n    ${fields}\ndefaults:\n  onboard: ollama-cloud\n`,
  );
  return path;
}
function errorText(action: () => unknown): string {
  try {
    action();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected refusal");
}

describe("provider controls", () => {
  it("init leaves bob/none out of auth.json without an override", () => {
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row]);
    const result = initAgent({ ...options(), registry });
    expect(
      JSON.parse(readFileSync(join(result.agentDir, ".pi-agent", "auth.json"), "utf8")),
    ).toEqual({});
    expect(readFileSync(join(result.agentDir, "bob.yaml"), "utf8")).not.toContain("base_url:");
    const models = JSON.parse(
      readFileSync(join(result.agentDir, ".pi-agent", "models.json"), "utf8"),
    );
    expect(models.providers[row.runtime].baseUrl).toBe(row.endpoint);
    expect(models.providers[row.runtime].api).toBe(row.api);
  });

  it.each([false, true])(
    "suppresses disk, env, model and caller credentials without base_url (row endpoint absent: %s)",
    async (noEndpoint) => {
      const registry = new ProviderRegistry([
        ...PROVIDER_RECORDS,
        { ...row, ...(noEndpoint ? { endpoint: undefined } : {}) },
      ]);
      const result = initAgent({ ...options(), registry });
      const piDir = join(result.agentDir, ".pi-agent");
      const markers = [
        "AUTH_SECRET_297",
        "ENV_SECRET_297",
        "MODEL_SECRET_297",
        "CALLER_SECRET_297",
      ];
      writeFileSync(
        join(piDir, "auth.json"),
        JSON.stringify({ [row.runtime]: { type: "api_key", key: markers[0] } }),
      );
      const models = JSON.parse(readFileSync(join(piDir, "models.json"), "utf8"));
      Object.assign(models.providers[row.runtime], {
        baseUrl: row.endpoint,
        apiKey: markers[2],
        headers: { authorization: markers[2], "x-api-key": markers[2] },
      });
      writeFileSync(join(piDir, "models.json"), JSON.stringify(models));
      const oldEnv = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = markers[1];
      const originalFetch = globalThis.fetch;
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(
          'data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch;
      let session: { dispose(): void } | undefined;
      try {
        const { config, policy } = resolveRunConfig({
          name: "control",
          agentsRoot: root,
          registry,
        });
        expect(config.providerRecord).toBe(registry.find("keyless-alias"));
        expect(Object.isFrozen(config.providerRecord)).toBe(true);
        const factory = createBobRuntimeFactory({ config, policy, registry });
        Object.defineProperty(config, "providerRecord", {
          value: registry.find("openai"),
        });
        const runtimeResult = await factory({
          sessionManager: SessionManager.inMemory(config.cwd),
        });
        session = runtimeResult.session;
        await runtimeResult.session.prompt("hi");
        const runtime = runtimeResult.services.modelRuntime;
        const model = runtime.getModel(row.runtime, "m")!;
        for (const verb of ["streamSimple", "stream"] as const) {
          const reply = await runtime[verb](
            { ...model, headers: { authorization: markers[2] } },
            { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
            {
              apiKey: markers[3],
              env: { OPENAI_API_KEY: markers[3] },
              headers: { authorization: markers[3], cookie: markers[3] },
              transformHeaders: () => ({ authorization: markers[3] }),
            } as never,
          ).result();
          expect(reply.stopReason).not.toBe("error");
        }
        expect(requests).toHaveLength(3);
        for (const request of requests) {
          expect(request.url).toBe(`${row.endpoint}/chat/completions`);
          expect(new Headers(request.init?.headers).get("authorization")).toBe(
            "Bearer bob-base-url-placeholder-not-a-secret",
          );
          for (const marker of markers) expect(JSON.stringify(request)).not.toContain(marker);
        }
      } finally {
        session?.dispose();
        globalThis.fetch = originalFetch;
        if (oldEnv === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = oldEnv;
      }
    },
  );

  it("refuses a selected row outside the session registry or runtime", () => {
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row]);
    initAgent({ ...options(), registry });
    const { config, policy } = resolveRunConfig({ name: "control", agentsRoot: root, registry });
    const otherRow = registry.find("openai");
    if (otherRow === undefined || config.providerRecord === undefined)
      throw new Error("missing row");
    for (const selected of [otherRow, Object.freeze({ ...config.providerRecord })]) {
      expect(() =>
        createBobRuntimeFactory({
          config: { ...config, providerRecord: selected },
          policy,
          registry,
        }),
      ).toThrow(/selected row/);
    }
  });

  it("refuses a runtime that names another row at operator load", () => {
    const path = join(root, "providers.yaml");
    writeFileSync(
      path,
      "version: 1\nproviders:\n  - id: local\n    aliases: []\n    runtime: exe-dev-gateway\n    auth: bob/none\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/identity "exe-dev-gateway".*local/);
  });

  it.each([false, true])(
    "refuses runtime/name collisions in either row order (alias: %s)",
    (alias) => {
      const first = {
        ...row,
        id: "first",
        aliases: alias ? ["shared"] : [],
        runtime: alias ? "first-runtime" : "shared",
      };
      const second = {
        ...row,
        id: alias ? "second" : "shared",
        aliases: [],
        runtime: alias ? "shared" : "second-runtime",
      };
      for (const records of [
        [first, second],
        [second, first],
      ]) {
        expect(() => new ProviderRegistry(records)).toThrow(/identity "shared".*ambiguous/);
      }
    },
  );

  it("doctor uses the run registry for a keyless endpoint override", () => {
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row]);
    initAgent({ ...options(), registry, baseUrl: row.endpoint });
    expect(
      resolveRunConfig({ name: "control", agentsRoot: root, registry }).config.providerRecord,
    ).toBe(registry.find(row.id));
    const report = runDoctor({
      name: "control",
      agentsRoot: root,
      homeDir: root,
      pathEnv: "",
      registry,
    });
    expect(report.checks.find((check) => check.name === "provider.context_window")?.status).toBe(
      "ok",
    );
  });

  it("permits only the built-in shared-runtime relationship", () => {
    expect(() => new ProviderRegistry()).not.toThrow();
    expect(
      () => new ProviderRegistry([...PROVIDER_RECORDS, { ...row, runtime: "anthropic" }]),
    ).toThrow(/ambiguous/);
    const path = join(root, "providers.yaml");
    writeFileSync(
      path,
      "version: 1\nproviders:\n  - id: operator\n    aliases: []\n    runtime: anthropic\n    auth: bob/none\n    compatibility: [exe-dev-gateway, anthropic]\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/ambiguous/);
    expect(() => new ProviderRegistry(PROVIDER_RECORDS.map((record) => ({ ...record })))).toThrow(
      /reserved for code-owned declarations/,
    );
  });

  it.each([
    "configName: yes",
    "configName: null",
    "configName: []",
    "compatibility: anthropic",
    "compatibility: null",
    "compatibility: [false]",
    "compatibility: ['']",
    "compatibility: [{name: anthropic}]",
    "override: true",
    "override: null",
    "override: []",
    "override: {unknown: true}",
    "override: {excludeHosts: ollama.com}",
    "override: {excludeHosts: null}",
    "override: {excludeHosts: [false]}",
    "override: {excludeHosts: ['']}",
    "override: {excludeHosts: [{host: ollama.com}]}",
    "override: {excludeHosts: ['user:secret@example.com']}",
    "endpoint: []",
    "endpoint: false",
    "api: []",
  ])("validates an optional or nested field on an unselected row: %s", (fields) => {
    expect(() => loadProviderRegistry({ path: operator(fields) })).toThrow(/provider registry/);
  });

  it.each([
    { auth: { kind: "none", variable: "EXTRA" } },
    { auth: { kind: "env", variable: ["OPENROUTER_API_KEY"] } },
    { configName: "true" },
    { compatibility: [1] },
    { override: true },
    { override: { excludeHosts: [false] } },
    { extra: true },
  ])("validates programmatic record shapes: %j", (malformed) => {
    expect(() => new ProviderRegistry([{ ...row, ...malformed } as never])).toThrow(
      /provider registry/,
    );
  });

  it.each(["https://ollama.com/v1", "https://ollama.com./v1"])(
    "names the host policy when an override excludes %s",
    (endpoint) => {
      expect(providerBaseUrlRefusal("ollama", endpoint)).toBe(
        "provider.base_url host is excluded by the provider row’s override.excludeHosts policy.",
      );
      expect(providerBaseUrlRefusal("ollama", "http://localhost:11434/v1")).toBeUndefined();
    },
  );

  it("malformed override policy never authorizes base_url", () => {
    expect(() => {
      const registry = loadProviderRegistry({ path: operator("override: true") });
      initAgent({
        ...options(),
        provider: "unselected",
        baseUrl: "http://local.example/v1",
        registry,
      });
    }).toThrow(/override/);
    expect(() => readFileSync(join(root, "control", "bob.yaml"))).toThrow();
  });

  it("returns frozen copies of all records, nested policies and defaults", () => {
    const input = {
      ...row,
      aliases: [...row.aliases],
      auth: { ...row.auth },
      compatibility: ["peer"],
      override: { excludeHosts: ["cloud.example"] },
    };
    const defaults = { onboard: row.id, hire: row.id };
    const registry = new ProviderRegistry([input], defaults);
    input.aliases.push("changed");
    input.auth.kind = "disk" as never;
    input.override.excludeHosts.push("local.example");
    input.compatibility.push("changed");
    defaults.hire = "changed";
    const selected = registry.find(row.id)!;
    expect(selected.auth.kind).toBe("none");
    expect(selected.aliases).toEqual(row.aliases);
    expect(selected.override?.excludeHosts).toEqual(["cloud.example"]);
    expect(selected.compatibility).toEqual(["peer"]);
    expect(registry.defaults().hire).toBe(row.id);
    for (const value of [
      registry,
      registry.records(),
      selected,
      selected.aliases,
      selected.auth,
      selected.override,
      selected.override?.excludeHosts,
      selected.compatibility,
      registry.defaults(),
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(() => (selected.aliases as string[]).push("mutated")).toThrow();
    expect(registry.find("changed")).toBeUndefined();
  });

  it.each(["models.json", "auth.json"])(
    "checks reserved entries in %s on every factory invocation before creating a runtime",
    async (file) => {
      const result = initAgent({ ...options(), provider: "ollama-cloud" });
      const { config, policy } = resolveRunConfig({ name: "control", agentsRoot: root });
      const factory = createBobRuntimeFactory({ config, policy });
      const create = spyOn(ModelRuntime, "create").mockImplementation(async () => {
        throw new Error("MODEL_RUNTIME_CREATED");
      });
      try {
        for (let invocation = 0; invocation < 2; invocation++) {
          writeFileSync(
            join(result.agentDir, ".pi-agent", file),
            JSON.stringify(
              file === "models.json"
                ? { providers: { openrouter: { apiKey: "disk-secret" } } }
                : { openrouter: { key: "disk-secret" } },
            ),
          );
          const failure = await factory({
            sessionManager: SessionManager.inMemory(config.cwd),
          }).then(
            () => "accepted",
            (err: Error) => err.message,
          );
          expect(failure).toContain(file);
          expect(failure).not.toContain("disk-secret");
          expect(failure).not.toContain("MODEL_RUNTIME_CREATED");
          expect(create).not.toHaveBeenCalled();
        }
      } finally {
        create.mockRestore();
      }
    },
  );

  it.each([
    "endpoint: 'HTTPS://alice:secretmarker297@example.com/path'",
    "auth: secretmarker297",
    "api: secretmarker297",
    "endpoint: 'secretmarker297'",
    "api: {secretmarker297: value}",
  ])("registry refusals redact supplied values: %s", (field) => {
    const path = join(root, "providers.yaml");
    writeFileSync(
      path,
      `version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    ${field.startsWith("auth:") ? "" : "auth: bob/none\n    "}${field}\n`,
    );
    expect(errorText(() => loadProviderRegistry({ path }))).not.toContain("secretmarker297");
  });

  it("parser and disk refusals redact malformed secret-bearing documents", () => {
    const marker = "secretmarker297";
    const path = join(root, "providers.yaml");
    writeFileSync(path, `version: 1\nproviders: []\n${marker}: 1\n${marker}: 2\n`);
    expect(errorText(() => loadProviderRegistry({ path }))).not.toContain(marker);
    writeFileSync(join(root, "auth.json"), `{"key":"${marker}"`);
    expect(errorText(() => assertNoReservedProviderEntries(root, ["openrouter"]))).not.toContain(
      marker,
    );
    expect(providerBaseUrlRefusal("ollama", `http://${marker}:pass@`)).not.toContain(marker);
  });

  it("runtime refusals redact supplied endpoints, APIs and auth failures", async () => {
    const marker = "secretmarker297";
    const transport = openrouterTransport({
      baseUrl: OPENROUTER_BASE_URL,
      api: "openai-completions",
      apiKey: "unused",
    });
    expect(
      errorText(() =>
        transport(
          { baseUrl: `https://user:${marker}@example.com`, api: marker } as never,
          {} as never,
        ),
      ),
    ).not.toContain(marker);
    const runtime = {
      getModel: () => ({ baseUrl: marker, api: marker }),
      getRegisteredProviderConfig: () => ({
        baseUrl: marker,
        api: marker,
        models: [{ baseUrl: marker }],
      }),
      getAuth: async () => {
        throw new Error(marker);
      },
      registerProvider: () => {},
    };
    const failure = await assertOpenrouterRuntimeUnchanged(runtime as never, {
      model: "m",
      expected: { baseUrl: OPENROUTER_BASE_URL, api: "openai-completions" } as never,
      apiKey: OPENROUTER_API_KEY_PLACEHOLDER,
    }).then(
      () => "accepted",
      (err: Error) => err.message,
    );
    expect(failure).not.toContain(marker);
    expect(failure).toContain("refusing");
    guardOpenrouterRegistration(runtime as never);
    expect(
      errorText(() =>
        (runtime.registerProvider as (...args: unknown[]) => void)("openrouter", {
          baseUrl: marker,
        }),
      ),
    ).not.toContain(marker);
  });

  it("request URL and transport-error refusals redact supplied values", async () => {
    const marker = "secretmarker297";
    const guarded = guardedOpenrouterFetch(OPENROUTER_BASE_URL, async () => {
      throw new Error(marker);
    });
    for (const url of [
      marker,
      `HTTPS://alice:${marker}@example.com/path`,
      `https://openrouter.ai/api/v1/%2e%2e/${marker}`,
      `${OPENROUTER_BASE_URL}/chat/completions`,
    ]) {
      const failure = await guarded(url).then(
        () => "accepted",
        (err: Error) => err.message,
      );
      expect(failure).not.toContain(marker);
      expect(failure).not.toBe("accepted");
    }
  });

  it("the CLI validates the registry before reading an admin credential", () => {
    const home = join(root, "home");
    mkdirSync(join(home, ".config", "bob"), { recursive: true });
    writeFileSync(
      join(home, ".config", "bob", "providers.yaml"),
      "version: 1\nproviders:\n  - id: invalid\n    aliases: []\n    runtime: invalid\n    auth: unknown\n",
    );
    const cli = join(import.meta.dir, "../../dist/cli.js");
    const script = `process.env = new Proxy(process.env, { get(target, key) { if (key === 'FLAIR_ADMIN_PASS') throw new Error('CREDENTIAL_READ_297'); return Reflect.get(target, key); } }); process.argv = [process.execPath, ${JSON.stringify(cli)}, 'onboard', 'control']; await import(${JSON.stringify(cli)});`;
    const failure = errorText(() =>
      spawnNode(["-e", script], { env: { ...process.env, HOME: home } }),
    );
    expect(failure).toContain("provider registry");
    expect(failure).not.toContain("CREDENTIAL_READ_297");
  });

  it.each(["help", "down", "restart", "up", "install-service", "login", "logout", "position"])(
    "%s reaches its command handler with an invalid registry",
    (command) => {
      const home = join(root, "home");
      mkdirSync(join(home, ".config", "bob"), { recursive: true });
      writeFileSync(join(home, ".config", "bob", "providers.yaml"), "providers: [");
      let output: string;
      try {
        output = spawnNode([join(import.meta.dir, "../../dist/cli.js"), command], {
          env: { ...process.env, HOME: home },
        });
      } catch (err) {
        output = (err as Error).message;
      }
      expect(output).not.toContain("provider registry");
      expect(output).toContain(command === "help" ? "Usage:" : `bob ${command}:`);
    },
  );

  it("keyless ollama defaults to a local endpoint", () => {
    expect(new ProviderRegistry().find("ollama")?.endpoint).toBe("http://localhost:11434/v1");
  });

  it.each(["https://ollama.com/v1", "https://ollama.com./v1"])(
    "rejects an excluded keyless default endpoint %s by row name",
    (endpoint) => {
      expect(
        () =>
          new ProviderRegistry([{ ...row, endpoint, override: { excludeHosts: ["ollama.com"] } }]),
      ).toThrow(/keyless-row.*excluded/);
    },
  );

  it.each(["https://ollama.com/v1", "https://ollama.com./v1"])(
    "refuses an excluded keyless endpoint from models.json %s",
    async (endpoint) => {
      const registry = new ProviderRegistry([
        { ...row, endpoint: undefined, override: { excludeHosts: ["ollama.com"] } },
      ]);
      initAgent({ ...options(), registry });
      const { config, policy } = resolveRunConfig({ name: "control", agentsRoot: root, registry });
      const modelsPath = join(config.piAgentDir, "models.json");
      const models = JSON.parse(readFileSync(modelsPath, "utf8"));
      models.providers[row.runtime].baseUrl = endpoint;
      writeFileSync(modelsPath, JSON.stringify(models));
      const factory = createBobRuntimeFactory({ config, policy, registry });
      await expect(
        factory({ sessionManager: SessionManager.inMemory(config.cwd) }),
      ).rejects.toThrow(/keyless-row.*excluded/);
    },
  );

  it.each(["[one, two]", "{id: one}"])("doctor reports a non-scalar model %s", (model) => {
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row]);
    const result = initAgent({ ...options(), registry });
    const path = join(result.agentDir, "bob.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("model: m", `model: ${model}`));
    const report = runDoctor({
      name: "control",
      agentsRoot: root,
      homeDir: root,
      pathEnv: "",
      registry,
    });
    expect(report.checks.find((check) => check.name === "provider.context_window")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("provider.model must be a scalar"),
      fix: expect.stringContaining("provider:"),
    });
  });

  it("scaffolds do not invent an adapter when the row declares none", () => {
    const registry = new ProviderRegistry([{ ...row, api: undefined }]);
    const result = initAgent({ ...options(), registry, baseUrl: row.endpoint });
    const path = join(result.agentDir, ".pi-agent", "models.json");
    const contents = readFileSync(path, "utf8");
    expect(JSON.parse(contents).providers[row.runtime].api).toBeUndefined();
    expect(() => applyModelScaffold("control", root, registry)).toThrow(/no supported API/);
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("the hire path uses the selected default through its interview and scaffold", async () => {
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row], { hire: "keyless-alias" });
    const configs: string[] = [];
    const result = await hireAgent({
      name: "hired",
      positionName: "builder",
      agentsRoot: root,
      hostRoot: join(root, "host"),
      skipFlair: true,
      contextWindow: 262_144,
      model: "m",
      registry,
      interview: async (config) => {
        configs.push(config.config.provider);
        return 0;
      },
    });
    expect(configs).toEqual([row.runtime]);
    expect(readFileSync(join(result.agentDir, "bob.yaml"), "utf8")).toContain(
      "name: keyless-alias",
    );
    const models = JSON.parse(
      readFileSync(join(result.agentDir, ".pi-agent", "models.json"), "utf8"),
    );
    expect(models.providers[row.runtime].baseUrl).toBe(row.endpoint);
  });

  it.each(["[one, two]", "{id: one}"])("provider model refuses a non-scalar %s", (value) => {
    expect(() => declaredProviderModel(`provider:\n  model: ${value}\n`)).toThrow(
      /must be a scalar/,
    );
  });

  it("a keyless row named openrouter deletes its runtime credential from the agent environment", async () => {
    const keylessOpenrouter = {
      id: "openrouter",
      aliases: [],
      runtime: "openrouter",
      auth: { kind: "none" as const },
      endpoint: "http://openrouter-keyless.example/v1",
      api: "openai-completions" as const,
      override: {},
    };
    const registry = new ProviderRegistry([keylessOpenrouter]);
    initAgent({ ...options(), provider: "openrouter", registry });
    const { config, policy } = resolveRunConfig({ name: "control", agentsRoot: root, registry });
    expect(config.provider).toBe("openrouter");
    expect(config.providerRecord).toBe(registry.find("openrouter"));
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "keyless-298-sentinel";
    let session: { dispose(): void } | undefined;
    try {
      const result = await createBobRuntimeFactory({ config, policy, registry })({
        sessionManager: SessionManager.inMemory(config.cwd),
      });
      session = result.session as unknown as { dispose(): void };
      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    } finally {
      session?.dispose();
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
  });
});
