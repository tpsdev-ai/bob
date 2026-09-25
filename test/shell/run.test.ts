import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSession, RunSessionConfig, RunSessionFactory } from "../../src/shell/run.js";
import { assertCapabilitiesLoaded, runAgent } from "../../src/shell/run.js";

// A fake AgentSession matching the RunSession seam. Emits canned assistant
// text via text_delta events and then the `message_end` a real pi turn ends
// with (the assembled message), so tests exercise the capture path without an
// LLM call. The ENDED message is what the completion contract reads; the
// streamed deltas are only "the last thing the agent said".
function fakeSession(opts: {
  textDeltas?: string[];
  // Last-assistant-message fallback (used when no message_end is emitted).
  finalMessages?: ReadonlyArray<unknown>;
  // Throw from prompt() to simulate a session error.
  throwOnPrompt?: boolean;
  // Emit the deltas WITHOUT a closing message_end (a transport that streams
  // text but ends no message). Defaults to false: real pi ends the message.
  noMessageEnd?: boolean;
  // End the turn with this stopReason instead of "stop" ("error"/"aborted"
  // end the assistant message with no usable content).
  stopReason?: string;
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
      const deltas = opts.textDeltas ?? [];
      for (const delta of deltas) {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
          });
        }
      }
      if (opts.noMessageEnd) return;
      const stopReason = opts.stopReason ?? "stop";
      // A failure-ended message ends EMPTY (pi's StreamFn contract encodes
      // failures in the stream): only a clean stop carries the assembled text.
      const assembled = stopReason === "error" || stopReason === "aborted" ? "" : deltas.join("");
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: assembled.length > 0 ? [{ type: "text", text: assembled }] : [],
            stopReason,
          },
        });
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
      [
        "agent:",
        "  id: testbot",
        "  name: Testbot",
        "  role: ea",
        "",
        "provider:",
        "  name: exe-dev-gateway",
        "  model: claude-opus-4-7",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
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

  it("falls back to the last assistant message when the transport ends no message at all", async () => {
    // A transport that streams nothing and ends no assistant message: the SDK's
    // `message_end` never arrives, so the observer has no ended message to read
    // and the session-state fallback is the only source of final text. (When a
    // message DOES end, its own content is the final message — never the state.)
    const fake = fakeSession({
      textDeltas: [],
      noMessageEnd: true,
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
    expect(sources[0].endsWith("/dist/capabilities/fixture/index.js")).toBe(true);
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

  // Read the single run-log JSONL file written under ~/agents/<name>/runs.
  // Returns { path, lines } — lines are the parsed JSON records in order.
  function readRunLog(name: string): { path: string; lines: unknown[] } {
    const runsDir = join(agentsRoot, name, "runs");
    expect(existsSync(runsDir)).toBe(true);
    const files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const path = join(runsDir, files[0]);
    const text = readFileSync(path, "utf8");
    const lines = text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    return { path, lines };
  }

  // Run `fn` with process.stderr.write captured; returns everything written.
  async function captureStderr(fn: () => Promise<void>): Promise<string> {
    const original = process.stderr.write.bind(process.stderr);
    let buf = "";
    // biome-ignore lint/suspicious/noExplicitAny: monkeypatch signature match
    (process.stderr as any).write = (chunk: any): boolean => {
      buf += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    };
    try {
      await fn();
    } finally {
      process.stderr.write = original;
    }
    return buf;
  }

  it("surfaces the error to stderr and writes a non-empty run-log when the session dies", async () => {
    const fake = fakeSession({ throwOnPrompt: true });
    const { factory } = factoryReturning(fake.session);
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const stderr = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        captureStdout: true,
        agentsRoot,
        sessionFactory: factory,
      });
    });
    // Fix 1: error is surfaced (no longer swallowed), exit code non-zero.
    expect(res?.exitCode).toBe(1);
    expect(stderr).toMatch(/simulated session failure/);
    expect(stderr).toMatch(/run failed/);
    // The run-log path is announced on stderr at the start.
    expect(stderr).toMatch(/run log:/);
    // Fix 2: a run-log file exists, is non-empty, and records the death.
    const { lines } = readRunLog("testbot");
    expect(lines.length).toBeGreaterThan(0);
    const doneLine = lines.find(
      (l): l is { done: boolean; exitCode: number } =>
        typeof l === "object" && l !== null && (l as { done?: unknown }).done === true,
    );
    expect(doneLine).toBeDefined();
    expect(doneLine?.exitCode).toBe(1);
  });

  it("labels a provider rate-limit/cap distinctly on stderr", async () => {
    const capSession = fakeSession({});
    // Override prompt() to throw a cap-shaped error.
    capSession.session.prompt = async () => {
      throw new Error("429 Too Many Requests: usage limit reached");
    };
    const { factory } = factoryReturning(capSession.session);
    const stderr = await captureStderr(async () => {
      await runAgent({ name: "testbot", prompt: "hi", agentsRoot, sessionFactory: factory });
    });
    expect(stderr).toMatch(/PROVIDER RATE-LIMIT\/CAP/);
    expect(stderr).not.toMatch(/run failed/);
  });

  it("tees every event to the run-log and still returns byte-identical captured text (happy path)", async () => {
    const fake = fakeSession({ textDeltas: ["partial reply ", "more reply"] });
    const { factory } = factoryReturning(fake.session);
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        captureStdout: true,
        agentsRoot,
        sessionFactory: factory,
      });
    });
    // Happy-path returned text is UNCHANGED by the logging.
    expect(res?.stdout).toBe("partial reply more reply");
    expect(res?.exitCode).toBe(0);
    // The run-log captured the text_delta events, the message_end and a done
    // line — every event, in order.
    const { lines } = readRunLog("testbot");
    const eventLines = lines.filter(
      (l): l is { t: string; event: unknown } =>
        typeof l === "object" && l !== null && "event" in (l as object),
    );
    expect(eventLines.length).toBe(3);
    expect((eventLines.at(-1)?.event as { type?: string })?.type).toBe("message_end");
    const doneLine = lines.find(
      (l): l is { done: boolean; exitCode: number } =>
        typeof l === "object" && l !== null && (l as { done?: unknown }).done === true,
    );
    expect(doneLine).toBeDefined();
    expect(doneLine?.exitCode).toBe(0);
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

