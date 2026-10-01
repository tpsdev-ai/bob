// run-termination.test.ts — bob#135. A one-shot `bob run` must end when a bound
// fires. These exercise the three bounds against the injectable session seam (a
// `RunSession`, not a provider): a stalled session is ended by the wall clock
// and by the turn timeout, a run-log stall trips the no-progress watchdog, and a
// session that answers (once, or in a stream of events) is left unchanged. A
// session whose `abort()` never settles is ended regardless, and a subprocess
// proves the process itself exits with the run's code then.
//
// The bound cases pass a SHORT configured bound and their own bun timeout, so a
// missing or broken bound fails the case rather than hanging the suite.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSession, RunSessionFactory } from "../../src/shell/run.js";
import { runAgent } from "../../src/shell/run.js";

type Emitter = (event: unknown) => void;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const textDelta = (d: string): unknown => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: d },
});

const messageEnd = (text: string, stopReason = "stop"): unknown => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }] : [],
    stopReason,
  },
});

// An assistant message that ended with thinking only (no text, no tool call):
// the shape the reasoning re-prompt loop reacts to (bob#256).
const thinkingEnd = (thinking: string): unknown => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "thinking", thinking }], stopReason: "stop" },
});

interface Fake {
  session: RunSession;
  promptCalls: string[];
  abortCount: () => number;
}

// A controllable RunSession. `runPrompt` decides what `prompt()` does on each
// call: emit events, resolve, or stall forever. `runAbort` (default: settle at
// once) decides what `abort()` does — pass a never-settling promise to model
// pi's abort() waiting for a turn that never becomes idle.
function fakeSession(
  runPrompt: (emit: Emitter, text: string, call: number) => Promise<void>,
  runAbort?: () => Promise<void>,
): Fake {
  const listeners: Array<(event: unknown) => void> = [];
  const promptCalls: string[] = [];
  let aborts = 0;
  const emit: Emitter = (event) => {
    for (const listener of listeners) listener(event);
  };
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
      await runPrompt(emit, text, promptCalls.length);
    },
    async abort() {
      aborts += 1;
      if (runAbort) await runAbort();
    },
    dispose() {
      // no-op
    },
  };
  return { session, promptCalls, abortCount: () => aborts };
}

function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
}

describe("runAgent termination bounds (bob#135)", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-run-term-"));
    const agentDir = join(agentsRoot, "testbot");
    mkdirSync(join(agentDir, "work"), { recursive: true });
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  name: Testbot",
        "  role: reviewer",
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

  it("ends a stalled run non-zero at the wall clock, naming it", async () => {
    const fake = fakeSession(() => new Promise<void>(() => {})); // never answers
    const started = Date.now();
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 60,
      noProgressMs: 60_000,
      turnTimeoutMs: 60_000,
      turnRetries: 0,
    });
    expect(res.exitCode).toBe(1);
    expect(res.aborted).toBe("wall_clock");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it("ends a stalled turn at the turn timeout after its retry", async () => {
    const fake = fakeSession(() => new Promise<void>(() => {}));
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 60_000,
      noProgressMs: 60_000,
      turnTimeoutMs: 50,
      turnRetries: 1,
    });
    expect(res.exitCode).toBe(1);
    expect(res.aborted).toBe("turn_timeout");
    // one attempt + one retry
    expect(fake.promptCalls.length).toBe(2);
    // the stuck turn was aborted on the session before the retry and on give-up
    expect(fake.abortCount()).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("trips the no-progress watchdog when the run log stops growing", async () => {
    // Emit two events, then stall forever: the log stops growing.
    const fake = fakeSession((emit) => {
      emit(textDelta("working"));
      emit(textDelta("..."));
      return new Promise<void>(() => {});
    });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 60_000,
      noProgressMs: 60,
      turnTimeoutMs: 60_000,
      turnRetries: 0,
    });
    expect(res.exitCode).toBe(1);
    expect(res.aborted).toBe("no_progress");
  }, 15_000);

  it("does not trip the watchdog while the run keeps making progress", async () => {
    const fake = fakeSession(async (emit) => {
      for (let i = 0; i < 12; i++) {
        emit(textDelta("x"));
        await sleep(20);
      }
      emit(messageEnd("done"));
    });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 60_000,
      noProgressMs: 150,
      turnTimeoutMs: 60_000,
      turnRetries: 0,
    });
    expect(res.exitCode).toBe(0);
    expect(res.aborted).toBeUndefined();
  }, 15_000);

  it("ends a reasoning-only turn whose continuation stalls at the turn timeout", async () => {
    // The first prompt answers with a thinking-only ending; the continuation
    // (the re-prompt) never answers. The continuation is routed through the
    // SAME bounded sender, so the turn timeout ends the run — without it, the
    // continuation would hang forever.
    const fake = fakeSession(async (emit, _text, call) => {
      if (call === 1) {
        emit(thinkingEnd("thinking..."));
        return;
      }
      return new Promise<void>(() => {});
    });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 60_000,
      noProgressMs: 60_000,
      turnTimeoutMs: 50,
      turnRetries: 0,
    });
    expect(res.exitCode).toBe(1);
    expect(res.aborted).toBe("turn_timeout");
    expect(fake.promptCalls.length).toBe(2); // the prompt + one continuation
  }, 15_000);

  it("returns once a bound fires even though abort() never settles", async () => {
    // abort() never settles: pi's abort() waits for idle, so this is the shape
    // that used to keep the run pending after the wall clock fired.
    const fake = fakeSession(
      () => new Promise<void>(() => {}),
      () => new Promise<void>(() => {}),
    );
    const started = Date.now();
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 60,
      noProgressMs: 60_000,
      turnTimeoutMs: 60_000,
      turnRetries: 0,
    });
    expect(res.exitCode).toBe(1);
    expect(res.aborted).toBe("wall_clock");
    // The bound (60ms) plus the abort grace (1s), not "forever".
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it("a subprocess exits with the run's code when abort() never settles", () => {
    // The real CLI cannot be handed a hanging abort from outside, so this child
    // mirrors cli.ts's `main().then((code) => process.exit(code))` around the
    // same runAgent call, with a session whose abort() never settles.
    const script = join(agentsRoot, "hang-abort-child.ts");
    writeFileSync(
      script,
      [
        `import { runAgent } from ${JSON.stringify(join(import.meta.dir, "../../src/shell/run.ts"))};`,
        "const session = {",
        "  subscribe: () => () => {},",
        "  prompt: () => new Promise(() => {}),",
        "  abort: () => new Promise(() => {}),",
        "  dispose: () => {},",
        "};",
        "const res = await runAgent({",
        '  name: "testbot",',
        '  prompt: "hi",',
        `  agentsRoot: ${JSON.stringify(agentsRoot)},`,
        "  sessionFactory: async () => session,",
        "  wallClockMs: 60,",
        "  noProgressMs: 60000,",
        "  turnTimeoutMs: 60000,",
        "  turnRetries: 0,",
        "});",
        'process.stderr.write("CHILD_RUN_CODE=" + res.exitCode + "\\n");',
        "process.exit(res.exitCode);",
      ].join("\n"),
    );
    const started = Date.now();
    const out = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 8_000 });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("CHILD_RUN_CODE=1");
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 20_000);

  it("leaves a normally-answering session unchanged", async () => {
    const fake = fakeSession(async (emit) => {
      emit(textDelta("ok"));
      emit(messageEnd("ok"));
    });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      captureStdout: true,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("ok");
    expect(res.aborted).toBeUndefined();
  }, 15_000);
});
