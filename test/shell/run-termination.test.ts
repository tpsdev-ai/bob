// run-termination.test.ts — bob#135. A one-shot `bob run` must end when a bound
// fires. These exercise the three bounds against the injectable session seam (a
// `RunSession`, not a provider): a stalled session is ended by the wall clock
// and by the turn timeout, a run-log stall trips the no-progress watchdog, and a
// session that answers (once, or in a stream of events) is left unchanged. A
// turn timeout ends the run: no second prompt starts, including when the wall
// clock fires during the abort grace. A session whose `abort()` is missing,
// rejects or never settles still ends the run, and the report says the
// workspace may still be changing; a subprocess proves the process itself exits
// with the run's code, and a child given a long turn timer exits without
// waiting for it. The workspace status is read after the abort, and a worktree
// git cannot read is reported as an unavailable status, never as clean.
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
  /** Every prompt() call that started a turn. */
  promptCalls: string[];
  /** Every message queued without starting a turn: steer(), or a steering
   *  prompt() while a turn is streaming. */
  queued: string[];
  abortCount: () => number;
}

// A controllable RunSession. `runPrompt` decides what `prompt()` does on each
// call: emit events, resolve, or stall forever. `runAbort` (default: settle at
// once) decides what `abort()` does — pass a never-settling promise to model
// pi's abort() waiting for a turn that never becomes idle, or `null` for a
// session with no abort() at all. `runAbort` gets the emitter, so an abort can
// deliver session events while the run waits for it.
//
// The fake follows pi's queueing rule: `steer()` only queues, and a prompt()
// with `streamingBehavior` queues while a turn is streaming but STARTS a turn
// when the session is idle. A turn streams while `runPrompt` runs; `runPrompt`
// can call `setStreaming(false)` to model pi's pre-prompt compaction, which
// runs inside prompt() before the agent run starts.
function fakeSession(
  runPrompt: (
    emit: Emitter,
    text: string,
    call: number,
    setStreaming: (streaming: boolean) => void,
  ) => Promise<void>,
  runAbort?: ((emit: Emitter) => Promise<void>) | null,
): Fake {
  const listeners: Array<(event: unknown) => void> = [];
  const promptCalls: string[] = [];
  const queued: string[] = [];
  let streaming = false;
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
    async prompt(text, options) {
      if (options?.streamingBehavior !== undefined && streaming) {
        queued.push(text);
        return;
      }
      promptCalls.push(text);
      streaming = true;
      try {
        await runPrompt(emit, text, promptCalls.length, (b) => {
          streaming = b;
        });
      } finally {
        streaming = false;
      }
    },
    async steer(text) {
      queued.push(text);
    },
    dispose() {
      // no-op
    },
  };
  if (runAbort !== null) {
    session.abort = async () => {
      aborts += 1;
      if (runAbort) await runAbort(emit);
    };
  }
  return { session, promptCalls, queued, abortCount: () => aborts };
}

function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
}

