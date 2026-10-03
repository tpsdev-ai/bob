import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAgent } from "../../src/shell/init.js";
import {
  PROVIDER_RECORDS,
  ProviderRegistry,
  providerEndpoint,
  resolveRuntimeProviderName,
} from "../../src/shell/provider-registry.js";
import {
  assertProviderRunnable,
  mapBobProviderToPi,
  resolveRunConfig,
} from "../../src/shell/run.js";

// A row that exists only in this test: a new alias ("acme") for a provider
// whose runtime identity and endpoint no mapper under src/ names.
const TEST_ROW = {
  id: "acme-gateway",
  aliases: ["acme"],
  runtime: "acme-runtime",
  auth: { kind: "none" as const },
  endpoint: "http://acme.test/v1",
  api: "openai-completions" as const,
};

const registry = () => new ProviderRegistry([...PROVIDER_RECORDS, TEST_ROW]);

describe("provider registry — a new row reaches both resolutions (bob#186 slice 1)", () => {
  let tmpRoot: string;
  let keysRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "bob-186-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-186-keys-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  const baseOpts = (extra: Record<string, unknown> = {}) => ({
    name: "acmebot",
    role: "ea" as const,
    model: "test-model",
    contextWindow: 262_144,
    agentsRoot: tmpRoot,
    flairKeysDir: keysRoot,
    skipFlair: true,
    ...extra,
  });

  it("the init scaffold resolves the row's alias and writes its endpoint", () => {
    const res = initAgent(baseOpts({ provider: "acme", registry: registry() }));
    const models = JSON.parse(
      readFileSync(join(res.agentDir, ".pi-agent", "models.json"), "utf8"),
    ) as { providers: Record<string, { baseUrl?: string; models: { id: string }[] }> };
    // The alias resolved to the row's runtime identity, and the row's endpoint
    // was written — neither "acme-gateway" nor the endpoint appears in init.ts.
    expect(models.providers["acme-runtime"]?.baseUrl).toBe("http://acme.test/v1");
    expect(models.providers["acme-runtime"]?.models[0]?.id).toBe("test-model");
    expect(readFileSync(join(res.agentDir, "bob.yaml"), "utf8")).toContain("name: acme");
  });

  it("run resolution resolves the same alias to the same runtime identity", () => {
    initAgent(baseOpts({ provider: "acme", registry: registry() }));
    expect(mapBobProviderToPi("acme", registry())).toBe("acme-runtime");
    const { provider } = resolveRunConfig({
      name: "acmebot",
      agentsRoot: tmpRoot,
      registry: registry(),
    });
    expect(provider).toBe("acme-runtime");
  });

  it("runnability and run resolution use the selected registry auth", () => {
    const selected = new ProviderRegistry([
      { ...TEST_ROW, id: "openrouter", aliases: [], runtime: "openrouter" },
    ]);
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => assertProviderRunnable("openrouter", "test", selected)).not.toThrow();
      initAgent(baseOpts({ provider: "openrouter", registry: selected }));
      expect(
        resolveRunConfig({ name: "acmebot", agentsRoot: tmpRoot, registry: selected }).provider,
      ).toBe("openrouter");
    } finally {
      if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedKey;
    }
  });

  it("a duplicate id or alias fails validation, naming the name", () => {
    expect(
      () =>
        new ProviderRegistry([
          ...PROVIDER_RECORDS,
          { ...TEST_ROW, id: "ollama-cloud", aliases: [] },
        ]),
    ).toThrow(/duplicate identity "ollama-cloud"/);
    expect(
      () => new ProviderRegistry([...PROVIDER_RECORDS, { ...TEST_ROW, aliases: ["ollama-cloud"] }]),
    ).toThrow(/duplicate identity "ollama-cloud"/);
  });

  it("an alias shared by two rows fails validation, naming the alias", () => {
    expect(
      () =>
        new ProviderRegistry([TEST_ROW, { ...TEST_ROW, id: "other-gateway", runtime: "openai" }]),
    ).toThrow(/duplicate identity "acme".*"acme-gateway".*"other-gateway"/);
  });

  it("the built-in rows keep their mappings", () => {
    expect(mapBobProviderToPi("exe-dev-gateway")).toBe("anthropic");
    expect(resolveRuntimeProviderName("exe-dev-gateway")).toBe("anthropic");
    expect(providerEndpoint("ollama-cloud")).toBe("https://ollama.com/v1");
  });

  it("a bob/env row whose runtime has no implemented custody fails validation (bob#186 slice 2)", () => {
    // On main this constructs fine: auth is optional and nothing checks custody.
    expect(
      () =>
        new ProviderRegistry([
          ...PROVIDER_RECORDS,
          {
            id: "acme-keyed",
            aliases: [],
            runtime: "acme",
            auth: { kind: "env", variable: "ACME_KEY" },
          },
        ] as never),
    ).toThrow(/no implemented custody/);
  });
});
