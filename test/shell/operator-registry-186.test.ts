import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerBaseUrlRefusal } from "../../src/shell/bob-yaml.js";
import { initAgent } from "../../src/shell/init.js";
import {
  CUSTODY_IMPLEMENTATIONS,
  DEFAULT_PROVIDER_REGISTRY,
  defaultProviderName,
  loadProviderRegistry,
  PI_LOGIN_OWNED,
  PROVIDER_RECORDS,
  ProviderRegistry,
  providerReadsKeyFromEnv,
  reservedProviderNames,
  resolveRuntimeProviderName,
} from "../../src/shell/provider-registry.js";
import { mapBobProviderToPi } from "../../src/shell/run.js";
import { assertNoReservedProviderEntries } from "../../src/shell/session.js";

let tmpRoot: string;
let keysRoot: string;
let providerDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "bob-186s2-"));
  keysRoot = mkdtempSync(join(tmpdir(), "bob-186s2-keys-"));
  providerDir = mkdtempSync(join(tmpdir(), "bob-186s2-reg-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(keysRoot, { recursive: true, force: true });
  rmSync(providerDir, { recursive: true, force: true });
});

function writeRegistry(text: string): string {
  const path = join(providerDir, "providers.yaml");
  writeFileSync(path, text);
  return path;
}

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

// ── T1: validation before effects ─────────────────────────────────────────────

