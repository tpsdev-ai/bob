import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { readProviderLimits } from "../../src/shell/bob-yaml.js";
import { initAgent } from "../../src/shell/init.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";
import { SpawnError, spawnNode } from "../cli-spawn.js";

let tmpRoot: string;
let keysRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "bob-141-"));
  keysRoot = mkdtempSync(join(tmpdir(), "bob-141-keys-"));
});

describe("provider.base_url containment", () => {
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

  it("captures placeholder-only requests with secrets in every credential source, including after refresh", async () => {
    const res = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
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
        ollama: { type: "api_key", key: sentinels[0] },
      }),
    );
    const models = JSON.parse(readFileSync(modelsPath(res.agentDir), "utf8"));
    Object.assign(models.providers.ollama, {
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
      const { config, policy } = resolveRunConfig({ name: "newton", agentsRoot: tmpRoot });
      const result = await createBobRuntimeFactory({ config, policy })({
        sessionManager: SessionManager.inMemory(config.cwd),
      });
      session = result.session as unknown as { dispose(): void };
      await result.session.prompt("hi");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.headers.authorization).toBe(
        "Bearer bob-base-url-placeholder-not-a-secret",
      );
      for (const sentinel of sentinels) expect(JSON.stringify(captured[0])).not.toContain(sentinel);
      const runtime = result.services.modelRuntime as ModelRuntime;
      const model = runtime.getModel("ollama", config.model)!;
      const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as const;
      const options = {
        apiKey: sentinels[3],
        env: { OLLAMA_API_KEY: sentinels[3] },
        headers: { authorization: sentinels[3], "x-api-key": sentinels[3], cookie: sentinels[3] },
        transformHeaders: () => ({ authorization: sentinels[3] }),
      };
      for (const refreshed of [false, true]) {
        if (refreshed) {
          Object.assign(models.providers.ollama, {
            apiKey: sentinels[4],
            headers: { authorization: sentinels[4] },
            oauth: "radius",
          });
          writeFileSync(modelsPath(res.agentDir), JSON.stringify(models));
          writeFileSync(
            join(res.agentDir, ".pi-agent", "auth.json"),
            JSON.stringify({
              ollama: { type: "oauth", access: sentinels[4], refresh: sentinels[4], expires: 0 },
            }),
          );
          await runtime.refresh({ allowNetwork: true, providers: ["ollama"] });
          expect((await runtime.getAuth(model, { apiKey: sentinels[3] }))?.auth.apiKey).toBe(
            "bob-base-url-placeholder-not-a-secret",
          );
          expect(captured).toHaveLength(3);
          models.providers.ollama.baseUrl = undefined;
          writeFileSync(modelsPath(res.agentDir), JSON.stringify(models));
          await runtime.refresh({ allowNetwork: true, providers: ["ollama"] });
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
        expect(request.headers.authorization).toBe("Bearer bob-base-url-placeholder-not-a-secret");
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
  });
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
