// The ONE bob session factory (session.ts). Three things are asserted here,
// because they are the shape this round exists to create:
//
//   1. ISOLATION — with a user-level extension, a project `.pi` extension, a
//      configured package and a project trust decision all present on disk,
//      none of them load, on creation or on reload, and nothing is installed;
//   2. THE AUDIT — every name in the effective policy must be active, and no
//      name may come from two sources; a failed audit disposes the session and
//      ends the process — and so does a reload or a bind that THROWS;
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
  isolatedLoaderOptions,
  isolatedSettings,
  promptSession,
} from "../../src/shell/session.js";

// A module-shaped file pi's auto-discovery would pick up if it were allowed to.
const AMBIENT_EXTENSION = "export default function ambient(pi) { /* would register a tool */ }\n";

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

describe("the session factory is isolated from everything ambient", () => {
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

  // The two tests below run against a REAL pi session, built by the ONE
  // factory. The defect they pin is an ORDERING defect: pi rebuilds the active
  // tool list after the resource loader's reload returns, and it never reloads
  // when the mode binds extensions — so an audit hooked into the LOADER read the
  // state pi was about to replace, and never ran at all for the mode's bind.
  // A fake loader cannot see either, which is why round 4 replaced that test.
  const PROBE_TOOL =
    'pi.registerTool({ name: "bob_probe_tool", label: "Bob Probe", description: "A probe tool registered by the test capability.", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });';
  const probeExtension = (register: boolean) =>
    `export default function (pi) {${register ? PROBE_TOOL : ""}}\n`;
  const probeExtensionWithSessionStart = () =>
    `export default function (pi) {${PROBE_TOOL} pi.on("session_start", () => { pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "bob_probe_tool")); }); }\n`;

  // Build a real session through the factory, with ONE temp capability extension
  // the test writes, and a policy that requires the tool it registers.
  async function realProbeSession(extensionText: string) {
    const { cwd, piAgentDir } = scaffold();
    const extDir = mkdtempSync(join(tmpdir(), "bob-ext-"));
    const extPath = join(extDir, "probe.js");
    writeFileSync(extPath, extensionText);

    const { config, policy } = resolveRunConfig({ name: "testbot", agentsRoot });
    const logs: string[] = [];
    const exits: number[] = [];
    const factory = createBobRuntimeFactory({
      config: {
        ...config,
        extensionSources: [extPath],
        capabilityBySource: { [extPath]: "probe" },
      },
      policy: { ...policy, tools: ["read", "bob_probe_tool"] },
      deps: { log: (m) => logs.push(m), exit: (code) => exits.push(code) },
    });
    const result = await factory({
      cwd,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(cwd) as never,
    });
    const session = result.session as unknown as {
      getActiveToolNames(): string[];
      reload(options?: unknown): Promise<void>;
      bindExtensions(bindings: unknown): Promise<void>;
      dispose(): void;
    };
    // Count the factory's dispose, after the factory has built the session.
    let disposals = 0;
    const dispose = session.dispose.bind(session);
    session.dispose = () => {
      disposals += 1;
      dispose();
    };
    return {
      session,
      extPath,
      loader: result.services.resourceLoader,
      logs,
      exits,
      disposals: () => disposals,
      cleanup: () => rmSync(extDir, { recursive: true, force: true }),
    };
  }

  it("re-audits AFTER pi rebuilds the tool list — a capability that stops providing a required tool on reload ends the session", async () => {
    const probe = await realProbeSession(probeExtension(true));
    try {
      // Creation: the capability registered the tool, so the policy holds.
      expect(probe.session.getActiveToolNames()).toContain("bob_probe_tool");

      // The capability stops registering the tool, and the reload re-reads it:
      // pi rebuilds the active list AFTER the loader's reload returns, so only
      // an audit at session.reload()'s end can see the tool go.
      writeFileSync(probe.extPath, probeExtension(false));
      await expect(probe.session.reload()).rejects.toThrow(/bob_probe_tool/);

      expect(probe.disposals(), "the session is disposed").toBe(1);
      expect(probe.exits, "the process is ended").toEqual([1]);
      expect(probe.logs.join("\n")).toContain("bob_probe_tool");
      expect(
        probe.session.getActiveToolNames(),
        "the audit saw the FINAL tool state, not the one pi was about to replace",
      ).not.toContain("bob_probe_tool");
    } finally {
      probe.cleanup();
    }
  });

  it("re-audits AFTER the mode binds extensions — a capability that deactivates a required tool on session_start ends the session", async () => {
    const probe = await realProbeSession(probeExtensionWithSessionStart());
    try {
      // Creation: the extension loaded and its tool is active; session_start has
      // not fired yet, so the policy holds.
      expect(probe.session.getActiveToolNames()).toContain("bob_probe_tool");

      // The mode's bind emits session_start, where the capability switches the
      // tool off. pi does not reload here, so only an audit at the end of
      // bindExtensions sees it.
      await expect(probe.session.bindExtensions({})).rejects.toThrow(/bob_probe_tool/);

      expect(probe.disposals(), "the session is disposed").toBe(1);
      expect(probe.exits, "the process is ended").toEqual([1]);
      expect(probe.logs.join("\n")).toContain("bob_probe_tool");
      expect(probe.session.getActiveToolNames()).not.toContain("bob_probe_tool");
    } finally {
      probe.cleanup();
    }
  });

  // Round 5: a reload or a bind that THROWS is a FAILED AUDIT. pi's interactive
  // mode catches the throw and stays open, so a wrapper that audited only after
  // the work SUCCEEDED left the mode serving on a tool state nobody audited.
  // Both tests below force the failure at a step pi's own method body awaits,
  // so the SESSION method rejects for real (pi swallows errors thrown by
  // extension handlers, so a throwing handler cannot produce this).
  it("round 5: a reload that THROWS ends the session — a failed reload is a failed audit", async () => {
    const probe = await realProbeSession(probeExtension(true));
    try {
      // The resource loader is the same object the session reloads, so pi's own
      // reload() body runs and rejects.
      const loader = probe.loader as unknown as { reload(...args: unknown[]): Promise<void> };
      const originalLoaderReload = loader.reload.bind(loader);
      loader.reload = () => Promise.reject(new Error("the resource loader could not be reloaded"));

      await expect(probe.session.reload()).rejects.toThrow(
        /the resource loader could not be reloaded/,
      );

      expect(probe.disposals(), "the session is disposed").toBe(1);
      expect(probe.exits, "the process is ended").toEqual([1]);
      const logs = probe.logs.join("\n");
      expect(logs, "the ORIGINAL error is named").toContain(
        "the resource loader could not be reloaded",
      );
      expect(logs).toContain("the session could not be reloaded or bound");

      loader.reload = originalLoaderReload;
    } finally {
      probe.cleanup();
    }
  });

  it("round 5: a bind that THROWS ends the session — a failed bind is a failed audit", async () => {
    const probe = await realProbeSession(probeExtension(true));
    try {
      // pi's bindExtensions() awaits this step at its end (it returns early
      // unless the capability discovers resources), so its real body rejects.
      const session = probe.session as unknown as {
        extendResourcesFromExtensions(reason: string): Promise<void>;
      };
      const originalExtend = session.extendResourcesFromExtensions.bind(session);
      session.extendResourcesFromExtensions = () =>
        Promise.reject(new Error("the extension resources could not be bound"));

      await expect(probe.session.bindExtensions({})).rejects.toThrow(
        /the extension resources could not be bound/,
      );

      expect(probe.disposals(), "the session is disposed").toBe(1);
      expect(probe.exits, "the process is ended").toEqual([1]);
      const logs = probe.logs.join("\n");
      expect(logs, "the ORIGINAL error is named").toContain(
        "the extension resources could not be bound",
      );
      expect(logs).toContain("the session could not be reloaded or bound");

      session.extendResourcesFromExtensions = originalExtend;
    } finally {
      probe.cleanup();
    }
  });

  // Round 6: `undefined` is a legal rejection value, so the wrapper's outcome
  // must be TAGGED, not signalled by an absent argument. With the old
  // error-or-undefined sentinel, `Promise.reject(undefined)` from a reload or a
  // bind took the SUCCESS branch: the policy was re-audited as though the work
  // had succeeded, nothing was disposed and the process was never ended.
  it("round 6: a reload that rejects with UNDEFINED ends the session — undefined is not the success signal", async () => {
    const probe = await realProbeSession(probeExtension(true));
    try {
      const loader = probe.loader as unknown as { reload(...args: unknown[]): Promise<void> };
      const originalLoaderReload = loader.reload.bind(loader);
      loader.reload = () => Promise.reject(undefined);

      let rejected: unknown = "sentinel: reload() never settled";
      await probe.session.reload().then(
        () => {
          throw new Error("reload() resolved: a rejected reload must not read as success");
        },
        (err) => {
          rejected = err;
        },
      );
      expect(rejected, "the original rejection value comes back (undefined)").toBeUndefined();

      expect(probe.disposals(), "the session is disposed").toBe(1);
      expect(probe.exits, "the process is ended").toEqual([1]);
      const logs = probe.logs.join("\n");
      expect(logs, "the failure is named even with no error value").toContain(
        "the session could not be reloaded or bound",
      );
      expect(logs, "the log says what actually arrived").toContain(
        "no error value (rejected with undefined)",
      );

      loader.reload = originalLoaderReload;
    } finally {
      probe.cleanup();
    }
  });

  // A rejection value that cannot be described (String() throws on a
  // null-prototype object) must not stand between a failed reload and the
  // dispose and exit: the failure path disposes FIRST and describes after.
  it("a reload that rejects with an UNDESCRIBABLE value still disposes and ends the session", async () => {
    const probe = await realProbeSession(probeExtension(true));
    try {
      const loader = probe.loader as unknown as { reload(...args: unknown[]): Promise<void> };
      const originalLoaderReload = loader.reload.bind(loader);
      const undescribable = Object.create(null);
      loader.reload = () => Promise.reject(undescribable);

      let rejected: unknown = "sentinel: reload() never settled";
      await probe.session.reload().then(
        () => {
          throw new Error("reload() resolved: a rejected reload must not read as success");
        },
        (err) => {
          rejected = err;
        },
      );
      expect(rejected, "the original rejection value comes back").toBe(undescribable);

      expect(probe.disposals(), "the session is disposed").toBe(1);
      expect(probe.exits, "the process is ended").toEqual([1]);
      expect(probe.logs.join("\n"), "the log still says a failure arrived").toContain(
        "a value that cannot be described",
      );

      loader.reload = originalLoaderReload;
    } finally {
      probe.cleanup();
    }
  });

  it("round 6: a bind that rejects with UNDEFINED ends the session — undefined is not the success signal", async () => {
    const probe = await realProbeSession(probeExtension(true));
    try {
      const session = probe.session as unknown as {
        extendResourcesFromExtensions(reason: string): Promise<void>;
      };
      const originalExtend = session.extendResourcesFromExtensions.bind(session);
      session.extendResourcesFromExtensions = () => Promise.reject(undefined);

      let rejected: unknown = "sentinel: bindExtensions() never settled";
      await probe.session.bindExtensions({}).then(
        () => {
          throw new Error("bindExtensions() resolved: a rejected bind must not read as success");
        },
        (err) => {
          rejected = err;
        },
      );
      expect(rejected, "the original rejection value comes back (undefined)").toBeUndefined();

      expect(probe.disposals(), "the session is disposed").toBe(1);
      expect(probe.exits, "the process is ended").toEqual([1]);
      const logs = probe.logs.join("\n");
      expect(logs, "the failure is named even with no error value").toContain(
        "the session could not be reloaded or bound",
      );
      expect(logs, "the log says what actually arrived").toContain(
        "no error value (rejected with undefined)",
      );

      session.extendResourcesFromExtensions = originalExtend;
    } finally {
      probe.cleanup();
    }
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