// The role tool allowlist must actually bind the session. role.json's
// tools.allow is stamped into bob.yaml's `tools:` block by `bob init`, and
// nothing used to read it back: every agent got pi's defaults (read, bash,
// edit, write) plus capability tools regardless of its role. These tests drive
// the resolved config a session factory receives, which is what createPiRunSession
// hands to createAgentSession (see run-tool-allowlist.test.ts for the call
// itself).
describe("runAgent — the role tool allowlist binds the session", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-run-tools-"));
    const agentDir = join(agentsRoot, "testbot");
    mkdirSync(join(agentDir, "work"), { recursive: true });
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    writeFileSync(join(agentDir, "soul.md"), "You are Testbot.");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  // Write the agent's bob.yaml. `allow` renders as the block list `bob init`
  // emits, so the test exercises the real reader, not a hand-built object.
  //
  // `role` defaults to "ea". The ROLE is the ceiling on the allowlist, so a
  // test that wants a shell or a file-writing tool names the role that has one.
  function writeBobYaml(opts: {
    allow?: string[];
    exclude?: string[];
    allowResidentShell?: boolean;
    resident?: boolean;
    role?: string;
    // Omit the whole `tools:` block (the fail-closed case).
    omitToolsBlock?: boolean;
    // Render the block with no `allow:` key at all.
    omitAllow?: boolean;
  }): void {
    const lines = [
      "agent:",
      "  id: testbot",
      "  name: Testbot",
      `  role: ${opts.role ?? "ea"}`,
      "",
      "provider:",
      "  name: anthropic",
      "  model: claude-sonnet-4-6",
      "",
    ];
    if (opts.resident !== undefined) lines.push(`resident: ${opts.resident}`, "");
    if (!opts.omitToolsBlock) {
      lines.push("tools:");
      if (!opts.omitAllow && opts.allow !== undefined) {
        lines.push("  allow:");
        for (const name of opts.allow) lines.push(`    - ${name}`);
      }
      if (opts.exclude !== undefined) {
        lines.push("  exclude:");
        for (const name of opts.exclude) lines.push(`    - ${name}`);
      }
      if (opts.allowResidentShell !== undefined) {
        lines.push(`  allowResidentShell: ${opts.allowResidentShell}`);
      }
    }
    lines.push("");
    writeFileSync(join(agentsRoot, "testbot", "bob.yaml"), lines.join("\n"));
  }

  type TooledConfig = RunSessionConfig & { tools?: string[]; excludeTools?: string[] };

  async function configFor(): Promise<TooledConfig> {
    const { factory, lastConfig } = factoryReturning(fakeSession({ textDeltas: ["ok"] }).session);
    await runAgent({ name: "testbot", prompt: "hi", agentsRoot, sessionFactory: factory });
    return lastConfig() as TooledConfig;
  }

  // The error a refused run throws. `runAgent` must not resolve: a session with
  // no resolved policy is the defect, so "it started anyway" is a test failure.
  async function errorFor(): Promise<Error> {
    const { factory } = factoryReturning(fakeSession({ textDeltas: ["ok"] }).session);
    let err: Error | undefined;
    try {
      await runAgent({ name: "testbot", prompt: "hi", agentsRoot, sessionFactory: factory });
    } catch (e) {
      err = e as Error;
    }
    if (!err) throw new Error("expected the run to be refused, but it resolved");
    return err;
  }

  it("hands the session EXACTLY the bob.yaml allowlist", async () => {
    writeBobYaml({ allow: ["read", "flair_search", "flair_write"] });
    const config = await configFor();
    expect(config.tools).toEqual(["read", "flair_search", "flair_write"]);
  });

  it("carries a tools.exclude block through as excludeTools", async () => {
    writeBobYaml({ role: "qa", allow: ["read", "bash"], exclude: ["bash"] });
    const config = await configFor();
    expect(config.tools).toEqual(["read", "bash"]);
    expect(config.excludeTools).toEqual(["bash"]);
  });

  it("keeps an EXPLICIT empty allow list as [] — that is 'no tools'", async () => {
    // `allow:` with no items is a decision (this agent holds no tools), which is
    // a different thing from a missing block. The session gets an empty strict
    // allowlist, not pi's defaults.
    writeBobYaml({ allow: [] });
    const config = await configFor();
    expect(config.tools).toEqual([]);
    expect(config.excludeTools).toEqual([]);
  });

  it("refuses an allowlisted name that maps to nothing, naming it and the fix", async () => {
    // "Bash" is the OpenClaw-era casing `bob init` used to stamp into bob.yaml.
    // pi's registry only knows "bash", so an unmapped name must be a loud load
    // error rather than a silent drop (pi ignores unknown names).
    writeBobYaml({ allow: ["read", "Bash"] });
    const err = await errorFor();
    const msg = err.message;
    expect(msg).toContain("Bash");
    expect(msg).toContain("bash");
  });

  it("refuses an unknown key in the tools block", async () => {
    writeFileSync(
      join(agentsRoot, "testbot", "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: ea",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-sonnet-4-6",
        "",
        "tools:",
        "  alow:",
        "    - read",
        "",
      ].join("\n"),
    );
    const err = await errorFor();
    expect(err.message).toContain("alow");
  });

  it("excludes shell + file-writing tools from a RESIDENT agent", async () => {
    // A resident agent runs unattended behind a service unit; the role's
    // allowlist must not hand it a shell unless the ROLE opts in.
    writeBobYaml({ role: "qa", allow: ["read", "bash", "edit", "write"], resident: true });
    const config = await configFor();
    expect(config.tools).toEqual(["read", "bash", "edit", "write"]);
    expect(config.excludeTools).toEqual(["bash", "write", "edit", "powershell"]);
  });

  it("keeps a resident CODER's shell — the opt-in lives in the role now", async () => {
    // The coder role grants tools.allowResidentShell, so a persistent builder
    // keeps bash/write/edit. bob.yaml does not repeat it: the role is the
    // ceiling, and a permission the role grants does not have to be re-declared
    // in a file the agent can edit.
    writeBobYaml({ role: "coder", allow: ["read", "bash", "edit", "write"], resident: true });
    const config = await configFor();
    expect(config.tools).toEqual(["read", "bash", "edit", "write"]);
    expect(config.excludeTools).toEqual([]);
  });

  it("refuses a bob.yaml that widens the allowlist beyond the role", async () => {
    // `bash` is not in the ea role's role.json, and bob.yaml is the file the
    // agent can edit — so a name the role does not allow is a widening, not a
    // default. Refused by name, with the role that would have to change.
    writeBobYaml({ role: "ea", allow: ["read", "bash"] });
    const err = await errorFor();
    expect(err.message).toContain("bash");
    expect(err.message).toContain("ea");
    expect(err.message).toContain("role");
  });

  it("refuses allowResidentShell in bob.yaml when the ROLE does not grant it", async () => {
    // The opt-in moved into the role schema; a bob.yaml that re-adds it to a
    // role without it is the same widening, by another key.
    writeBobYaml({
      role: "qa",
      allow: ["read", "bash"],
      resident: true,
      allowResidentShell: true,
    });
    const err = await errorFor();
    expect(err.message).toContain("allowResidentShell");
    expect(err.message).toContain("qa");
  });

  it("refuses a bob.yaml with NO tools block (a missing policy is not a default)", async () => {
    // The whole point: an absent allowlist used to mean "pi's defaults", so a
    // role's tools never bound anything. It is now a load error.
    writeBobYaml({ omitToolsBlock: true });
    const err = await errorFor();
    expect(err.message).toMatch(/no tools: block/);
  });

  it("refuses a tools: block with no allow: list", async () => {
    writeBobYaml({ omitAllow: true, exclude: ["bash"] });
    const err = await errorFor();
    expect(err.message).toMatch(/no allow: list/);
  });
});

