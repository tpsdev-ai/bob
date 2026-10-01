// bob#256 — a reasoning-only turn must not end the agent mid-task.
//
// Local reasoning models emit turns that carry only a thinking block: no text
// and no tool call. pi treats a turn with no tool call as the agent being
// finished, so the run ends mid-task. bob re-prompts the SAME session with a
// short continuation, BOUNDED, and reports the honest outcome.
//
// The stub model runtime never touches the network: `prompt()` emits a scripted
// sequence of session events and counts its calls. "Model calls" below means
// stub `prompt()` calls.
//
// The bound is the first thing proven: case (b) asserts a session that only
// ever ends reasoning-only stops after exactly the bound. The demonstrated stop
// for a BROKEN bound is the stub's `maxCalls` guard (it caps a runaway loop, so
// the suite terminates on an assertion instead of spinning); the explicit
// per-test timeout is a backstop behind that guard.
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
import {
  DEFAULT_MAX_REASONING_REPROMPTS,
  REASONING_CONTINUE_TURN,
} from "../../src/shell/compaction-contract.js";
import { startCronScheduler, type TimerHandle } from "../../src/shell/cron.js";
import {
  ReasoningOnlyExhaustedError,
  resolveMaxReprompts,
} from "../../src/shell/reasoning-retry.js";
import { type RunSession, type RunSessionFactory, runAgent } from "../../src/shell/run.js";
import { createTurnAdmission } from "../../src/shell/turn-admission.js";

/** A scripted emission: an assistant message, or a raw session event. */
type Emission = { message: { content: unknown; stopReason?: string } } | { event: unknown };

const REASONING_ONLY = (thinking = "thinking about the next step"): Emission => ({
  message: { content: [{ type: "thinking", thinking }], stopReason: "stop" },
});
const TEXT_FINAL = (text: string): Emission => ({
  message: { content: [{ type: "text", text }], stopReason: "stop" },
});
const TOOL_CALL: Emission = {
  message: {
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
    stopReason: "toolUse",
  },
};
const EMPTY: Emission = { message: { content: [], stopReason: "stop" } };
const WHITESPACE_ONLY: Emission = {
  message: { content: [{ type: "text", text: "   " }], stopReason: "stop" },
};
const FAILURE_ENDED: Emission = {
  message: { content: [{ type: "thinking", thinking: "partial" }], stopReason: "error" },
};
const COMPACTION: Emission = {
  event: { type: "compaction_end", reason: "threshold", aborted: false },
};

/**
 * A stub RunSession that emits the scripted emissions for each `prompt()` call
 * and counts its calls. `maxCalls` is the demonstrated stop for a broken bound:
 * it caps a runaway loop so the suite fails an assertion instead of spinning.
 */
function stubSession(
  script: (call: number) => Emission[],
  opts: { maxCalls?: number } = {},
): { session: RunSession; promptCalls: string[] } {
  const promptCalls: string[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const maxCalls = opts.maxCalls ?? 1000;
  const session: RunSession = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    async prompt(text: string, options?: unknown) {
      // A STEER (the best-effort compaction note) is not a turn: do not run the
      // script for it, and do not count it as a model call.
      const streaming = (options as { streamingBehavior?: string } | undefined)?.streamingBehavior;
      if (streaming !== undefined) return;
      promptCalls.push(text);
      if (promptCalls.length > maxCalls) return;
      for (const e of script(promptCalls.length)) {
        const event =
          "event" in e
            ? e.event
            : { type: "message_end", message: { role: "assistant", ...e.message } };
        for (const listener of listeners) listener(event);
      }
    },
    dispose() {},
  };
  return { session, promptCalls };
}

function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
}

/** The `outcome` record this run wrote to its run log, if any. */
function outcomeRecord(agentsRoot: string, agent: string): Record<string, unknown> | undefined {
  const runsDir = join(agentsRoot, agent, "runs");
  if (!existsSync(runsDir)) return undefined;
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const last = files[files.length - 1];
  if (!last) return undefined;
  for (const line of readFileSync(join(runsDir, last), "utf-8").split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as { outcome?: Record<string, unknown> };
    if (rec.outcome) return rec.outcome;
  }
  return undefined;
}

