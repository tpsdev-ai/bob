import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import type { CatalogEntry } from "../src/capability.js";
import { resolveCapabilities } from "../src/capability-loader.js";

// A small in-test catalog so resolution can be exercised without depending on
// the real blessed catalog's contents (which evolve as real capabilities land).
function testCatalog(): (name: string) => CatalogEntry | undefined {
  const entries: Record<string, CatalogEntry> = {
    alpha: {
      manifest: {
        name: "alpha",
        piPackage: "/abs/path/alpha.ts",
        configSchema: Type.Object({ greeting: Type.Optional(Type.String()) }),
        provides: { tools: ["alpha_tool"] },
      },
    },
    beta: {
      manifest: {
        name: "beta",
        piPackage: "npm:@scope/beta@1.0.0",
        configSchema: Type.Object({ count: Type.Number() }),
      },
    },
    soon: {
      manifest: {
        name: "soon",
        piPackage: "npm:@scope/soon",
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
    expect(res.extensionSources).toEqual(["/abs/path/alpha.ts", "npm:@scope/beta@1.0.0"]);
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