/** Capture what a run writes to stderr, without touching the real stream. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
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
    });
    expect(res.exitCode).toBe(1);
    expect(res.aborted).toBe("wall_clock");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it("a turn timeout ends the run: no second prompt starts", async () => {
    // abort() resolves at once, so only the rule that a turn timeout ends the
    // run keeps a second prompt from starting.
    const fake = fakeSession(() => new Promise<void>(() => {}));
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const err = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
        wallClockMs: 60_000,
        noProgressMs: 60_000,
        turnTimeoutMs: 50,
      });
    });
    expect(res?.exitCode).toBe(1);
    expect(res?.aborted).toBe("turn_timeout");
    expect(err).toContain("TURN TIMEOUT");
    expect(fake.promptCalls.length).toBe(1);
    expect(fake.abortCount()).toBe(1);
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

  it("an abort() that never settles ends the run as the turn timeout and says the workspace may still be changing", async () => {
    const fake = fakeSession(
      () => new Promise<void>(() => {}),
      () => new Promise<void>(() => {}),
    );
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const err = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
        wallClockMs: 60_000,
        noProgressMs: 60_000,
        turnTimeoutMs: 40,
      });
    });
    expect(res?.exitCode).toBe(1);
    expect(res?.aborted).toBe("turn_timeout");
    expect(fake.promptCalls.length).toBe(1);
    expect(err).toContain("the workspace may still be changing");
  }, 15_000);

  it("an abort() that rejects ends the run and says the workspace may still be changing", async () => {
    const fake = fakeSession(
      () => new Promise<void>(() => {}),
      () => Promise.reject(new Error("abort refused")),
    );
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const err = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
        wallClockMs: 60_000,
        noProgressMs: 60_000,
        turnTimeoutMs: 40,
      });
    });
    expect(res?.exitCode).toBe(1);
    expect(res?.aborted).toBe("turn_timeout");
    expect(fake.promptCalls.length).toBe(1);
    expect(fake.abortCount()).toBe(1);
    expect(err).toContain("the workspace may still be changing");
  }, 15_000);

  it("a session with no abort() ends the run, and a clean read is not reported as final", async () => {
    // Without abort() bob cannot confirm the session stopped. The work dir is a
    // clean git repository, so the read itself succeeds and finds nothing: the
    // report must still say the workspace may still be changing, never the
    // final "no dirty paths".
    const workDir = join(agentsRoot, "testbot", "work");
    expect(spawnSync("git", ["init", "-q"], { cwd: workDir }).status).toBe(0);
    const fake = fakeSession(() => new Promise<void>(() => {}), null);
    expect(fake.session.abort).toBeUndefined();
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const err = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
        wallClockMs: 60_000,
        noProgressMs: 60_000,
        turnTimeoutMs: 40,
      });
    });
    expect(res?.exitCode).toBe(1);
    expect(res?.aborted).toBe("turn_timeout");
    expect(fake.promptCalls.length).toBe(1);
    expect(err).toContain("the workspace may still be changing");
    expect(err).toContain("no uncommitted paths");
    expect(err).not.toContain("no dirty paths");
  }, 15_000);

  it("the wall clock firing during the abort grace starts no further prompt", async () => {
    // The turn times out at 40ms and ends the run. Its abort() resolves at
    // ~290ms, after the wall clock has fired (120ms) and inside the 1s grace.
    // No second prompt may start, and the first bound to fire is reported.
    const fake = fakeSession(
      () => new Promise<void>(() => {}),
      () => sleep(250),
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 120,
      noProgressMs: 60_000,
      turnTimeoutMs: 40,
    });
    expect(fake.promptCalls.length).toBe(1);
    expect(res.exitCode).toBe(1);
    expect(res.aborted).toBe("turn_timeout");
    expect(fake.abortCount()).toBe(1);
  }, 15_000);

  it("a compaction that ends after the turn timeout fired sends no note", async () => {
    // Known-present: a compaction during the live turn queues the "what remains"
    // note. Known-absent: the turn then times out, and a compaction that ends
    // while the abort is pending sends nothing more.
    const compactionEnd = { type: "compaction_end", reason: "threshold" };
    const fake = fakeSession(
      (emit) => {
        emit(compactionEnd);
        return new Promise<void>(() => {});
      },
      async (emit) => {
        emit(compactionEnd);
      },
    );
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const err = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
        wallClockMs: 60_000,
        noProgressMs: 60_000,
        turnTimeoutMs: 40,
      });
    });
    expect(fake.queued.length).toBe(1);
    expect(fake.queued[0]).toContain("[BOB WHAT REMAINS");
    expect(fake.promptCalls).toEqual(["hi"]);
    expect(res?.exitCode).toBe(1);
    expect(res?.aborted).toBe("turn_timeout");
    expect(fake.abortCount()).toBe(1);
    expect(err).toContain("the run was ended by its turn_timeout bound");
  }, 15_000);

  it("a compaction during a live turn queues the note with steer() and starts no other prompt", async () => {
    const fake = fakeSession(async (emit) => {
      emit({ type: "compaction_end", reason: "threshold" });
      emit(messageEnd("done"));
    });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 60_000,
      noProgressMs: 60_000,
      turnTimeoutMs: 60_000,
    });
    expect(fake.queued.length).toBe(1);
    expect(fake.queued[0]).toContain("[BOB WHAT REMAINS");
    expect(fake.promptCalls).toEqual(["hi"]);
    expect(res.exitCode).toBe(0);
  }, 15_000);

  it("an idle compaction starts no turn: the note is queued, never sent as a prompt", async () => {
    // pi's pre-prompt compaction runs inside prompt() BEFORE the agent run
    // starts, so the session is idle when compaction_end arrives. A steering
    // prompt() there would start a turn outside boundedPrompt; steer() queues.
    const fake = fakeSession(async (emit, _text, call, setStreaming) => {
      if (call > 1) return new Promise<void>(() => {}); // an unbounded turn
      setStreaming(false);
      emit({ type: "compaction_end", reason: "threshold" });
      setStreaming(true);
      emit(messageEnd("done"));
    });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      wallClockMs: 60_000,
      noProgressMs: 60_000,
      turnTimeoutMs: 60_000,
    });
    expect(fake.promptCalls).toEqual(["hi"]);
    expect(fake.queued.length).toBe(1);
    expect(fake.queued[0]).toContain("[BOB WHAT REMAINS");
    expect(res.exitCode).toBe(0);
  }, 15_000);

  it("reads the workspace status after the abort, so a write made before abort() resolves is reported", async () => {
    // abort() writes a file 100ms after it is called, then resolves (pi's
    // abort() resolves once the turn is idle). A status read taken before the
    // abort, or without waiting for it, sees a clean worktree.
    const workDir = join(agentsRoot, "testbot", "work");
    expect(spawnSync("git", ["init", "-q"], { cwd: workDir }).status).toBe(0);
    const fake = fakeSession(
      () => new Promise<void>(() => {}),
      async () => {
        await sleep(100);
        writeFileSync(join(workDir, "late.txt"), "written while the turn stopped\n");
      },
    );
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const err = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
        wallClockMs: 60_000,
        noProgressMs: 60_000,
        turnTimeoutMs: 40,
      });
    });
    expect(res?.exitCode).toBe(1);
    expect(res?.aborted).toBe("turn_timeout");
    expect(err).toContain("uncommitted paths in");
    expect(err).toContain("?? late.txt");
    expect(err).not.toContain("no dirty paths");
    expect(err).not.toContain("may still be changing");
  }, 15_000);

  it("a short run-level bound leaves no long turn timer: the child exits without waiting for it", () => {
    // The bound fires at 60ms while a 5s turn deadline is pending. With the
    // deadline cancelled by the run's abort, the child ends at bound + abort
    // grace (~1.1s). A turn timer that outlived the run would hold the child
    // until 5s. NO process.exit here: the child must end on its own.
    const script = join(agentsRoot, "linger-child.ts");
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
        "  turnTimeoutMs: 5000,",
        "});",
        'process.stderr.write("CHILD_RUN_CODE=" + res.exitCode + "\\n");',
      ].join("\n"),
    );
    const started = Date.now();
    const out = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 12_000 });
    const elapsed = Date.now() - started;
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("CHILD_RUN_CODE=1");
    expect(elapsed).toBeLessThan(3_000);
  }, 20_000);

  it("reports a workspace git cannot read as unavailable on the abort path, never as clean", async () => {
    // The agent's work dir here is not a git repository, so `git status` fails:
    // the status is unreadable, which is not the same as a clean worktree.
    const fake = fakeSession(() => new Promise<void>(() => {}));
    let res: Awaited<ReturnType<typeof runAgent>> | undefined;
    const err = await captureStderr(async () => {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
        wallClockMs: 60,
        noProgressMs: 60_000,
        turnTimeoutMs: 60_000,
      });
    });
    expect(res?.exitCode).toBe(1);
    expect(res?.aborted).toBe("wall_clock");
    expect(err).toContain("workspace status unavailable");
    expect(err).not.toContain("no dirty paths");
  }, 15_000);

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