describe("T1 — the operator loader validates every row before returning", () => {
  it("an absent DEFAULT file uses the classified builtins", () => {
    const reg = loadProviderRegistry({ path: join(providerDir, "missing.yaml") });
    expect(reg.find("openrouter")?.auth).toEqual({
      kind: "env",
      variable: "OPENROUTER_API_KEY",
    });
    expect(reg.find("ollama")?.auth).toEqual({ kind: "none" });
  });

  it("an EXPLICITLY requested missing file refuses", () => {
    expect(() =>
      loadProviderRegistry({ path: join(providerDir, "missing.yaml"), explicit: true }),
    ).toThrow(/could not read/);
  });

  it("a row without an auth mode refuses", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/auth/);
  });

  it("an unknown auth mode refuses", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/magic\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/unknown auth mode/);
  });

  it.each(["pi/disk", "pi/login", "bob/vm"])(
    "refuses operator auth %s even for a fresh identity",
    (auth) => {
      const path = writeRegistry(
        `version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: ${auth}\n`,
      );
      expect(() => loadProviderRegistry({ path })).toThrow(
        `row "acme" auth "${auth}" is reserved for code-owned declarations`,
      );
      expect(() => loadProviderRegistry({ path })).toThrow(/Remedy:/);
    },
  );

  it.each(PI_LOGIN_OWNED)(
    "refuses pi-owned identity %s in every operator name field",
    (identity) => {
      for (const field of ["id", "aliases", "runtime"]) {
        const id = field === "id" ? identity : "acme";
        const aliases = field === "aliases" ? `[${identity}]` : "[]";
        const runtime = field === "runtime" ? identity : "acme-runtime";
        const path = writeRegistry(
          `version: 1\nproviders:\n  - id: ${id}\n    aliases: ${aliases}\n    runtime: ${runtime}\n    auth: bob/none\n`,
        );
        expect(() => loadProviderRegistry({ path })).toThrow(
          `row "${id}" ${field} collides with pi-owned identity "${identity}"`,
        );
        expect(() => loadProviderRegistry({ path })).toThrow(/Remedy:/);
      }
    },
  );

  it("refuses a pi/login row using pi-owned runtime xai", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: xai\n    auth: pi/login\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(
      /row "acme" runtime collides with pi-owned identity "xai".*Remedy:/,
    );
  });

  it.each([false, true])("refuses pi-owned remapping with onboard default=%s", (selected) => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: xai\n    aliases: [github-copilot]\n    runtime: attacker-llm\n    auth: pi/login\n" +
        (selected ? "defaults:\n  onboard: xai\n" : ""),
    );
    expect(() => loadProviderRegistry({ path })).toThrow(
      /row "xai" id collides with pi-owned identity "xai".*Remedy:/,
    );
  });

  it.each(["disk", "login", "vm"])("refuses a copied builtin with auth %s", (kind) => {
    const builtin = PROVIDER_RECORDS.find((record) => record.auth.kind === kind);
    expect(builtin).toBeDefined();
    expect(() => new ProviderRegistry([builtin!])).not.toThrow();
    expect(() => new ProviderRegistry([{ ...builtin! }])).toThrow(
      /reserved for code-owned declarations.*Remedy:/,
    );
  });

  it("the obsolete gateway/envKey flags name the explicit auth remedy", () => {
    for (const flag of ["envKey", "gateway"]) {
      const path = writeRegistry(
        `version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\n    ${flag}: true\n`,
      );
      expect(() => loadProviderRegistry({ path })).toThrow(
        `row "acme" declares the obsolete "${flag}" flag — use an explicit auth mode.`,
      );
    }
  });

  it("malformed ids, aliases, runtimes, endpoints and adapters refuse", () => {
    const bad = [
      { row: "id: ''\n    aliases: []\n    runtime: acme", message: /invalid provider id/ },
      { row: "id: acme\n    aliases: ['']\n    runtime: acme", message: /invalid alias/ },
      { row: "id: acme\n    aliases: []\n    runtime: ''", message: /invalid runtime/ },
      {
        row: "id: acme\n    aliases: []\n    runtime: acme\n    endpoint: 'not a url'",
        message: /endpoint/,
      },
      {
        row: "id: acme\n    aliases: []\n    runtime: acme\n    api: acme-messages",
        message: /unsupported adapter/,
      },
    ];
    for (const { row, message } of bad) {
      const path = writeRegistry(`version: 1\nproviders:\n  - ${row}\n    auth: bob/none\n`);
      expect(() => loadProviderRegistry({ path })).toThrow(message);
    }
  });

  it("a duplicate identity refuses, naming both holders", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\n  - id: acme\n    aliases: []\n    runtime: other\n    auth: bob/none\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/duplicate identity "acme"/);
  });

  it("an INVALID UNSELECTED row refuses the whole registry", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: good\n    aliases: [good-alias]\n    runtime: good\n    auth: bob/none\n  - id: bad\n    aliases: []\n    runtime: bad\n    auth: bob/nope\n",
    );
    // Not a `defaults` target; still validated.
    expect(() => loadProviderRegistry({ path })).toThrow(/unknown auth mode/);
  });

  it("an invalid default reference refuses", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\ndefaults:\n  onboard: nope\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/defaults\.onboard/);
  });

  it("a wrong version or unknown top-level field refuses", () => {
    expect(() =>
      loadProviderRegistry({ path: writeRegistry("version: 2\nproviders: []\n") }),
    ).toThrow(/version must be 1/);
    expect(() =>
      loadProviderRegistry({ path: writeRegistry("version: 1\nproviders: []\nx: 1\n") }),
    ).toThrow(/unknown field/);
  });

  it("a real parser refuses duplicate keys, tags, aliases and merge keys", () => {
    const docs = [
      "version: 1\nversion: 1\nproviders: []\n",
      "version: 1\nproviders: []\nx: !!acme y\n",
      "version: 1\nproviders: []\na: &x 1\nb: *x\n",
      "version: 1\nproviders: []\nbase: &b {a: 1}\nc:\n  <<: *b\n",
    ];
    for (const doc of docs) {
      expect(() => loadProviderRegistry({ path: writeRegistry(doc) })).toThrow(/provider registry/);
    }
  });
});

// ── T2: custody is implemented, not asserted ─────────────────────────────────

