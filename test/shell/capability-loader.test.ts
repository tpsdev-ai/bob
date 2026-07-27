import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
  loadConfigFromEnv as loadObservatoryConfig,
  CONFIG_ENV_VAR as OBSERVATORY_CONFIG_ENV_VAR,
} from "../../src/capabilities/observatory/config.js";
import type { CatalogEntry } from "../../src/shell/capability.js";
import { lookupCapability } from "../../src/shell/capability-catalog.js";
import {
  capabilityConfigEnv,
  capabilityEnvVar,
  resolveCapabilities,
} from "../../src/shell/capability-loader.js";

// REAL blessed specifiers for the two resolvable entries. They have to resolve
// AND exist: resolveCapabilities existence-checks every source, because handing
// pi one that isn't there is silently dropped rather than raised. Using real
// specifiers (rather than a stubbed resolver) keeps this test honest about the
// one resolution path there is.
const ALPHA_SPEC = "@tpsdev-ai/bob/capabilities/fixture";
const BETA_SPEC = "@tpsdev-ai/bob/capabilities/flair";

// A small in-test catalog so resolution can be exercised without depending on
// the real blessed catalog's contents (which evolve as real capabilities land).
function testCatalog(): (name: string) => CatalogEntry | undefined {
  const entries: Record<string, CatalogEntry> = {
    alpha: {
      manifest: {
        name: "alpha",
        piPackage: ALPHA_SPEC,
        configSchema: Type.Object({ greeting: Type.Optional(Type.String()) }),
        provides: { tools: ["alpha_tool"] },
      },
    },
    beta: {
      manifest: {
        name: "beta",
        piPackage: BETA_SPEC,
        configSchema: Type.Object({ count: Type.Number() }),
      },
    },
    soon: {
      manifest: {
        name: "soon",
        piPackage: "@tpsdev-ai/bob/capabilities/soon",
        configSchema: Type.Object({}),
      },
      notYetImplemented: true,
    },
  };
  return (name) => entries[name];
}

describe("resolveCapabilities", () => {
  it("resolves declared capabilities to pi extension sources in order", () => {
    const yaml = ["capabilities:", "  - alpha", "  - beta", "", "beta:", "  count: 5", ""].join(
      "\n",
    );
    const res = resolveCapabilities({ yamlText: yaml, lookup: testCatalog() });
    expect(res.capabilities.map((c) => c.name)).toEqual(["alpha", "beta"]);
    // Resolved, not blessed-as-written: absolute paths to files that exist.
    expect(res.extensionSources).toHaveLength(2);
    expect(res.extensionSources[0].endsWith("/dist/capabilities/fixture/index.js")).toBe(true);
    expect(res.extensionSources[1].endsWith("/dist/capabilities/flair/index.js")).toBe(true);
  });

  it("returns empty when no capabilities are declared", () => {
    const res = resolveCapabilities({
      yamlText: "provider:\n  name: anthropic\n",
      lookup: testCatalog(),
    });
    expect(res.capabilities).toEqual([]);
    expect(res.extensionSources).toEqual([]);
  });

  it("validates a capability's config block against its schema", () => {
    const yaml = ["capabilities:", "  - alpha", "", "alpha:", "  greeting: hello", ""].join("\n");
    const res = resolveCapabilities({ yamlText: yaml, lookup: testCatalog() });
    expect(res.capabilities[0].config).toEqual({ greeting: "hello" });
  });

  it("defaults config to {} when no block is present", () => {
    const yaml = ["capabilities:", "  - alpha", ""].join("\n");
    const res = resolveCapabilities({ yamlText: yaml, lookup: testCatalog() });
    expect(res.capabilities[0].config).toEqual({});
  });

  it("throws on an unknown (un-blessed) capability", () => {
    const yaml = ["capabilities:", "  - ghost", ""].join("\n");
    expect(() => resolveCapabilities({ yamlText: yaml, lookup: testCatalog() })).toThrow(
      /unknown capability "ghost"/,
    );
  });

  it("throws on a blessed-but-not-yet-implemented capability", () => {
    const yaml = ["capabilities:", "  - soon", ""].join("\n");
    expect(() => resolveCapabilities({ yamlText: yaml, lookup: testCatalog() })).toThrow(
      /not yet implemented/,
    );
  });

  it("throws when a config block fails its schema", () => {
    // beta requires a numeric `count`; supply a string-y/missing value.
    const yaml = ["capabilities:", "  - beta", "", "beta:", "  wrong: x", ""].join("\n");
    expect(() => resolveCapabilities({ yamlText: yaml, lookup: testCatalog() })).toThrow(
      /capability "beta" config is invalid/,
    );
  });

  it("throws on a duplicate capability declaration", () => {
    const yaml = ["capabilities:", "  - alpha", "  - alpha", ""].join("\n");
    expect(() => resolveCapabilities({ yamlText: yaml, lookup: testCatalog() })).toThrow(
      /declared more than once/,
    );
  });
});

