import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { readProviderLimits } from "../../src/shell/bob-yaml.js";
import { initAgent } from "../../src/shell/init.js";
import { applyModelScaffold } from "../../src/shell/models.js";
import { PROVIDER_RECORDS, ProviderRegistry } from "../../src/shell/provider-registry.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";
import { SpawnError, spawnNode } from "../cli-spawn.js";

// A NEW keyless row that exists only in this test: the containment sentinel runs
// it through the same real factory as the builtins, proving a row's endpoint and
// adapter reach the scaffold without a name hardcoded under src/.
const NEW_KEYLESS_ROW = {
  id: "acme-local",
  aliases: ["acme"],
  runtime: "acme-local",
  auth: { kind: "none" as const },
  endpoint: "http://acme.internal:11434/v1",
  api: "openai-completions" as const,
  override: {},
};
const NEW_KEYLESS_REGISTRY = new ProviderRegistry([...PROVIDER_RECORDS, NEW_KEYLESS_ROW]);

let tmpRoot: string;
let keysRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "bob-141-"));
  keysRoot = mkdtempSync(join(tmpdir(), "bob-141-keys-"));
});

describe("provider.base_url containment", () => {
  it.each(["?route=chat", "#chat", "?", "#"])(
    "refuses query or fragment %s before writes and at load",
    (suffix) => {
      const baseUrl = `${LOCAL_URL}${suffix}`;
      expect(() => initAgent(baseOpts({ baseUrl }))).toThrow(/query string or fragment/);
      expect(existsSync(join(tmpRoot, "newton"))).toBe(false);
      expect(() =>
        readProviderLimits(`provider:\n  name: ollama\n  base_url: ${baseUrl}\n`),
      ).toThrow(/query string or fragment/);
    },
  );

  it.each([true, false])(
    "repairs pi-valid trailing commas with comments=%s after a startup mismatch",
    async (comments) => {
      const res = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
      const yamlPath = join(res.agentDir, "bob.yaml");
      const appliedUrl = "http://other.example/v1";
      writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace(LOCAL_URL, appliedUrl));
      const models = JSON.parse(readFileSync(modelsPath(res.agentDir), "utf8"));
      const otherModel = {
        ...models.providers.ollama.models[0],
        id: "other",
        name: 'https://kept.example/a//b /* literal */ ",} \\ end',
      };
      models.providers.ollama.models.push(otherModel);
      models.providers.kept = {
        baseUrl: "https://kept.example/v1",
        api: "openai-completions",
        models: [{ ...otherModel, id: "kept" }],
      };
      models.custom = { keep: true };
      const text = JSON.stringify(models, null, 2).replace(/\n(\s*[}\]])/g, ",\n$1");
      writeFileSync(
        modelsPath(res.agentDir),
        `\uFEFF${comments ? "// endpoint configuration\n" : ""}${text}${comments ? "\n// end" : ""}`,
      );
      const start = async () => {
        const { config, policy } = resolveRunConfig({ name: "newton", agentsRoot: tmpRoot });
        const result = await createBobRuntimeFactory({ config, policy })({
          sessionManager: SessionManager.inMemory(config.cwd),
        });
        result.session.dispose();
      };
      await expect(start()).rejects.toThrow(/apply provider.base_url/);
      const output = spawnModels();
      expect(output.includes("comments in models.json were not preserved")).toBe(comments);
      const after = JSON.parse(readFileSync(modelsPath(res.agentDir), "utf8"));
      expect(after).toEqual({
        ...models,
        providers: {
          ...models.providers,
          ollama: {
            ...models.providers.ollama,
            baseUrl: appliedUrl,
            models: [
              {
                ...models.providers.ollama.models[0],
                baseUrl: appliedUrl,
                api: "openai-completions",
              },
              otherModel,
            ],
          },
        },
      });
      await start();
    },
  );

  it.each(["https://ollama.com./v1", "https://ollama.com%2e/v1"])(
    "refuses cloud hostname %s before writes",
    (baseUrl) => {
      expect(() => initAgent(baseOpts({ baseUrl }))).toThrow(/provider.base_url is only allowed/);
      expect(existsSync(join(tmpRoot, "newton"))).toBe(false);
      expect(() =>
        readProviderLimits(`provider:\n  name: ollama\n  base_url: ${baseUrl}\n`),
      ).toThrow(/provider.base_url is only allowed/);
    },
  );

  it.each(["http://new\nton.lan/v1", "http://new\tton.lan/v1", "http://newton.lan/v1\r"])(
    "refuses control characters in %s before writes",
    (baseUrl) => {
      expect(() => initAgent(baseOpts({ baseUrl }))).toThrow(/control characters/);
      expect(existsSync(join(tmpRoot, "newton"))).toBe(false);
    },
  );

  it.each(["\u0085", "\u009f"])("refuses C1 control %s at init and load", (control) => {
    const baseUrl = `http://newton.lan/v1${control}`;
    expect(() => initAgent(baseOpts({ baseUrl }))).toThrow(/C0, DEL, or C1 control characters/);
    expect(existsSync(join(tmpRoot, "newton"))).toBe(false);
    expect(() => readProviderLimits(`provider:\n  name: ollama\n  base_url: ${baseUrl}\n`)).toThrow(
      /C0, DEL, or C1 control characters/,
    );
  });

  it.each(["ollama", "ollama-newton", "omlx"])(
    "bob models repairs an existing %s scaffold without changing other entries or files",
    async (provider) => {
      const res = initAgent(baseOpts({ provider, baseUrl: LOCAL_URL }));
      const yamlPath = join(res.agentDir, "bob.yaml");
      const appliedUrl = "http://other.example/v1";
      writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace(LOCAL_URL, appliedUrl));
      const models = JSON.parse(readFileSync(modelsPath(res.agentDir), "utf8"));
      const otherProvider = {
        baseUrl: "https://kept.example/v1",
        models: [{ id: "kept", custom: true }],
      };
      const otherModel = { id: "other", baseUrl: LOCAL_URL, contextWindow: 42, custom: "keep" };
      models.providers.kept = otherProvider;
      models.providers[provider].models.push(otherModel);
      Object.assign(models.providers[provider].models[0], { baseUrl: LOCAL_URL, custom: "keep" });
      writeFileSync(modelsPath(res.agentDir), JSON.stringify(models));
      writeFileSync(join(res.agentDir, "soul.md"), "# Custom soul\nKeep my persona.\n");
      writeFileSync(
        join(res.agentDir, ".pi-agent", "auth.json"),
        ' { "ollama": { "type": "api_key", "key": "KEEP_ME" } }\n',
      );
      const unchanged = ["soul.md", "bob.yaml", ".pi-agent/auth.json", "bin/newton"];
      const before = unchanged.map((file) => readFileSync(join(res.agentDir, file)));
      const start = async () => {
        const { config, policy } = resolveRunConfig({ name: "newton", agentsRoot: tmpRoot });
        const result = await createBobRuntimeFactory({ config, policy })({
          sessionManager: SessionManager.inMemory(config.cwd),
        });
        result.session.dispose();
      };
      await expect(start()).rejects.toThrow(/apply provider.base_url/);
      spawnModels();
      unchanged.forEach((file, index) => {
        expect(readFileSync(join(res.agentDir, file))).toEqual(before[index]);
      });
      const after = JSON.parse(readFileSync(modelsPath(res.agentDir), "utf8"));
      expect(after.providers.kept).toEqual(otherProvider);
      expect(after.providers[provider].models[1]).toEqual(otherModel);
      expect(after.providers[provider]).toEqual({
        ...models.providers[provider],
        baseUrl: appliedUrl,
        models: [
          {
            ...models.providers[provider].models[0],
            baseUrl: appliedUrl,
            api: "openai-completions",
          },
          otherModel,
        ],
      });
      await start();
    },
  );

  it("bob models scaffolds a missing model while preserving existing models", () => {
    const res = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
    const models = JSON.parse(readFileSync(modelsPath(res.agentDir), "utf8"));
    const otherModel = { id: "other", name: "Other", custom: true };
    models.providers.ollama.models = [otherModel];
    writeFileSync(modelsPath(res.agentDir), JSON.stringify(models));
    spawnModels();
    const after = JSON.parse(readFileSync(modelsPath(res.agentDir), "utf8"));
    expect(after.providers.ollama.models[0]).toEqual(otherModel);
    expect(after.providers.ollama.models[1]).toMatchObject({
      id: "qwen3.8:27b-mxfp8",
      api: "openai-completions",
      baseUrl: LOCAL_URL,
      contextWindow: 262144,
    });
  });

  it("never follows models.json swapped to a symlink before writing", () => {
    const res = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
    const path = modelsPath(res.agentDir);
    const victim = join(tmpRoot, "victim.json");
    const original = '{"untouched":true}\n';
    writeFileSync(victim, original);
    const stringify = JSON.stringify;
    let swapped = false;
    const spy = spyOn(JSON, "stringify").mockImplementation(
      (...args: Parameters<typeof stringify>) => {
        if (!swapped && args[2] === 2) {
          swapped = true;
          unlinkSync(path);
          symlinkSync(victim, path);
        }
        return stringify(...args);
      },
    );
    try {
      applyModelScaffold("newton", tmpRoot);
    } finally {
      spy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe(original);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readdirSync(join(res.agentDir, ".pi-agent")).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it.each(["symlink", "hard link", "directory", "symlinked .pi-agent"])(
    "bob models refuses %s",
    (kind) => {
      const res = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
      const path = modelsPath(res.agentDir);
      const victim = join(tmpRoot, "victim.json");
      const original = readFileSync(path, "utf8");
      writeFileSync(victim, original);
      if (kind === "symlinked .pi-agent") {
        const dir = join(res.agentDir, ".pi-agent");
        rmSync(dir, { recursive: true });
        symlinkSync(tmpRoot, dir);
      } else {
        unlinkSync(path);
        if (kind === "symlink") symlinkSync(victim, path);
        else if (kind === "hard link") linkSync(victim, path);
        else mkdirSync(path);
      }
      expect(() => applyModelScaffold("newton", tmpRoot)).toThrow();
      expect(readFileSync(victim, "utf8")).toBe(original);
    },
  );

  it.each([0o600, 0o640, "missing"])("bob models keeps the mode policy for %s", (mode) => {
    const res = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
    const path = modelsPath(res.agentDir);
    if (mode === "missing") unlinkSync(path);
    else chmodSync(path, mode);
    applyModelScaffold("newton", tmpRoot);
    const fd = openSync(path, "r");
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(mode === "missing" ? 0o600 : mode);
      expect(JSON.parse(readFileSync(fd, "utf8")).providers.ollama.models[0].id).toBe(
        "qwen3.8:27b-mxfp8",
      );
    } finally {
      closeSync(fd);
    }
  });

  it.each([
    ["invalid URL", LOCAL_URL, "ftp://newton.lan/v1", "must be http or https"],
    ["C1 NEL", LOCAL_URL, `${LOCAL_URL}\u0085`, "C0, DEL, or C1 control characters"],
    ["C1 APC", LOCAL_URL, `${LOCAL_URL}\u009f`, "C0, DEL, or C1 control characters"],
    ["invalid limits", "context_window: 262144", "context_window: nope", "positive whole number"],
    ["invalid tools", "  allow:", "  alow:", 'unknown key "alow"'],
  ])("bob models writes nothing for %s", (_label, from, to, error) => {
    const res = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
    const yamlPath = join(res.agentDir, "bob.yaml");
    writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace(from, to));
    const files = [
      "soul.md",
      "bob.yaml",
      ".pi-agent/auth.json",
      ".pi-agent/models.json",
      "bin/newton",
    ];
    const before = files.map((file) => readFileSync(join(res.agentDir, file)));
    expect(spawnModels).toThrow(error);
    files.forEach((file, index) => {
      expect(readFileSync(join(res.agentDir, file))).toEqual(before[index]);
    });
  });

  it("writes canonical URLs to YAML and models.json", () => {
    const res = initAgent(baseOpts({ baseUrl: "HTTP://NEWTON.LAN:80/a/../v1" }));
    const yaml = readFileSync(join(res.agentDir, "bob.yaml"), "utf8");
    expect(yaml).toContain("base_url: http://newton.lan/v1");
    expect(readProviderLimits(yaml).baseUrl).toBe("http://newton.lan/v1");
    expect(
      JSON.parse(readFileSync(modelsPath(res.agentDir), "utf8")).providers.ollama.baseUrl,
    ).toBe("http://newton.lan/v1");
  });

  it.each(["ollama-newton", "omlx"])("pi resolves the scaffolded %s model", async (provider) => {
    const res = initAgent(baseOpts({ provider, baseUrl: LOCAL_URL }));
    const runtime = await ModelRuntime.create({
      authPath: join(res.agentDir, ".pi-agent", "auth.json"),
      modelsPath: modelsPath(res.agentDir),
    });
    expect(runtime.getModel(provider, "qwen3.8:27b-mxfp8")).toMatchObject({
      api: "openai-completions",
      baseUrl: LOCAL_URL,
    });
  });

  it.each(["yaml", "model"])(
    "refuses a %s endpoint mismatch at session startup",
    async (source) => {
      const res = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
      if (source === "yaml") {
        const path = join(res.agentDir, "bob.yaml");
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(LOCAL_URL, "http://other.example/v1"),
        );
      } else {
        const path = modelsPath(res.agentDir);
        const models = JSON.parse(readFileSync(path, "utf8"));
        models.providers.ollama.models[0].baseUrl = "http://other.example/v1";
        writeFileSync(path, JSON.stringify(models));
      }
      const { config, policy } = resolveRunConfig({ name: "newton", agentsRoot: tmpRoot });
      const factory = createBobRuntimeFactory({ config, policy });
      await expect(
        factory({ sessionManager: SessionManager.inMemory(config.cwd) }).then((result) => {
          result.session.dispose();
          return result;
        }),
      ).rejects.toThrow("run bob models <agent> to apply provider.base_url");
    },
  );

  it.each([
    "--base-url",
    "--base-url=",
    "--base-url=   ",
    "--base-url= --base-url=http://newton.lan/v1",
    "--provider=anthropic --base-url=http://other.example/v1",
    "--base-url=ftp://newton.lan/v1",
  ])("rejects invalid CLI input before a dry-run plan: %s", (flag) => {
    let error: unknown;
    try {
      spawnNode(
        [
          join(import.meta.dir, "../../dist/cli.js"),
          "init",
          "newton",
          "--no-flair",
          "--context-window=262144",
          "--dry-run",
          ...flag.split(/ (?=--)/),
        ],
        { env: { ...process.env, HOME: tmpRoot } },
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SpawnError);
    expect((error as SpawnError).code).toBe(2);
    expect((error as SpawnError).stdout).not.toContain("PLAN");
    expect(existsSync(join(tmpRoot, "agents", "newton"))).toBe(false);
  });

  // bob#186 slice 2 (T6): the containment sentinel runs over EVERY effective
  // keyless profile — the three builtins and a new operator row — through the
  // same real factory, both stream verbs and a refresh, with credentials seeded
  // in disk, environment, model and caller options. Only the placeholder reaches
  // the approved endpoint.
  it.each([
    { provider: "ollama", runtime: "ollama" },
    { provider: "ollama-newton", runtime: "ollama-newton" },
    { provider: "omlx", runtime: "omlx" },
    { provider: "acme", runtime: "acme-local", registry: NEW_KEYLESS_REGISTRY },
  ])(
    "captures placeholder-only requests for keyless profile $provider, including after refresh",
    async (profile) => {
      const res = initAgent(
        baseOpts({
          provider: profile.provider,
          baseUrl: LOCAL_URL,
          ...(profile.registry ? { registry: profile.registry } : {}),
        }),
      );
      const sentinels = [
        "SENTINEL_AUTH",
        "SENTINEL_ENV",
        "SENTINEL_MODELS",
        "SENTINEL_OVERRIDE",
        "SENTINEL_REFRESH",
      ];
      writeFileSync(
        join(res.agentDir, ".pi-agent", "auth.json"),
        JSON.stringify({
          [profile.runtime]: { type: "api_key", key: sentinels[0] },
        }),
      );
      const models = JSON.parse(readFileSync(modelsPath(res.agentDir), "utf8"));
      Object.assign(models.providers[profile.runtime], {
        apiKey: sentinels[2],
        headers: { "x-api-key": sentinels[2], cookie: sentinels[2] },
      });
      writeFileSync(modelsPath(res.agentDir), JSON.stringify(models));
      const previousEnv = process.env.OLLAMA_API_KEY;
      process.env.OLLAMA_API_KEY = sentinels[1];
      const realFetch = globalThis.fetch;
      const captured: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        captured.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: String(init?.body),
        });
        return new Response(
          'data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof globalThis.fetch;
      let session: { dispose(): void } | undefined;
      try {
        const { config, policy } = resolveRunConfig({
          name: "newton",
          agentsRoot: tmpRoot,
          ...(profile.registry ? { registry: profile.registry } : {}),
        });
        const result = await createBobRuntimeFactory({
          config,
          policy,
          ...(profile.registry ? { registry: profile.registry } : {}),
        })({
          sessionManager: SessionManager.inMemory(config.cwd),
        });
        session = result.session as unknown as { dispose(): void };
        await result.session.prompt("hi");
        expect(captured).toHaveLength(1);
        expect(captured[0]?.headers.authorization).toBe(
          "Bearer bob-base-url-placeholder-not-a-secret",
        );
        for (const sentinel of sentinels)
          expect(JSON.stringify(captured[0])).not.toContain(sentinel);
        const runtime = result.services.modelRuntime as ModelRuntime;
        const model = runtime.getModel(profile.runtime, config.model)!;
        const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as const;
        const options = {
          apiKey: sentinels[3],
          env: { OLLAMA_API_KEY: sentinels[3] },
          headers: { authorization: sentinels[3], "x-api-key": sentinels[3], cookie: sentinels[3] },
          transformHeaders: () => ({ authorization: sentinels[3] }),
        };
        for (const refreshed of [false, true]) {
          if (refreshed) {
            Object.assign(models.providers[profile.runtime], {
              apiKey: sentinels[4],
              headers: { authorization: sentinels[4] },
              oauth: "radius",
            });
            writeFileSync(modelsPath(res.agentDir), JSON.stringify(models));
            writeFileSync(
              join(res.agentDir, ".pi-agent", "auth.json"),
              JSON.stringify({
                [profile.runtime]: {
                  type: "oauth",
                  access: sentinels[4],
                  refresh: sentinels[4],
                  expires: 0,
                },
              }),
            );
            await runtime.refresh({ allowNetwork: true, providers: [profile.runtime] });
            expect((await runtime.getAuth(model, { apiKey: sentinels[3] }))?.auth.apiKey).toBe(
              "bob-base-url-placeholder-not-a-secret",
            );
            expect(captured).toHaveLength(3);
            models.providers[profile.runtime].baseUrl = undefined;
            writeFileSync(modelsPath(res.agentDir), JSON.stringify(models));
            await runtime.refresh({ allowNetwork: true, providers: [profile.runtime] });
          }
          for (const verb of ["streamSimple", "stream"] as const) {
            const reply = await runtime[verb](
              { ...model, headers: { authorization: sentinels[2] } },
              context as never,
              options as never,
            ).result();
            expect(reply.stopReason).not.toBe("error");
          }
        }
        expect(captured).toHaveLength(5);
        for (const request of captured) {
          expect(request.url).toBe(`${LOCAL_URL}/chat/completions`);
          expect(request.headers.authorization).toBe(
            "Bearer bob-base-url-placeholder-not-a-secret",
          );
          for (const sentinel of sentinels) expect(JSON.stringify(request)).not.toContain(sentinel);
        }
        const bad = await runtime
          .streamSimple(
            { ...model, baseUrl: "http://other.example/v1" },
            context as never,
            options as never,
          )
          .result();
        expect(bad.stopReason).toBe("error");
        expect(bad.errorMessage).toContain("run bob models <agent> to apply provider.base_url");
        expect(captured).toHaveLength(5);
      } finally {
        session?.dispose();
        globalThis.fetch = realFetch;
        if (previousEnv === undefined) delete process.env.OLLAMA_API_KEY;
        else process.env.OLLAMA_API_KEY = previousEnv;
      }
    },
  );
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(keysRoot, { recursive: true, force: true });
});