describe("T2 — a bob/env row loads only against an implemented custody descriptor", () => {
  it("the shipped openrouter row matches the one implementation", () => {
    expect(CUSTODY_IMPLEMENTATIONS.map((d) => d.runtime)).toEqual(["openrouter"]);
    const row = DEFAULT_PROVIDER_REGISTRY.find("openrouter");
    expect(row?.auth).toEqual({ kind: "env", variable: "OPENROUTER_API_KEY" });
    expect(row?.endpoint).toBe(CUSTODY_IMPLEMENTATIONS[0]?.endpoint);
    expect(providerReadsKeyFromEnv("openrouter")).toBe(true);
  });

  it("bob/env for a runtime with no implementation refuses", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/env(ACME_KEY)\n    endpoint: https://acme.example/v1\n    api: openai-completions\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/no implemented custody/);
  });

  it("bob/env with the wrong variable or endpoint refuses", () => {
    const shipped = PROVIDER_RECORDS.find((row) => row.id === "openrouter")!;
    for (const mismatch of [
      { auth: { kind: "env" as const, variable: "ACME_KEY" } },
      { endpoint: "https://other.example/v1" },
      { api: undefined },
    ]) {
      expect(() => new ProviderRegistry([{ ...shipped, ...mismatch }])).toThrow(
        /does not match.*descriptor/,
      );
    }
  });

  it("operator data cannot downgrade the builtin openrouter row to pi/disk", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: openrouter\n    aliases: []\n    runtime: openrouter\n    auth: pi/disk\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/duplicate identity "openrouter"/);
  });

  it("bob/env sharing a pi-login runtime refuses (no custody attaches to it)", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: xai-keyed\n    aliases: []\n    runtime: xai\n    auth: bob/env(XAI_KEY)\n    endpoint: https://xai.example/v1\n    api: openai-completions\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(
      /row "xai-keyed" runtime collides with pi-owned identity "xai".*Remedy:/,
    );
  });

  it("a keyed row may not authorize a base_url override", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/env(ACME_KEY)\n    override: {}\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/override policy/);
  });
});

// ── T3: the reserved set is derived from the registry ─────────────────────────

describe("T3 — the disk-refusal set comes from the registry, by name", () => {
  it("the reserved set is every bob/env row's id, aliases and runtime", () => {
    expect(reservedProviderNames()).toEqual(["openrouter"]);
    const shipped = PROVIDER_RECORDS.find((row) => row.id === "openrouter")!;
    const synthetic = new ProviderRegistry([
      { ...shipped, id: "custody-row", aliases: ["custody-alias"] },
      { id: "keyless", aliases: [], runtime: "keyless", auth: { kind: "none" } },
    ]);
    expect(reservedProviderNames(synthetic)).toEqual([
      "custody-row",
      "custody-alias",
      "openrouter",
    ]);
  });

  it("refuses each reserved name in either file, for empty, null and placeholder values", () => {
    for (const value of ["{}", "null", '"placeholder"', '{"type":"api_key","key":"sk-x"}']) {
      const models = join(providerDir, "models.json");
      writeFileSync(models, `{"providers":{"openrouter":${value}}}`);
      expect(() => assertNoReservedProviderEntries(providerDir, ["openrouter"])).toThrow(
        /providers\.openrouter/,
      );
      rmSync(models, { force: true });
      const auth = join(providerDir, "auth.json");
      writeFileSync(auth, `{"openrouter":${value}}`);
      expect(() => assertNoReservedProviderEntries(providerDir, ["openrouter"])).toThrow(
        /stored openrouter credential/,
      );
      rmSync(auth, { force: true });
    }
  });

  it("missing files are allowed; unrelated pi records are preserved", () => {
    writeFileSync(
      join(providerDir, "models.json"),
      JSON.stringify({ providers: { ollama: { models: [] }, anthropic: { models: [] } } }),
    );
    writeFileSync(join(providerDir, "auth.json"), JSON.stringify({ openai: { type: "api_key" } }));
    expect(() => assertNoReservedProviderEntries(providerDir, ["openrouter"])).not.toThrow();
  });

  it("a structurally invalid or unparseable document refuses", () => {
    const models = join(providerDir, "models.json");
    writeFileSync(models, "[]");
    expect(() => assertNoReservedProviderEntries(providerDir, ["openrouter"])).toThrow(
      /not a JSON object/,
    );
    writeFileSync(models, '{"providers":[]}');
    expect(() => assertNoReservedProviderEntries(providerDir, ["openrouter"])).toThrow(
      /providers is not a mapping/,
    );
    writeFileSync(models, "// comment\n{}");
    expect(() => assertNoReservedProviderEntries(providerDir, ["openrouter"])).toThrow(
      /could not parse it/,
    );
    rmSync(models, { force: true });
  });

  it("an unreadable file refuses rather than reading as absent", () => {
    if (process.getuid?.() === 0) return;
    const auth = join(providerDir, "auth.json");
    writeFileSync(auth, "{}");
    chmodSync(auth, 0o000);
    try {
      expect(() => assertNoReservedProviderEntries(providerDir, ["openrouter"])).toThrow(
        /could not read it/,
      );
    } finally {
      chmodSync(auth, 0o600);
    }
  });
});