// Issue #77: the observatory capability was blessed, its package loaded, and
// its config schema was unsatisfiable from bob.yaml — the ONLY value `agents`
// could take from the reader was an array of strings. This walks the real
// catalog entry, the real schema, and the real bob.yaml path, so the "can it be
// configured at all" question has a test rather than a memory.
describe("resolveCapabilities — a capability whose schema needs a list of objects", () => {
  const yaml = [
    "capabilities:",
    "  - observatory",
    "",
    "observatory:",
    "  observatoryUrl: http://127.0.0.1:9926",
    "  officeId: rockit",
    "  officeKeyFile: ~/.flair/keys/office.key",
    "  staleThresholdSeconds: 600",
    "  agents:",
    "    - agentId: flint",
    "      name: Flint",
    "      role: Strategy",
    "      heartbeatFile: /signals/flint.hb",
    "    - agentId: anvil",
    "      type: agent",
    "",
  ].join("\n");

  it("resolves an observatory block written the documented way", () => {
    const res = resolveCapabilities({ yamlText: yaml, lookup: lookupCapability });
    expect(res.capabilities).toHaveLength(1);
    expect(res.capabilities[0].config).toEqual({
      observatoryUrl: "http://127.0.0.1:9926",
      officeId: "rockit",
      officeKeyFile: "~/.flair/keys/office.key",
      staleThresholdSeconds: 600,
      agents: [
        {
          agentId: "flint",
          name: "Flint",
          role: "Strategy",
          heartbeatFile: "/signals/flint.hb",
        },
        { agentId: "anvil", type: "agent" },
      ],
    });
  });

  it("hands the extension a config its own loader re-validates", () => {
    const res = resolveCapabilities({ yamlText: yaml, lookup: lookupCapability });
    const env = capabilityConfigEnv(res);
    const config = loadObservatoryConfig({ [OBSERVATORY_CONFIG_ENV_VAR]: env.BOB_CAP_OBSERVATORY });
    expect(config.agents.map((a) => a.agentId)).toEqual(["flint", "anvil"]);
  });
});

// The README's "Configuring a capability" example is the only written answer to
// "how do I turn this on". #77 shipped partly because there wasn't one — nobody
// had cause to write the block that turned out to be unwritable. Resolve the
// documented YAML through the real catalog so the docs can't drift from the
// reader again.
describe("the README's capability example", () => {
  it("resolves against the real blessed catalog", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf8");
    const block = readme.match(/```yaml\n([\s\S]*?)```/);
    expect(block).not.toBeNull();
    const yaml = (block as RegExpMatchArray)[1];
    expect(yaml).toContain("capabilities:");
    expect(yaml).toContain("agents:");

    const res = resolveCapabilities({ yamlText: yaml, lookup: lookupCapability });
    expect(res.capabilities.map((c) => c.name)).toEqual(["flair", "observatory"]);
    const observatory = res.capabilities[1].config as { agents: Array<{ agentId: string }> };
    expect(observatory.agents.map((a) => a.agentId)).toEqual(["agent-one", "agent-two"]);
  });
});

describe("capabilityEnvVar / capabilityConfigEnv", () => {
  it("derives the BOB_CAP_<NAME> env var name", () => {
    expect(capabilityEnvVar("discord")).toBe("BOB_CAP_DISCORD");
    expect(capabilityEnvVar("my-cap")).toBe("BOB_CAP_MY_CAP");
  });

  it("maps each resolved capability to its env var with JSON config", () => {
    const yaml = ["capabilities:", "  - alpha", "", "alpha:", "  greeting: hi", ""].join("\n");
    const res = resolveCapabilities({ yamlText: yaml, lookup: testCatalog() });
    const env = capabilityConfigEnv(res);
    expect(env).toEqual({ BOB_CAP_ALPHA: JSON.stringify({ greeting: "hi" }) });
  });

  it("returns {} when no capabilities are declared", () => {
    const res = resolveCapabilities({ yamlText: "provider:\n  name: x\n", lookup: testCatalog() });
    expect(capabilityConfigEnv(res)).toEqual({});
  });
});
