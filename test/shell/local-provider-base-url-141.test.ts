// bob#141 — a keyless local model endpoint via bob.yaml `provider.base_url`.
//
// An agent on a home-lab Ollama host needs `providers.<name>.baseUrl` in
// `.pi-agent/models.json`, which a hand edit sets and the next `bob init`
// reverts. `bob init` now writes it from `provider.base_url`, and a base_url is
// allowed ONLY for a keyless local provider — a keyed provider's key must never
// be sent to a URL bob.yaml can redirect (the lesson of the openrouter rounds,
// #184).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProviderLimits } from "../../src/shell/bob-yaml.js";
import { initAgent } from "../../src/shell/init.js";

let tmpRoot: string;
let keysRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "bob-141-"));
  keysRoot = mkdtempSync(join(tmpdir(), "bob-141-keys-"));
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

describe("bob#141 — provider.base_url for a keyless local provider", () => {
  it("init writes the override into models.json and bob.yaml, idempotently", () => {
    const first = initAgent(baseOpts({ baseUrl: LOCAL_URL }));
    const firstModels = readFileSync(modelsPath(first.agentDir), "utf8");
    const parsed = JSON.parse(firstModels) as { providers: Record<string, { baseUrl?: string }> };
    expect(parsed.providers.ollama?.baseUrl).toBe(LOCAL_URL);
    expect(readFileSync(join(first.agentDir, "bob.yaml"), "utf8")).toContain(
      `base_url: ${LOCAL_URL}`,
    );
    // A placeholder auth entry is written (the local server ignores the key).
    expect(
      Object.hasOwn(
        JSON.parse(readFileSync(join(first.agentDir, ".pi-agent", "auth.json"), "utf8")),
        "ollama",
      ),
    ).toBe(true);

    // A second init (--force) keeps the override byte-for-byte.
    const second = initAgent(baseOpts({ baseUrl: LOCAL_URL, noClobber: false }));
    expect(readFileSync(modelsPath(second.agentDir), "utf8")).toBe(firstModels);
    expect(readFileSync(join(second.agentDir, "bob.yaml"), "utf8")).toBe(
      readFileSync(join(first.agentDir, "bob.yaml"), "utf8"),
    );
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
    expect(() => readProviderLimits(yaml)).toThrow(/keyless local provider/);
    // ...and refused before init writes anything.
    expect(() =>
      initAgent(
        baseOpts({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          baseUrl: "http://evil.example/v1",
        }),
      ),
    ).toThrow(/keyless local provider/);
  });

  it("an ollama base_url pointing at ollama.com (the keyed cloud) is refused", () => {
    const yaml = [
      "provider:",
      "  name: ollama",
      "  model: m",
      "  base_url: https://ollama.com/v1",
      "",
    ].join("\n");
    expect(() => readProviderLimits(yaml)).toThrow(/keyless local provider/);
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
