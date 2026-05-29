import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { BLESSED_CATALOG, lookupCapability } from "../src/capability-catalog.js";
import { resolveCapabilities } from "../src/capability-loader.js";

describe("blessed catalog", () => {
  it("blesses the fixture capability as implemented", () => {
    const entry = lookupCapability("fixture");
    expect(entry).toBeDefined();
    expect(entry?.notYetImplemented).toBeFalsy();
    expect(entry?.manifest.name).toBe("fixture");
  });

  it("blesses the discord capability as implemented (PR3)", () => {
    const entry = lookupCapability("discord");
    expect(entry).toBeDefined();
    expect(entry?.notYetImplemented).toBeFalsy();
    expect(entry?.manifest.name).toBe("discord");
    expect(entry?.manifest.provides?.tools).toEqual([
      "discord_reply",
      "discord_react",
      "discord_fetch",
    ]);
    expect(entry?.manifest.provides?.serves).toBe(true);
  });

  it("resolves discord to an absolute on-disk extension path", () => {
    const path = lookupCapability("discord")?.manifest.piPackage ?? "";
    expect(path.startsWith("/")).toBe(true);
    expect(path.endsWith("cap-discord/src/index.ts")).toBe(true);
  });

  it("lists the still-planned capabilities as not-yet-implemented", () => {
    for (const name of ["flair", "mail", "heartbeat"]) {
      const entry = lookupCapability(name);
      expect(entry, name).toBeDefined();
      expect(entry?.notYetImplemented, name).toBe(true);
    }
  });

  it("resolves the fixture to an absolute on-disk extension path", () => {
    const path = BLESSED_CATALOG.fixture.manifest.piPackage;
    expect(path.startsWith("/")).toBe(true);
    expect(path.endsWith("examples/cap-fixture/index.ts")).toBe(true);
  });

  it("rejects a still-unbuilt capability through the loader", () => {
    const yaml = ["capabilities:", "  - flair", ""].join("\n");
    expect(() => resolveCapabilities({ yamlText: yaml })).toThrow(/not yet implemented/);
  });
});

// The load-bearing proof: the loader resolves the fixture, and a REAL pi
// AgentSession built with that extension source exposes the fixture's tool.
// This exercises the whole mechanism end-to-end (catalog → loader → pi
// resource loader → createAgentSession → tool surfaces) without an LLM call.
describe("capability mechanism — end to end with a real pi session", () => {
  it("composes the fixture capability's tool into the session", async () => {
    const yaml = ["capabilities:", "  - fixture", "", "fixture:", "  greeting: hi", ""].join("\n");
    const { extensionSources } = resolveCapabilities({ yamlText: yaml });
    expect(extensionSources).toHaveLength(1);

    const cwd = mkdtempSync(join(tmpdir(), "bob-cap-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "bob-cap-pi-"));
    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        additionalExtensionPaths: extensionSources,
      });
      await loader.reload();

      // The extension loaded with no errors.
      const exts = loader.getExtensions();
      expect(exts.errors ?? []).toEqual([]);

      const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
      });
      try {
        const toolNames = session.getAllTools().map((t) => t.name);
        expect(toolNames).toContain("bob_fixture_noop");
      } finally {
        session.dispose();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
