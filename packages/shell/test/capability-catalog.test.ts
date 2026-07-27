import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { BLESSED_CATALOG, lookupCapability } from "../src/capability-catalog.js";
import { capabilityConfigEnv, resolveCapabilities } from "../src/capability-loader.js";

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

  it("blesses discord as its published package specifier, not a path", () => {
    // The defect this replaces: discord was blessed as a path relative to this
    // package, which resolves only inside a checkout. A package specifier
    // resolves in a checkout AND in a published install.
    const spec = lookupCapability("discord")?.manifest.piPackage ?? "";
    expect(spec).toBe("@tpsdev-ai/bob-cap-discord");
  });

  it("blesses the flair capability as implemented", () => {
    const entry = lookupCapability("flair");
    expect(entry).toBeDefined();
    expect(entry?.notYetImplemented).toBeFalsy();
    expect(entry?.manifest.name).toBe("flair");
    expect(entry?.manifest.provides?.tools).toEqual(["flair_search", "flair_write", "flair_get"]);
    expect(entry?.manifest.provides?.serves).toBe(false);
    expect(entry?.manifest.piPackage).toBe("@tpsdev-ai/bob-cap-flair");
  });

  it("blesses the observatory capability as implemented (team-view producer)", () => {
    const entry = lookupCapability("observatory");
    expect(entry).toBeDefined();
    expect(entry?.notYetImplemented).toBeFalsy();
    expect(entry?.manifest.name).toBe("observatory");
    expect(entry?.manifest.provides?.tools).toEqual(["observatory_report"]);
    expect(entry?.manifest.provides?.serves).toBe(false);
    expect(entry?.manifest.piPackage).toBe("@tpsdev-ai/bob-cap-observatory");
  });

  it("lists the still-planned capabilities as not-yet-implemented", () => {
    for (const name of ["mail", "heartbeat"]) {
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
    const yaml = ["capabilities:", "  - mail", ""].join("\n");
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

// The same proof for a capability that lives in a SEPARATE package, which is
// the case the fixture cannot cover — the fixture ships inside bob-shell, so it
// resolves no matter how the catalog is wrong. flair is chosen because it opens
// nothing (no gateway, no network at load); discord/observatory take the
// identical path through the catalog.
describe("capability mechanism — a real capability PACKAGE, end to end", () => {
  it("resolves flair to its installed package and composes its tools", async () => {
    const yaml = [
      "capabilities:",
      "  - flair",
      "",
      "flair:",
      "  url: http://127.0.0.1:9",
      "  agentId: testbot",
      "  keyFile: /dev/null",
      "",
    ].join("\n");
    const resolution = resolveCapabilities({ yamlText: yaml });
    expect(resolution.extensionSources).toHaveLength(1);

    const source = resolution.extensionSources[0] ?? "";
    // Resolved, not blessed-as-written: an absolute path into the installed
    // package's SHIPPED entry point.
    expect(source.startsWith("/")).toBe(true);
    expect(source.endsWith("/dist/index.js")).toBe(true);
    expect(existsSync(source)).toBe(true);

    const cwd = mkdtempSync(join(tmpdir(), "bob-cap-pkg-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "bob-cap-pkg-pi-"));
    const prevEnv = process.env.BOB_CAP_FLAIR;
    for (const [k, v] of Object.entries(capabilityConfigEnv(resolution))) process.env[k] = v;
    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        additionalExtensionPaths: resolution.extensionSources,
      });
      await loader.reload();
      expect(loader.getExtensions().errors ?? []).toEqual([]);

      const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
      });
      try {
        const toolNames = session.getAllTools().map((t) => t.name);
        expect(toolNames).toContain("flair_search");
        expect(toolNames).toContain("flair_write");
        expect(toolNames).toContain("flair_get");
      } finally {
        session.dispose();
      }
    } finally {
      if (prevEnv === undefined) delete process.env.BOB_CAP_FLAIR;
      else process.env.BOB_CAP_FLAIR = prevEnv;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 30000);
});
