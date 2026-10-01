// run-termination.test.ts — bob#135. A one-shot `bob run` must always
// terminate. These exercise the three bounds against the injectable session
// seam: a stalled provider is ended by the wall clock and by the per-call
// timeout, a run-log stall trips the no-progress watchdog, and a provider that
// answers (once, or in a stream of events) is left unchanged.
//
// Every case passes a SHORT configured bound and its own bun timeout, so a
// missing or broken bound fails the case rather than hanging the suite.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

interface Fake {
  session: RunSession;
  promptCalls: string[];
  abortCount: () => number;
}

// A controllable RunSession. `runPrompt` decides what `prompt()` does on each
// call: emit events, resolve, or stall forever.
function fakeSession(
  runPrompt: (emit: Emitter, text: string, call: number) => Promise<void>,
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
      callTimeoutMs: 60_000,
      callRetries: 0,
    });
    expect(res.exitCode).toBe(1);
    expect(res.aborted).toBe("wall_clock");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it("ends a stalled provider call at the per-call timeout after its retry", async () => {
    const fake = fakeSession(() => new Promise<void>(() => {}));
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 60_000,
      noProgressMs: 60_000,
      callTimeoutMs: 50,
      callRetries: 1,
    });
    expect(res.exitCode).toBe(1);
    expect(res.aborted).toBe("call_timeout");
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
      callTimeoutMs: 60_000,
      callRetries: 0,
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
      callTimeoutMs: 60_000,
      callRetries: 0,
    });
    expect(res.exitCode).toBe(0);
    expect(res.aborted).toBeUndefined();
  }, 15_000);

  it("leaves a normally-answering provider unchanged", async () => {
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
