// bob#186 slice 1 — one provider registry.
//
// A row added to the table supplies a NEW alias and endpoint to BOTH the init
// scaffold and run's resolution, without an edit to either mapper; a duplicate
// id or alias fails validation by name.
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
import { mapBobProviderToPi, resolveRunConfig } from "../../src/shell/run.js";

// A row that exists only in this test: a new alias ("acme") for a provider
// whose runtime identity and endpoint no mapper under src/ names.
const TEST_ROW = {
  id: "acme-gateway",
  aliases: ["acme"],
  runtime: "anthropic",
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
    expect(models.providers.anthropic?.baseUrl).toBe("http://acme.test/v1");
    expect(models.providers.anthropic?.models[0]?.id).toBe("test-model");
    expect(readFileSync(join(res.agentDir, "bob.yaml"), "utf8")).toContain("name: acme");
  });

  it("run resolution resolves the same alias to the same runtime identity", () => {
    initAgent(baseOpts({ provider: "acme", registry: registry() }));
    expect(mapBobProviderToPi("acme", registry())).toBe("anthropic");
    const { provider } = resolveRunConfig({
      name: "acmebot",
      agentsRoot: tmpRoot,
      registry: registry(),
    });
    expect(provider).toBe("anthropic");
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

  it("the built-in rows keep their mappings", () => {
    expect(mapBobProviderToPi("exe-dev-gateway")).toBe("anthropic");
    expect(resolveRuntimeProviderName("exe-dev-gateway")).toBe("anthropic");
    expect(providerEndpoint("ollama-cloud")).toBe("https://ollama.com/v1");
  });
});
