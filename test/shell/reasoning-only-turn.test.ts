// bob#256 — a reasoning-only turn must not end the agent mid-task.
//
// Local reasoning models emit turns that carry only a thinking block: no text
// and no tool call. pi treats a turn with no tool call as the agent being
// finished, so the run ends mid-task. bob re-prompts the SAME session with a
// short continuation, BOUNDED by a constant, and reports the honest outcome.
//
// The stub model runtime here never touches the network: `prompt()` emits a
// scripted sequence of assistant `message_end` events and counts its calls.
//
// The bound is the first thing proven: case (b) asserts a session that only
// ever ends reasoning-only stops after exactly the bound (3 re-prompts → 4
// model calls). Every case carries an explicit per-test timeout so a broken
// bound fails the suite instead of running forever (the failure that lost the
// first attempt at this fix).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_REASONING_REPROMPTS,
  REASONING_CONTINUE_TURN,
} from "../../src/shell/compaction-contract.js";
import { type RunSession, type RunSessionFactory, runAgent } from "../../src/shell/run.js";
import { createTurnAdmission } from "../../src/shell/turn-admission.js";

/** One scripted assistant message: its content blocks and stopReason. */
interface ScriptedMessage {
  content: unknown;
  stopReason?: string;
}

/** A reasoning-only ending: a thinking block, no text, no tool call. */
const REASONING_ONLY: ScriptedMessage = {
  content: [
    {
      type: "thinking",
      thinking: "So the … describe block has tests and the tests I modified … are inside it",
    },
  ],
  stopReason: "stop",
};

const TEXT_FINAL = (text: string): ScriptedMessage => ({
  content: [{ type: "text", text }],
  stopReason: "stop",
});

const TOOL_CALL: ScriptedMessage = {
  content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
  stopReason: "toolUse",
};

/**
 * A stub RunSession that emits the scripted messages for each `prompt()` call
 * and counts its calls. `maxCalls` is a safety stop: a broken bound must fail an
 * assertion, not spin the whole suite (and its run log) forever.
 */
function stubSession(
  script: (call: number) => ScriptedMessage[],
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
    async prompt(text: string) {
      promptCalls.push(text);
      if (promptCalls.length > maxCalls) return;
      for (const m of script(promptCalls.length)) {
        for (const listener of listeners) {
          listener({
            type: "message_end",
            message: { role: "assistant", content: m.content, stopReason: m.stopReason ?? "stop" },
          });
        }
      }
    },
    dispose() {},
  };
  return { session, promptCalls };
}

function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
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

  it("b: a session that only ever ends reasoning-only stops at the bound (3 re-prompts → 4 model calls)", async () => {
    const stub = stubSession(() => [REASONING_ONLY]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    // Exactly the bound: the initial prompt plus DEFAULT_MAX_REASONING_REPROMPTS
    // continuations, and no more.
    expect(stub.promptCalls).toHaveLength(DEFAULT_MAX_REASONING_REPROMPTS + 1);
    expect(stub.promptCalls.slice(1)).toEqual(
      Array(DEFAULT_MAX_REASONING_REPROMPTS).fill(REASONING_CONTINUE_TURN),
    );
    // The honest outcome: a failure, reason reasoning_only, never exit 0.
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("reasoning_only");
    expect(res.failed).toBe(true);
  }, 10_000);

  it("a: continues THROUGH a reasoning-only turn to a tool call and a final text", async () => {
    const stub = stubSession((call) =>
      call === 1 ? [REASONING_ONLY] : [TOOL_CALL, TEXT_FINAL("Final report: done.")],
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    // One re-prompt carried the run past the reasoning-only turn.
    expect(stub.promptCalls).toHaveLength(2);
    expect(stub.promptCalls[1]).toBe(REASONING_CONTINUE_TURN);
    // It completed normally: exit 0 with the final text.
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

  it("d: an admitted runtime turn (cron / Discord inbound) is re-prompted through reasoning-only turns, bounded", async () => {
    const stub = stubSession(() => [REASONING_ONLY]);
    const admission = createTurnAdmission({ log: () => {} });
    admission.bind(stub.session);
    await admission.admitTurn({ kind: "cron", job: "nightly" }, "do the thing");
    expect(stub.promptCalls).toHaveLength(DEFAULT_MAX_REASONING_REPROMPTS + 1);
    expect(stub.promptCalls.slice(1)).toEqual(
      Array(DEFAULT_MAX_REASONING_REPROMPTS).fill(REASONING_CONTINUE_TURN),
    );
    admission.close();
  }, 10_000);
});