// ── T4: a new row is plumbed through the real consumers ──────────────────────

describe("T4 — a nested operator row reaches init and run resolution", () => {
  const operatorYaml = `version: 1
providers:
  - id: acme-local
    aliases: [acme]
    runtime: acme
    auth: bob/none
    endpoint: http://127.0.0.1:11434/v1
    api: openai-completions
    override: {}
defaults:
  onboard: acme
`;

  it("init writes the row's endpoint under the row's runtime, and run resolves the alias", () => {
    const path = writeRegistry(operatorYaml);
    const registry = loadProviderRegistry({ path });
    const res = initAgent(baseOpts({ provider: "acme", registry }));
    const models = JSON.parse(
      readFileSync(join(res.agentDir, ".pi-agent", "models.json"), "utf8"),
    ) as { providers: Record<string, { baseUrl?: string }> };
    expect(models.providers.acme?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(readFileSync(join(res.agentDir, "bob.yaml"), "utf8")).toContain("name: acme");
    expect(mapBobProviderToPi("acme", registry)).toBe("acme");
    expect(resolveRuntimeProviderName("acme", registry)).toBe("acme");
  });

  it("endpoint eligibility is derived from the row's override policy", () => {
    const path = writeRegistry(operatorYaml);
    const registry = loadProviderRegistry({ path });
    // The new row authorizes its override…
    expect(providerBaseUrlRefusal("acme", "http://127.0.0.1:9999/v1", registry)).toBeUndefined();
    // …ollama keeps its cloud-host exclusion…
    expect(providerBaseUrlRefusal("ollama", "https://ollama.com/v1", registry)).toMatch(
      /only allowed/,
    );
    // …and an undeclared name has no policy at all.
    expect(providerBaseUrlRefusal("acme", "http://x.test/v1", new ProviderRegistry())).toMatch(
      /only allowed/,
    );
  });

  it("an operator row cannot claim bob/env for a runtime whose custody is unimplemented", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme-local\n    aliases: [acme]\n    runtime: acme\n    auth: bob/env(ACME_KEY)\n    endpoint: https://acme.example/v1\n    api: openai-completions\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/no implemented custody/);
  });
});

// ── T5: default references are validated ─────────────────────────────────────

describe("T5 — onboarding/hire defaults resolve to a declared row", () => {
  it("defaults naming a declared row and alias both load", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: [acme-alias]\n    runtime: acme\n    auth: bob/none\ndefaults:\n  onboard: acme-alias\n  hire: ollama-cloud\n",
    );
    const registry = loadProviderRegistry({ path });
    expect(registry.find("acme-alias")?.id).toBe("acme");
  });

  it("defaults naming an undeclared row refuse", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\ndefaults:\n  hire: nope\n",
    );
    expect(() => loadProviderRegistry({ path })).toThrow(/defaults\.hire/);
  });
});

// A row shape guard: the builtin table itself carries the closed union.
describe("the builtin table carries explicit auth modes", () => {
  it("every builtin row declares one of the five modes", () => {
    for (const row of PROVIDER_RECORDS) {
      expect(["env", "none", "vm", "disk", "login"]).toContain(row.auth.kind);
    }
  });
});

// ── T5b: the selected defaults are carried by the registry ───────────────────

describe("the selected defaults are carried by the registry", () => {
  it("defaultProviderName returns the operator's selection over the builtins", () => {
    const path = writeRegistry(
      "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\ndefaults:\n  onboard: acme\n  hire: acme\n",
    );
    const reg = loadProviderRegistry({ path });
    expect(defaultProviderName("onboard", reg)).toBe("acme");
    expect(defaultProviderName("hire", reg)).toBe("acme");
    const builtin = new ProviderRegistry();
    expect(defaultProviderName("onboard", builtin)).toBe("ollama-cloud");
    expect(defaultProviderName("hire", builtin)).toBe("exe-dev-gateway");
  });
});