describe("reasoning-only turn (#256)", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-reasoning-"));
    const agentDir = join(agentsRoot, "testbot");
    mkdirSync(join(agentDir, "work"), { recursive: true });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
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

  it("b: a session that only ever ends reasoning-only stops at the bound (3 re-prompts → 4 prompt calls)", async () => {
    const stub = stubSession(() => [REASONING_ONLY()]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(DEFAULT_MAX_REASONING_REPROMPTS + 1);
    expect(stub.promptCalls.slice(1)).toEqual(
      Array(DEFAULT_MAX_REASONING_REPROMPTS).fill(REASONING_CONTINUE_TURN),
    );
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("reasoning_only");
    expect(res.failed).toBe(true);
  }, 10_000);

  it("a: continues THROUGH a reasoning-only turn to a tool call and a final text", async () => {
    const stub = stubSession((call) =>
      call === 1 ? [REASONING_ONLY()] : [TOOL_CALL, TEXT_FINAL("Final report: done.")],
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(2);
    expect(stub.promptCalls[1]).toBe(REASONING_CONTINUE_TURN);
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(res.stdout).toBe("Final report: done.");
  }, 10_000);

  it("c: a normal text-only final answer is not re-prompted", async () => {
    const stub = stubSession(() => [TEXT_FINAL("All done.")]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(1);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("All done.");
  }, 10_000);

  it("f1: a fifth-call text response is never sent; the fourth ending fails the run", async () => {
    // Every prompt up to the bound compacts AND ends reasoning-only; a FIFTH
    // call would return text. The run must stop at the bound with the failed
    // outcome and never send that fifth call.
    const stub = stubSession((call) =>
      call <= DEFAULT_MAX_REASONING_REPROMPTS + 1
        ? [COMPACTION, REASONING_ONLY()]
        : [TEXT_FINAL("late text")],
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    // Exactly the bound: the initial prompt + DEFAULT_MAX_REASONING_REPROMPTS
    // re-prompts, and NO compaction continue turn.
    expect(stub.promptCalls).toHaveLength(DEFAULT_MAX_REASONING_REPROMPTS + 1);
    expect(stub.promptCalls.filter((t) => t === REASONING_CONTINUE_TURN)).toHaveLength(
      DEFAULT_MAX_REASONING_REPROMPTS,
    );
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("reasoning_only");
    expect(outcomeRecord(agentsRoot, "testbot")).toEqual({
      reason: "reasoning_only",
      reprompts: DEFAULT_MAX_REASONING_REPROMPTS,
    });
  }, 10_000);

  it("an EMPTY message is not reasoning-only (no re-prompt; silence, not a failure of reasoning)", async () => {
    const stub = stubSession(() => [EMPTY]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(1);
    expect(res.reason).toBe("no_final_message");
  }, 10_000);

  it("a WHITESPACE-only message is not reasoning-only", async () => {
    const stub = stubSession(() => [WHITESPACE_ONLY]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(1);
    expect(res.reason).toBe("no_final_message");
  }, 10_000);

  it("a TOOL-CALL message is not reasoning-only", async () => {
    const stub = stubSession(() => [TOOL_CALL]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(1);
    expect(res.reason).toBe("no_final_message");
  }, 10_000);

  it("a FAILURE-ended message is not reasoning-only and fails the run", async () => {
    const stub = stubSession(() => [FAILURE_ENDED]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(1);
    expect(res.failed).toBe(true);
  }, 10_000);

  it("the outcome record carries NO model reasoning (a sentinel in the thinking is absent)", async () => {
    const sentinel = "SENTINEL_SECRET_do_not_log_7f3a";
    const stub = stubSession(() => [REASONING_ONLY(sentinel)]);
    await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    const rec = outcomeRecord(agentsRoot, "testbot");
    expect(rec).toBeDefined();
    expect(JSON.stringify(rec)).not.toContain(sentinel);
    expect(rec).toEqual({ reason: "reasoning_only", reprompts: DEFAULT_MAX_REASONING_REPROMPTS });
  }, 10_000);

  it("resolveMaxReprompts rejects a non-integer or non-positive budget and caps at the ceiling", () => {
    expect(resolveMaxReprompts(undefined)).toBe(DEFAULT_MAX_REASONING_REPROMPTS);
    expect(resolveMaxReprompts(1)).toBe(1);
    expect(resolveMaxReprompts(99)).toBe(DEFAULT_MAX_REASONING_REPROMPTS);
    expect(() => resolveMaxReprompts(Number.POSITIVE_INFINITY)).toThrow(/invalid maxReprompts/);
    expect(() => resolveMaxReprompts(Number.NaN)).toThrow(/invalid maxReprompts/);
    expect(() => resolveMaxReprompts(0)).toThrow(/invalid maxReprompts/);
    expect(() => resolveMaxReprompts(-1)).toThrow(/invalid maxReprompts/);
    // Fractions on BOTH sides of one (0.5 floored to 0 / 1.5 floored to 1 would
    // both violate the positive-integer contract).
    expect(() => resolveMaxReprompts(0.5)).toThrow(/invalid maxReprompts/);
    expect(() => resolveMaxReprompts(1.5)).toThrow(/invalid maxReprompts/);
  }, 10_000);

  it("an exhausted admitted turn REJECTS with a failure the callers can handle", async () => {
    const stub = stubSession(() => [REASONING_ONLY()]);
    const admission = createTurnAdmission({ log: () => {} });
    admission.bind(stub.session);
    await expect(
      admission.admitTurn({ kind: "cron", job: "nightly" }, "do the thing"),
    ).rejects.toBeInstanceOf(ReasoningOnlyExhaustedError);
    expect(stub.promptCalls).toHaveLength(DEFAULT_MAX_REASONING_REPROMPTS + 1);
    admission.close();
  }, 10_000);

  it("an exhausted CRON fire is reported as a failure, not a successful fire", async () => {
    const stub = stubSession(() => [REASONING_ONLY()]);
    const logs: string[] = [];
    const admission = createTurnAdmission({ log: (m) => logs.push(m) });
    admission.bind(stub.session);
    const timers: Array<() => void> = [];
    const scheduler = startCronScheduler({
      entries: [{ name: "nightly", schedule: "* * * * *", prompt: "do it" }],
      fire: (entry) =>
        admission.admitTurn({ kind: "cron", job: entry.name }, entry.prompt ?? "do it"),
      log: (m) => logs.push(m),
      setTimer: (cb: () => void): TimerHandle => {
        timers.push(cb);
        return 0 as unknown as TimerHandle;
      },
      clearTimer: () => {},
    });
    timers.splice(0).forEach((cb) => {
      cb();
    });
    await new Promise((r) => setTimeout(r, 30));
    scheduler.stop();
    admission.close();
    expect(stub.promptCalls).toHaveLength(DEFAULT_MAX_REASONING_REPROMPTS + 1);
    expect(logs.some((l) => l.includes("fire error"))).toBe(true);
    expect(logs.some((l) => l.includes("reasoning only"))).toBe(true);
  }, 10_000);
});
