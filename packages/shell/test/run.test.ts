import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSession, RunSessionConfig, RunSessionFactory } from "../src/run.js";
import { assertCapabilitiesLoaded, runAgent } from "../src/run.js";

// A fake AgentSession matching the RunSession seam. Emits canned assistant
// text via text_delta events (the same event shape every examples/sdk/*.ts
// subscribes to), so tests exercise the capture path without an LLM call.
function fakeSession(opts: {
  textDeltas?: string[];
  // Last-assistant-message fallback (used when no text_delta is emitted).
  finalMessages?: ReadonlyArray<unknown>;
  // Throw from prompt() to simulate a session error.
  throwOnPrompt?: boolean;
}): { session: RunSession; promptCalls: string[]; disposed: () => boolean } {
  const promptCalls: string[] = [];
  let disposed = false;
  // biome-ignore lint/suspicious/noExplicitAny: minimal event listener stub
  const listeners: Array<(event: any) => void> = [];
  const session: RunSession = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt(text) {
      promptCalls.push(text);
      if (opts.throwOnPrompt) throw new Error("simulated session failure");
      for (const delta of opts.textDeltas ?? []) {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
          });
        }
      }
    },
    get messages() {
      return opts.finalMessages;
    },
    dispose() {
      disposed = true;
    },
  };
  return { session, promptCalls, disposed: () => disposed };
}

// Build a factory that hands back a pre-made fake session and records the
// config it was called with (so tests can assert resolved provider/model).
function factoryReturning(session: RunSession): {
  factory: RunSessionFactory;
  lastConfig: () => RunSessionConfig | undefined;
} {
  let lastConfig: RunSessionConfig | undefined;
  const factory: RunSessionFactory = async (config) => {
    lastConfig = config;
    return session;
  };
  return { factory, lastConfig: () => lastConfig };
}

describe("runAgent", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-run-"));
    // A minimal onboarded agent: bob.yaml (provider block) + soul.md + dirs.
    const agentDir = join(agentsRoot, "testbot");
    mkdirSync(join(agentDir, "work"), { recursive: true });
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  name: Testbot",
        "  role: ea",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-sonnet-4-6",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
    );
    writeFileSync(join(agentDir, "soul.md"), "You are Testbot.");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  it("rejects invalid agent names (path-traversal defense)", async () => {
    const { factory } = factoryReturning(fakeSession({}).session);
    await expect(
      runAgent({ name: "../../etc", prompt: "hi", agentsRoot, sessionFactory: factory }),
    ).rejects.toThrow(/invalid agent name/);
  });

  it("errors when the agent dir does not exist", async () => {
    const { factory } = factoryReturning(fakeSession({}).session);
    await expect(
      runAgent({ name: "missingbot", prompt: "hi", agentsRoot, sessionFactory: factory }),
    ).rejects.toThrow(/agent dir not found/);
  });

  it("requires a prompt (the SDK prompt path sends one prompt and exits)", async () => {
    const { factory } = factoryReturning(fakeSession({}).session);
    await expect(
      runAgent({ name: "testbot", agentsRoot, sessionFactory: factory }),
    ).rejects.toThrow(/a prompt is required/);
  });

  it("rejects interactive mode on the SDK prompt path (later PR)", async () => {
    const { factory } = factoryReturning(fakeSession({}).session);
    await expect(
      runAgent({
        name: "testbot",
        prompt: "hi",
        interactive: true,
        agentsRoot,
        sessionFactory: factory,
      }),
    ).rejects.toThrow(/interactive mode is not yet supported/);
  });

  it("routes the prompt to session.prompt", async () => {
    const fake = fakeSession({ textDeltas: ["ok"] });
    const { factory } = factoryReturning(fake.session);
    await runAgent({
      name: "testbot",
      prompt: "draft the brief",
      agentsRoot,
      sessionFactory: factory,
    });
    expect(fake.promptCalls).toEqual(["draft the brief"]);
  });

  it("resolves provider + model from bob.yaml", async () => {
    const fake = fakeSession({ textDeltas: ["ok"] });
    const { factory, lastConfig } = factoryReturning(fake.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe("claude-sonnet-4-6");
    expect(lastConfig()?.provider).toBe("anthropic");
    expect(lastConfig()?.model).toBe("claude-sonnet-4-6");
    // soul.md is passed through as the appended system prompt.
    expect(lastConfig()?.appendSystemPrompt).toBe("You are Testbot.");
  });

  it("maps the exe-dev-gateway provider to anthropic (mirrors init.ts)", async () => {
    writeFileSync(
      join(agentsRoot, "testbot", "bob.yaml"),
      ["provider:", "  name: exe-dev-gateway", "  model: claude-opus-4-7", ""].join("\n"),
    );
    const fake = fakeSession({ textDeltas: ["ok"] });
    const { factory } = factoryReturning(fake.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe("claude-opus-4-7");
  });

  it("honors the per-call model override over bob.yaml", async () => {
    const fake = fakeSession({ textDeltas: ["ok"] });
    const { factory, lastConfig } = factoryReturning(fake.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      model: "claude-haiku-4-6",
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.model).toBe("claude-haiku-4-6");
    expect(lastConfig()?.model).toBe("claude-haiku-4-6");
  });

  it("captures assistant text into RunResult.stdout when captureStdout=true", async () => {
    const fake = fakeSession({ textDeltas: ["partial reply ", "more reply"] });
    const { factory } = factoryReturning(fake.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.stdout).toBe("partial reply more reply");
    expect(res.exitCode).toBe(0);
  });

  it("omits stdout from the result when captureStdout=false (default)", async () => {
    const fake = fakeSession({ textDeltas: ["hidden"] });
    const { factory } = factoryReturning(fake.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.stdout).toBeUndefined();
  });

  it("falls back to the last assistant message when no text_delta is emitted", async () => {
    const fake = fakeSession({
      textDeltas: [],
      finalMessages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "from state" }] },
      ],
    });
    const { factory } = factoryReturning(fake.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.stdout).toBe("from state");
  });

  it("sets a non-zero exitCode when the session errors", async () => {
    const fake = fakeSession({ throwOnPrompt: true });
    const { factory } = factoryReturning(fake.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.exitCode).not.toBe(0);
  });

  it("disposes the session after the run", async () => {
    const fake = fakeSession({ textDeltas: ["ok"] });
    const { factory } = factoryReturning(fake.session);
    await runAgent({ name: "testbot", prompt: "hi", agentsRoot, sessionFactory: factory });
    expect(fake.disposed()).toBe(true);
  });

  it("passes no extension sources when bob.yaml declares no capabilities", async () => {
    const fake = fakeSession({ textDeltas: ["ok"] });
    const { factory, lastConfig } = factoryReturning(fake.session);
    await runAgent({ name: "testbot", prompt: "hi", agentsRoot, sessionFactory: factory });
    expect(lastConfig()?.extensionSources).toEqual([]);
  });

  it("resolves bob.yaml capabilities: into the session's extension sources", async () => {
    // Append a blessed-and-implemented capability (the fixture) to bob.yaml.
    writeFileSync(
      join(agentsRoot, "testbot", "bob.yaml"),
      [
        "provider:",
        "  name: anthropic",
        "  model: claude-sonnet-4-6",
        "",
        "capabilities:",
        "  - fixture",
        "",
        "fixture:",
        "  greeting: hi",
        "",
      ].join("\n"),
    );
    const fake = fakeSession({ textDeltas: ["ok"] });
    const { factory, lastConfig } = factoryReturning(fake.session);
    await runAgent({ name: "testbot", prompt: "hi", agentsRoot, sessionFactory: factory });
    const sources = lastConfig()?.extensionSources ?? [];
    expect(sources).toHaveLength(1);
    expect(sources[0].endsWith("examples/cap-fixture/index.ts")).toBe(true);
  });

  it("fails fast when bob.yaml declares an unbuilt capability", async () => {
    writeFileSync(
      join(agentsRoot, "testbot", "bob.yaml"),
      [
        "provider:",
        "  name: anthropic",
        "  model: claude-sonnet-4-6",
        "",
        "capabilities:",
        "  - mail",
        "",
      ].join("\n"),
    );
    const { factory } = factoryReturning(fakeSession({}).session);
    await expect(
      runAgent({ name: "testbot", prompt: "hi", agentsRoot, sessionFactory: factory }),
    ).rejects.toThrow(/not yet implemented/);
  });
});