const baseOpts = (extra: Record<string, unknown> = {}) => ({
  name: "newton",
  role: "ea" as const,
  provider: "ollama",
  model: "qwen3.8:27b-mxfp8",
  contextWindow: 262_144,
  agentsRoot: tmpRoot,
  flairKeysDir: keysRoot,
  skipFlair: true,
  ...extra,
});

const LOCAL_URL = "http://newton.lan:11434/v1";

// models.json for an init with NO base_url — captured byte-for-byte from
// origin/main (5f16dbb). `bob init` without base_url must keep emitting this.
const GOLDEN_NO_BASE_URL = `{
  "providers": {
    "ollama-cloud": {
      "baseUrl": "https://ollama.com/v1",
      "api": "openai-completions",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "kimi-k2.6",
          "name": "kimi-k2.6",
          "reasoning": false,
          "input": [
            "text"
          ],
          "contextWindow": 262144,
          "maxTokens": 16384,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
`;

function modelsPath(agentDir: string): string {
  return join(agentDir, ".pi-agent", "models.json");
}

describe("bob#141 — provider.base_url", () => {
  it("init writes the override into models.json and bob.yaml, idempotently", () => {
    const first = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
    const firstYaml = readFileSync(join(first.agentDir, "bob.yaml"), "utf8");
    const firstModels = readFileSync(modelsPath(first.agentDir), "utf8");
    const parsed = JSON.parse(firstModels) as { providers: Record<string, { baseUrl?: string }> };
    expect(parsed.providers.ollama?.baseUrl).toBe(LOCAL_URL);
    expect(readFileSync(join(first.agentDir, "bob.yaml"), "utf8")).toContain(
      `base_url: ${LOCAL_URL}`,
    );
    expect(
      Object.hasOwn(
        JSON.parse(readFileSync(join(first.agentDir, ".pi-agent", "auth.json"), "utf8")),
        "ollama",
      ),
    ).toBe(true);

    // A second init (--force) keeps the override byte-for-byte.
    const second = initAgent(baseOpts({ baseUrl: LOCAL_URL, noClobber: false }));
    expect(readFileSync(modelsPath(second.agentDir), "utf8")).toBe(firstModels);
    expect(readFileSync(join(second.agentDir, "bob.yaml"), "utf8")).toBe(firstYaml);
  });

  it("init with no base_url leaves models.json unchanged from main", () => {
    const res = initAgent({
      name: "cloudbot",
      role: "ea",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      contextWindow: 262_144,
      agentsRoot: tmpRoot,
      flairKeysDir: keysRoot,
      skipFlair: true,
    });
    expect(readFileSync(modelsPath(res.agentDir), "utf8")).toBe(GOLDEN_NO_BASE_URL);
  });

  it("a keyed provider with base_url is refused at load, naming the rule", () => {
    const yaml = [
      "provider:",
      "  name: anthropic",
      "  model: claude-sonnet-4-6",
      "  base_url: http://evil.example/v1",
      "",
    ].join("\n");
    expect(() => readProviderLimits(yaml)).toThrow(/provider.base_url is only allowed/);
    // ...and refused before init writes anything.
    expect(() =>
      initAgent(
        baseOpts({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          baseUrl: "http://evil.example/v1",
        }),
      ),
    ).toThrow(/provider.base_url is only allowed/);
    expect(existsSync(join(tmpRoot, "newton"))).toBe(false);
  });

  it("an ollama base_url pointing at ollama.com (the keyed cloud) is refused", () => {
    const yaml = [
      "provider:",
      "  name: ollama",
      "  model: m",
      "  base_url: https://ollama.com/v1",
      "",
    ].join("\n");
    expect(() => readProviderLimits(yaml)).toThrow(/provider.base_url is only allowed/);
  });

  it("a URL carrying credentials, or a non-http scheme, is refused", () => {
    const withCreds = [
      "provider:",
      "  name: ollama",
      "  model: m",
      "  base_url: http://user:pass@newton.lan:11434/v1",
      "",
    ].join("\n");
    expect(() => readProviderLimits(withCreds)).toThrow(/must not carry credentials/);
    const withScheme = [
      "provider:",
      "  name: ollama",
      "  model: m",
      "  base_url: ftp://newton.lan:11434/v1",
      "",
    ].join("\n");
    expect(() => readProviderLimits(withScheme)).toThrow(/must be http or https/);
  });
});

function spawnModels(): string {
  return spawnNode([
    join(import.meta.dir, "../../dist/cli.js"),
    "models",
    "newton",
    "--agents-root",
    tmpRoot,
  ]);
}