// #145: the ONE completion contract a one-shot run's exit code comes from, and
// the blank task refused BEFORE a session exists. The task itself now rides the
// session's system prompt (runAgent sets `taskContract`), so these tests assert
// the boundary behaviour: what the run refuses, and what it reports.
describe("runAgent — the completion contract (#145)", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-run-contract-"));
    const agentDir = join(agentsRoot, "testbot");
    mkdirSync(join(agentDir, "work"), { recursive: true });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
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
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  /** A session that emits scripted events per prompt, then ends. */
  function scriptedSession(eventsForPrompt: (text: string, call: number) => unknown[]) {
    const prompts: string[] = [];
    const promptOptions: unknown[] = [];
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => {};
      },
      async prompt(text: string, options?: unknown) {
        // A STEER (the best-effort note) is not a turn the test scripts: only a
        // real prompt runs the scripted events. Without this, the note's own
        // steer would emit another compaction and loop. (bob's own prompt entry
        // point passes `expandPromptTemplates: false`, which is still a real
        // prompt — the tell is the streaming behaviour.)
        const streaming = (options as { streamingBehavior?: string } | undefined)
          ?.streamingBehavior;
        if (streaming !== undefined) return;
        prompts.push(text);
        promptOptions.push(options);
        for (const event of eventsForPrompt(text, prompts.length)) {
          for (const listener of listeners) listener(event);
        }
      },
      dispose() {},
    } as unknown as RunSession;
    return { session, prompts, promptOptions };
  }

  /** Capture what a run writes to stderr, without touching the real stream. */
  async function captureStderrLocal(fn: () => Promise<void>): Promise<string> {
    let out = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      out += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      await fn();
    } finally {
      process.stderr.write = original;
    }
    return out;
  }

  const assistantEnd = (text: string, stopReason = "stop") => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason },
  });

  it("refuses a blank task BEFORE the session starts", async () => {
    let factoryCalls = 0;
    const factory: RunSessionFactory = async () => {
      factoryCalls += 1;
      return scriptedSession(() => []).session;
    };
    for (const prompt of ["", "   ", "\n\t "]) {
      await expect(
        runAgent({ name: "testbot", prompt, agentsRoot, sessionFactory: factory }),
      ).rejects.toThrow(/blank task/);
    }
    expect(factoryCalls, "no session was ever stood up").toBe(0);
  });

  it("carries the task as the session's contract, and the task is still the prompt", async () => {
    const scripted = scriptedSession(() => [assistantEnd("did it")]);
    const { factory, lastConfig } = factoryReturning(scripted.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "commit the fixture",
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(scripted.prompts).toEqual(["commit the fixture"]);
    expect(lastConfig()?.taskContract).toBe("commit the fixture");
  });

  it("refuses to report success when the session ends NO message (no_final_message)", async () => {
    const scripted = scriptedSession(() => []);
    const { factory } = factoryReturning(scripted.session);
    const stderr = await captureStderrLocal(async () => {
      const res = await runAgent({
        name: "testbot",
        prompt: "do the thing",
        agentsRoot,
        sessionFactory: factory,
      });
      expect(res.exitCode).toBe(1);
      expect(res.reason).toBe("no_final_message");
    });
    expect(stderr).toContain("REFUSING to report success");
  });

  it("retries ONCE with a continue turn after a compaction that ended with no message, then refuses", async () => {
    // Every turn: a compaction, no message. So the first judge is
    // settled_after_compaction, the retry runs, and the second judge refuses.
    const scripted = scriptedSession(() => [
      { type: "compaction_end", reason: "threshold", aborted: false },
    ]);
    const { factory } = factoryReturning(scripted.session);
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const stderr = await captureStderrLocal(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "do the thing",
        agentsRoot,
        sessionFactory: factory,
      });
    });
    expect(res?.exitCode).toBe(1);
    expect(res?.reason).toBe("settled_after_compaction");
    expect(scripted.prompts).toHaveLength(2);
    expect(scripted.prompts[1]).toContain("BOB CONTINUE");
    // The retry goes through the one non-interactive prompt entry point, so
    // template and command expansion are off by construction.
    expect(scripted.promptOptions[1]).toEqual({ expandPromptTemplates: false });
    expect(stderr).toContain("retrying once with a continue turn");
  });

  it("accepts the retry's final message (the retry is judged like the first turn)", async () => {
    // The FIRST turn compacts and goes silent; the retry ends with a message.
    const scripted = scriptedSession((_text, call) =>
      call === 1
        ? [{ type: "compaction_end", reason: "threshold" }]
        : [assistantEnd("finished after the retry")],
    );
    const { factory } = factoryReturning(scripted.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("finished after the retry");
    expect(scripted.prompts).toHaveLength(2);
  });

  it("does NOT retry when the turn ended with a message after a compaction", async () => {
    const scripted = scriptedSession(() => [
      { type: "compaction_end", reason: "threshold" },
      assistantEnd("still here"),
    ]);
    const { factory } = factoryReturning(scripted.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("still here");
    expect(scripted.prompts).toHaveLength(1);
  });

  it("reports final_shape_mismatch when a declared shape is not met", async () => {
    const scripted = scriptedSession(() => [assistantEnd("not the declared shape")]);
    const { factory } = factoryReturning(scripted.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      expectedFinal: (text) => text.startsWith("COMMITTED:"),
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("final_shape_mismatch");
  });

  it('sends the best-effort "what remains" note after a compaction, as a STEER', async () => {
    const steers: Array<{ text: string; options?: unknown }> = [];
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => {};
      },
      async prompt(text: string, options?: unknown) {
        const streaming = (options as { streamingBehavior?: string } | undefined)
          ?.streamingBehavior;
        if (streaming !== undefined) {
          steers.push({ text, options });
          return;
        }
        for (const listener of listeners) {
          listener({ type: "compaction_end", reason: "threshold" });
          listener(assistantEnd("turn done"));
        }
      },
      dispose() {},
    } as unknown as RunSession;
    const { factory } = factoryReturning(session);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.exitCode).toBe(0);
    expect(steers).toHaveLength(1);
    expect(steers[0].text).toContain("WHAT REMAINS");
    expect((steers[0].options as { streamingBehavior?: string }).streamingBehavior).toBe("steer");
  });
});