// pi records extension load failures on the loader and carries on — the agent
// starts, minus those tools, silently. Bob asked for these extensions, so for
// Bob a failed load is fatal. This is the guard that keeps the "capabilities
// silently didn't load" failure mode from ever being quiet again.
describe("assertCapabilitiesLoaded", () => {
  const stub = (errors: Array<{ path: string; error: string }>) => ({
    getExtensions: () => ({ errors }),
  });

  it("passes when every declared source loaded", () => {
    expect(() =>
      assertCapabilitiesLoaded(stub([]), { extensionSources: ["/caps/discord/dist/index.js"] }),
    ).not.toThrow();
  });

  it("passes when the agent declared no capabilities", () => {
    expect(() =>
      assertCapabilitiesLoaded(stub([{ path: "/somewhere/else.ts", error: "boom" }]), {
        extensionSources: [],
      }),
    ).not.toThrow();
  });

  it("ignores extension errors Bob did not ask for", () => {
    // A user's own settings.json packages are pi's business, not Bob's.
    expect(() =>
      assertCapabilitiesLoaded(stub([{ path: "/user/own/ext.ts", error: "boom" }]), {
        extensionSources: ["/caps/discord/dist/index.js"],
      }),
    ).not.toThrow();
  });

  it("throws naming the capability when its extension failed to load", () => {
    let err: Error | undefined;
    try {
      assertCapabilitiesLoaded(
        stub([{ path: "/caps/discord/dist/index.js", error: "Extension path does not exist" }]),
        {
          extensionSources: ["/caps/discord/dist/index.js"],
          capabilityBySource: { "/caps/discord/dist/index.js": "discord" },
        },
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    const msg = err?.message ?? "";
    expect(msg).toContain('capability "discord"');
    expect(msg).toContain("/caps/discord/dist/index.js");
    expect(msg).toContain("Extension path does not exist");
    expect(msg).toContain("would have started without those tools");
  });
});
