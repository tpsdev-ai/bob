import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { CONTINUE_TURN } from "../../src/shell/compaction-contract.js";
import type { RunSession, RunSessionConfig, RunSessionFactory } from "../../src/shell/run.js";
import { assertCapabilitiesLoaded, runAgent } from "../../src/shell/run.js";

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

// A fake session whose prompt() is SCRIPTED per call, so a test can drive the
// #145 shape: the first prompt emits `compaction_end` (the context threshold)
// and then settles with NO final message. The re-injection and the retry arrive
// as further prompt() calls — the re-injection carries streamingBehavior
// "steer" (it lands mid-run), the retry does not.
function scriptedSession(
  script: Array<{
    textDeltas?: string[];
    /** Text streamed BEFORE this prompt's compaction (if it emits one). */
    textDeltasBefore?: string[];
    compact?: "threshold" | "overflow" | "manual";
    aborted?: boolean;
  }>,
): { session: RunSession; calls: Array<{ text: string; streamingBehavior?: string }> } {
  const calls: Array<{ text: string; streamingBehavior?: string }> = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal event listener stub
  const listeners: Array<(event: any) => void> = [];
  // The script advances only on TOP-LEVEL prompts; the mid-run re-injection is
  // a steer and must not consume a script step.
  let topLevelCall = 0;
  const session: RunSession = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt(text, options) {
      calls.push({ text, streamingBehavior: options?.streamingBehavior });
      const step = options?.streamingBehavior === undefined ? (script[topLevelCall++] ?? {}) : {};
      for (const delta of step.textDeltasBefore ?? []) {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
          });
        }
      }
      if (step.compact) {
        for (const listener of listeners) {
          listener({
            type: "compaction_end",
            reason: step.compact,
            result: {},
            aborted: step.aborted === true,
            willRetry: false,
          });
        }
      }
      for (const delta of step.textDeltas ?? []) {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
          });
        }
      }
    },
    get messages() {
      return undefined;
    },
    dispose() {},
  };
  return { session, calls };
}

// Make `dir` a git repo with one committed file and one uncommitted change, so
// a run's dirty-path report has something to show.
function initDirtyRepo(dir: string): void {
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "core.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "core.ts"), "export const a = 2;\n");
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
    // The run-log captured the text_delta events plus a done line.
    const { lines } = readRunLog("testbot");
    const eventLines = lines.filter(
      (l): l is { t: string; event: unknown } =>
        typeof l === "object" && l !== null && "event" in (l as object),
    );
    expect(eventLines.length).toBe(2);
    const doneLine = lines.find(
      (l): l is { done: boolean; exitCode: number } =>
        typeof l === "object" && l !== null && (l as { done?: unknown }).done === true,
    );
    expect(doneLine).toBeDefined();
    expect(doneLine?.exitCode).toBe(0);
  });

  // ── cli#145: the compaction contract ──────────────────────────────

  it("cli#145 round 2: text streamed BEFORE a compaction is not the final message — a silent settle retries once and exits non-zero", async () => {
    // The exact #145 shape: the agent says "review, then commit" and the context
    // then compacts; the run settles with no further message. The pre-compaction
    // text must NOT satisfy the completion contract.
    const s = scriptedSession([
      { textDeltasBefore: ["review, then commit"], compact: "threshold" },
    ]);
    const { factory } = factoryReturning(s.session);
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const stderr = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "finish the release",
        captureStdout: true,
        agentsRoot,
        sessionFactory: factory,
      });
    });
    // One pinned-block re-injection (a steer), then ONE retry, then the refusal.
    expect(s.calls).toHaveLength(3);
    expect(s.calls[1]?.streamingBehavior).toBe("steer");
    expect(res?.exitCode).not.toBe(0);
    expect(res?.reason).toBe("settled_after_compaction");
    expect(res?.stdout, "the pre-compaction text is not the final message").toBe("");
    expect(stderr).toContain("settled_after_compaction");
  });

  it("cli#145: a session that compacts mid-task then settles silently re-injects the pinned block, retries ONCE, and exits non-zero", async () => {
    // The exact #145 shape: threshold compaction, then agent_settled with no
    // tool call and no final message. Before #145 this returned exit 0.
    const s = scriptedSession([{ compact: "threshold" }]);
    initDirtyRepo(join(agentsRoot, "testbot", "work"));
    const { factory } = factoryReturning(s.session);
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const stderr = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "commit the two core files and push",
        captureStdout: true,
        agentsRoot,
        sessionFactory: factory,
      });
    });

    // 1. ONE pinned block was re-injected on compaction_end — as a STEER, so it
    //    lands on the RUNNING turn rather than waiting for idle.
    expect(s.calls).toHaveLength(3);
    expect(s.calls[0].text).toBe("commit the two core files and push");
    expect(s.calls[0].streamingBehavior).toBeUndefined();
    expect(s.calls[1].streamingBehavior).toBe("steer");
    expect(s.calls[1].text).toContain("commit the two core files and push");
    expect(s.calls[1].text).toContain("WHAT REMAINS");

    // 2. exactly ONE retry, the explicit "continue from the state above" turn.
    expect(s.calls[2].text).toBe(CONTINUE_TURN);

    // 3. non-zero exit with the NAMED reason, and the dirty paths printed.
    expect(res?.exitCode).not.toBe(0);
    expect(res?.reason).toBe("settled_after_compaction");
    expect(stderr).toContain("settled_after_compaction");
    expect(stderr).toContain("M core.ts");

    // The run log's final record stays truthful about the non-zero exit.
    const { lines } = readRunLog("testbot");
    const doneLine = lines.find(
      (l): l is { done: boolean; exitCode: number } =>
        typeof l === "object" && l !== null && (l as { done?: unknown }).done === true,
    );
    expect(doneLine?.exitCode).toBe(1);
  });

  it("cli#145: a normal run with a final message exits 0 and never retries (unchanged)", async () => {
    const s = scriptedSession([{ textDeltas: ["done: committed and pushed"] }]);
    const { factory } = factoryReturning(s.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factory,
    });
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(s.calls).toHaveLength(1); // no re-injection, no retry
    expect(res.stdout).toBe("done: committed and pushed");
  });

  it("cli#145: a silent run with NO compaction exits non-zero with no_final_message and does not retry", async () => {
    const s = scriptedSession([{}]); // settles with no text and no compaction
    const { factory } = factoryReturning(s.session);
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const stderr = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "do the thing",
        captureStdout: true,
        agentsRoot,
        sessionFactory: factory,
      });
    });
    expect(res?.exitCode).not.toBe(0);
    expect(res?.reason).toBe("no_final_message");
    expect(s.calls).toHaveLength(1); // silence without a compaction is not retried
    expect(stderr).toContain("no_final_message");
  });

  it("cli#145: the retry rescues the run when it produces a final message", async () => {
    const s = scriptedSession([{ compact: "threshold" }, { textDeltas: ["continued: committed"] }]);
    const { factory } = factoryReturning(s.session);
    const res = await runAgent({
      name: "testbot",
      prompt: "finish it",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factory,
    });
    expect(s.calls).toHaveLength(3); // task, re-injection, retry
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(res.stdout).toBe("continued: committed");
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
