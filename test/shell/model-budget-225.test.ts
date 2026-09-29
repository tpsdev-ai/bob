// bob#225 (item 2) — repeated checkpoints after a compaction.
//
// The mid-run compaction check (installMidRunCompaction, bob#214) ends the
// low-level loop and queues a checkpoint when the context is over pi's
// compaction threshold. If a compaction SUCCEEDS but the context is still over
// the threshold, the next turn is over it again — unbounded, that is a
// checkpoint (and a compaction) on EVERY call.
//
// The bound chosen here is ONE CHECKPOINT PER THRESHOLD CROSSING: after a
// checkpoint, the next one waits until the context has dropped at or below the
// threshold. It is deterministic (no clock, no timing) and it is exactly the
// event pi's own threshold names — a crossing — so it re-arms only when the
// context genuinely drops below and is crossed again. A bounded backoff would
// still checkpoint forever on a context that never drops, and would add a clock
// to a check that has none. These tests drive the hook directly with a fake
// session, so "repeated over-threshold calls after a successful compaction" is
// exactly what they exercise.

import { describe, expect, it } from "bun:test";
import {
  installMidRunCompaction,
  type MidRunCompactionSession,
  type StopAfterTurnContext,
} from "../../src/shell/model-budget.js";

const WINDOW = 100_000;
const RESERVE = 50_000; // threshold = window - reserve = 50_000
const THRESHOLD = WINDOW - RESERVE;

function usage(tokens: number): NonNullable<StopAfterTurnContext["message"]["usage"]> {
  return { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens };
}

function over(tokens: number): StopAfterTurnContext {
  return { message: { stopReason: "toolUse", usage: usage(tokens) }, toolResults: [{}] };
}

function harness() {
  const steers: string[] = [];
  const logs: string[] = [];
  const listeners = new Set<(event: never) => void>();
  const session = {
    agent: {} as MidRunCompactionSession["agent"],
    settingsManager: {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: RESERVE,
        keepRecentTokens: 20_000,
      }),
    },
    model: { contextWindow: WINDOW },
    steer: async (text: string) => {
      steers.push(text);
    },
    subscribe: (listener: (event: never) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies MidRunCompactionSession;
  installMidRunCompaction(session, { log: (m) => logs.push(m) });
  return {
    session,
    steers,
    logs,
    // A turn that ended in tool calls, whose last response carried `tokens`.
    stop: async (tokens: number) => {
      const hook = session.agent.shouldStopAfterTurn;
      if (hook === undefined) throw new Error("installMidRunCompaction installed no hook");
      return await hook(over(tokens), undefined);
    },
    // pi finished a compaction this checkpoint asked for (true) or not (false).
    compactionEnd: (ok: boolean) => {
      for (const l of listeners)
        (l as (e: unknown) => void)({ type: "compaction_end", ...(ok ? { result: {} } : {}) });
    },
  };
}

describe("bob#225 item 2 — repeated checkpoints after a successful compaction are bounded", () => {
  it("checkpoints exactly once for a crossing, even when the successful compaction leaves the context over the threshold", async () => {
    const { steers, stop, compactionEnd } = harness();

    // Over the threshold → one checkpoint (queued so pi continues after its compaction).
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(1);

    // pi compacts, successfully — and the context is STILL over the threshold.
    compactionEnd(true);

    // Every following over-threshold call: NO further checkpoint.
    for (const tokens of [60_001, 61_000, 62_000, 70_000, 90_000]) {
      expect(await stop(tokens)).toBe(false);
    }
    expect(steers.length).toBe(1);

    // The context drops at or below the threshold → re-armed; a later crossing
    // checkpoints once more.
    expect(await stop(THRESHOLD)).toBe(false);
    expect(await stop(THRESHOLD + 1)).toBe(true);
    expect(steers.length).toBe(2);
  });

  it("logs the suppression once, so the run log explains why no further checkpoint happens", async () => {
    const { logs, stop, compactionEnd } = harness();
    await stop(60_000);
    compactionEnd(true);
    await stop(60_001);
    await stop(62_000);
    await stop(70_000);
    expect(logs.filter((m) => /not checkpointing again until it drops below/.test(m)).length).toBe(
      1,
    );
  });

  it("still checkpoints only at a crossing — at the threshold it does not (pi's own strict comparison)", async () => {
    const { steers, stop } = harness();
    expect(await stop(THRESHOLD)).toBe(false);
    expect(steers.length).toBe(0);
    expect(await stop(THRESHOLD + 1)).toBe(true);
    expect(steers.length).toBe(1);
  });

  it("a compaction that does NOT complete keeps checkpoints off until one succeeds (unchanged)", async () => {
    const { steers, stop, compactionEnd } = harness();
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(1);
    // The next turn arrives with no compaction_end: pi declined.
    expect(await stop(61_000)).toBe(false);
    // Even after the context drops and crosses again, a declined compaction stays off.
    expect(await stop(40_000)).toBe(false);
    expect(await stop(60_000)).toBe(false);
    expect(steers.length).toBe(1);
    // A compaction that DOES succeed clears it.
    compactionEnd(true);
    expect(await stop(60_000)).toBe(false); // this crossing already checkpointed
    expect(await stop(40_000)).toBe(false); // drop below → re-arm
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(2);
  });
});
