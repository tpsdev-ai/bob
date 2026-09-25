// The ONE bob session factory (session.ts). Three things are asserted here,
// because they are the shape this round exists to create:
//
//   1. ISOLATION — with a user-level extension, a project `.pi` extension, a
//      configured package and a project trust decision all present on disk,
//      none of them load, on creation or on reload, and nothing is installed;
//   2. THE AUDIT — every name in the effective policy must be active, and no
//      name may come from two sources; a failed audit disposes the session and
//      ends the process;
//   3. THE PIN — whatever cwd/agentDir a resumed, forked, cloned or imported
//      session names, the factory builds the agent's own session.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { type RunSession, resolveRunConfig } from "../../src/shell/run.js";
import {
  auditOrExit,
  auditToolSources,
  createBobRuntimeFactory,
  installReloadAudit,
  isolatedLoaderOptions,
  isolatedSettings,
  promptSession,
} from "../../src/shell/session.js";

// A module-shaped file pi's auto-discovery would pick up if it were allowed to.
const AMBIENT_EXTENSION = "export default function ambient(pi) { /* would register a tool */ }\n";

describe("the session factory is isolated from everything ambient", () => {
  let root: string;
  let agentsRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-session-iso-"));
    agentsRoot = join(root, "agents");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // A real agent (initAgent writes bob.yaml + .pi-agent/{models,auth}.json) with
  // ONE declared capability, plus every ambient resource pi would otherwise
  // consider: a user-level extension, a project .pi extension, a configured
  // package in both settings files, and a project trust decision.
  function scaffold(): { agentDir: string; cwd: string; piAgentDir: string } {
    const res = initAgent({
      name: "testbot",
      role: "ea",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentsRoot,
      flairKeysDir: join(root, ".flair", "keys"),
      skipFlair: true,
    });
    const agentDir = res.agentDir;
    const cwd = join(agentDir, "work");
    const piAgentDir = join(agentDir, ".pi-agent");

    // User-level extension (auto-discovered from the pi agent dir).
    mkdirSync(join(piAgentDir, "extensions"), { recursive: true });
    writeFileSync(join(piAgentDir, "extensions", "ambient-user.js"), AMBIENT_EXTENSION);
    // Project-level extension (auto-discovered from cwd/.pi when trusted).
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions", "ambient-project.js"), AMBIENT_EXTENSION);
    // A configured package, in the user and the project settings files.
    writeFileSync(
      join(piAgentDir, "settings.json"),
      JSON.stringify({ packages: ["@ambient/user-package"] }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: ["@ambient/project-package"] }),
    );
    // A trust decision that would let the project resources load.
    writeFileSync(join(piAgentDir, "trust.json"), JSON.stringify({ [cwd]: true }));

    return { agentDir, cwd, piAgentDir };
  }

  it("loads ONLY the declared capability — never user/project extensions or packages", async () => {
    const { cwd, piAgentDir } = scaffold();
    const { config, policy } = resolveRunConfig({ name: "testbot", agentsRoot });
    // The declared capability is the fixture, so the factory has one legitimate
    // extension to load alongside everything it must ignore.
    const fixtureConfig = {
      ...config,
      extensionSources: [...config.extensionSources],
    };
    const factory = createBobRuntimeFactory({ config: fixtureConfig, policy });
    const result = await factory({
      cwd,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(cwd) as never,
    });

    const loaded = result.services.resourceLoader.getExtensions().extensions.map((e) => e.path);
    // Nothing ambient, on either scope.
    expect(loaded.filter((p) => p.includes("ambient"))).toEqual([]);
    // And nothing from the configured packages was resolved or installed.
    expect(loaded.filter((p) => p.includes("@ambient"))).toEqual([]);
    expect(readdirSync(cwd).includes(".pi") ? readdirSync(join(cwd, ".pi")) : []).not.toContain(
      "npm",
    );
    expect(readdirSync(piAgentDir)).not.toContain("npm");
    expect(result.services.diagnostics.filter((d) => d.type === "error")).toEqual([]);
  });

  it("stays isolated across a reload (the same isolated sources are re-read)", async () => {
    const { cwd, piAgentDir } = scaffold();
    const { config, policy } = resolveRunConfig({ name: "testbot", agentsRoot });
    const factory = createBobRuntimeFactory({ config, policy });
    const result = await factory({
      cwd,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(cwd) as never,
    });

    await result.services.resourceLoader.reload();
    const loaded = result.services.resourceLoader.getExtensions().extensions.map((e) => e.path);
    expect(loaded.filter((p) => p.includes("ambient"))).toEqual([]);
  });

  it("CONTROL: without the isolation, pi would load the ambient resources", async () => {
    // Proves the fixture above is real: the same ambient files, loaded by a
    // plain pi loader with file-backed settings and the project trusted, DO
    // come up. So the assertion in the first test is about bob's isolation, not
    // about files pi would ignore anyway.
    const { cwd, piAgentDir } = scaffold();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: piAgentDir,
      settingsManager: SettingsManager.create(cwd, piAgentDir, { projectTrusted: true }),
      systemPrompt: "",
      appendSystemPrompt: [],
    });
    await loader.reload();
    const loaded = loader.getExtensions().extensions.map((e) => e.path);
    expect(loaded.some((p) => p.includes("ambient"))).toBe(true);
  });

  it("pins the agent's identity and directory, whatever cwd/agentDir are requested", async () => {
    const { cwd, piAgentDir } = scaffold();
    const { config, policy } = resolveRunConfig({ name: "testbot", agentsRoot });
    const factory = createBobRuntimeFactory({ config, policy });

    // A resumed/imported session asks for a DIFFERENT cwd and agent dir.
    const elsewhere = mkdtempSync(join(tmpdir(), "bob-elsewhere-"));
    try {
      const result = await factory({
        cwd: elsewhere,
        agentDir: elsewhere,
        sessionManager: SessionManager.inMemory(elsewhere) as never,
      });
      expect(result.services.cwd).toBe(cwd);
      expect(result.services.agentDir).toBe(piAgentDir);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("the audit", () => {
  it("names a tool that two sources provide", () => {
    // pi's own built-in and a declared capability both register "read".
    const error = (() => {
      try {
        auditToolSources(
          { tools: ["read"], excludeTools: [], capabilityBySource: { "/cap/x": "x" } },
          [{ path: "/cap/x", tools: new Map([["read", {}]]) }],
        );
        return undefined;
      } catch (err) {
        return err as Error;
      }
    })();
    expect(error?.message).toContain("read");
    expect(error?.message).toContain("built-in");
    expect(error?.message).toContain("x");
  });

  it("passes when each name has exactly one source", () => {
    expect(() =>
      auditToolSources({ tools: ["read", "bob_fixture_noop"], excludeTools: [] }, [
        { path: "/cap/fixture", tools: new Map([["bob_fixture_noop", {}]]) },
      ]),
    ).not.toThrow();
  });

  it("ignores a name the denylist removes (absent on purpose, not duplicated)", () => {
    expect(() =>
      auditToolSources({ tools: ["read"], excludeTools: ["read"], capabilityBySource: {} }, [
        { path: "/cap/x", tools: new Map([["read", {}]]) },
      ]),
    ).not.toThrow();
  });

  it("disposes the session and ends the process when the audit fails", () => {
    let disposed = 0;
    const exits: number[] = [];
    const logs: string[] = [];
    const session = {
      dispose() {
        disposed += 1;
      },
    };

    expect(() =>
      auditOrExit(
        () => {
          throw new Error("required tool vanished: read");
        },
        session,
        { exit: (code) => exits.push(code), log: (m) => logs.push(m) },
      ),
    ).toThrow(/required tool vanished/);

    expect(disposed, "the session is disposed").toBe(1);
    expect(exits, "the process is ended with a failure code").toEqual([1]);
    expect(logs.join("\n")).toContain("required tool vanished: read");
  });

  it("re-runs the audit after EVERY reload — a capability that drops a required tool ends the session", async () => {
    // The reload hook is what covers "after the mode binds extensions": a
    // capability that deactivates a required tool after load must not leave a
    // running session whose policy no longer holds (pi's TUI would show a
    // reload error and carry on).
    let active = ["read", "write"];
    const disposed: number[] = [];
    const exits: number[] = [];
    const session = {
      getActiveToolNames: () => active,
      dispose: () => disposed.push(1),
    };
    const loader = { reload: async () => {} };
    const policy = { tools: ["read", "write"], excludeTools: [] };

    installReloadAudit(loader, () =>
      auditOrExit(
        () => {
          // Every reload re-checks the SESSION's active tools.
          const missing = policy.tools.filter((t) => !active.includes(t));
          if (missing.length > 0)
            throw new Error(`allowlisted tool not active: ${missing.join(", ")}`);
        },
        session,
        { exit: (code) => exits.push(code), log: () => {} },
      ),
    );

    await loader.reload(); // still fine
    expect(disposed).toEqual([]);

    active = ["read"]; // a capability deactivated `write` after load
    await expect(loader.reload()).rejects.toThrow(/write/);
    expect(disposed, "the session is disposed").toEqual([1]);
    expect(exits, "the process is ended").toEqual([1]);
  });
});

describe("the prompt entry point", () => {
  it("sends the text as the prompt — no command, template or skill expansion", async () => {
    const calls: Array<{ text: string; options?: { expandPromptTemplates?: boolean } }> = [];
    const session = {
      async prompt(text: string, options?: { expandPromptTemplates?: boolean }) {
        calls.push({ text, options });
      },
    } as unknown as RunSession;

    for (const body of ["/help", "--version", "@file.md", "plain"]) {
      await promptSession(session, body);
    }
    expect(calls.map((c) => c.text)).toEqual(["/help", "--version", "@file.md", "plain"]);
    for (const call of calls) {
      expect(call.options?.expandPromptTemplates, `body: ${call.text}`).toBe(false);
    }
  });
});

describe("isolated settings", () => {
  it("are in-memory with project trust off", () => {
    const settings = isolatedSettings();
    expect(settings.isProjectTrusted()).toBe(false);
    expect(settings.getGlobalSettings().packages ?? []).toEqual([]);
  });

  it("declare no ambient discovery and only the declared extension sources", () => {
    const opts = isolatedLoaderOptions({
      piAgentDir: "/pi",
      appendSystemPrompt: "soul",
      extensionSources: ["/cap/fixture"],
    });
    expect(opts.noExtensions).toBe(true);
    expect(opts.noSkills).toBe(true);
    expect(opts.noPromptTemplates).toBe(true);
    expect(opts.noThemes).toBe(true);
    expect(opts.noContextFiles).toBe(true);
    expect(opts.additionalExtensionPaths).toEqual(["/cap/fixture"]);
    expect(opts.appendSystemPrompt).toEqual(["soul"]);
  });
});
