// bob#225 (item 2) — repeated checkpoints after a compaction.
//
// The mid-run compaction check (installMidRunCompaction, bob#214) ends the
// low-level loop and queues a checkpoint when a turn that ended in tool calls
// reports usage over pi's compaction threshold. If a compaction SUCCEEDS but
// the context is still over the threshold, the next such tool turn is over it
// again; without a bound, each of those turns would queue another checkpoint
// (and pi would compact again after each one).
//
// The rule tested here: after a checkpoint, the check does not checkpoint again
// for the same threshold until it sees the context at or below it: a tool turn
// whose reported usage is at or below the threshold, or a successful compaction
// whose `estimatedTokensAfter` is at or below it. A successful compaction with
// no usable estimate, or an estimate above the threshold, keeps the check
// suppressed. These tests drive the hook directly with a fake session and fake
// compaction_end events; they do not run pi's compaction.

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
    // A successful result carries `estimatedTokensAfter` (pi's estimate of the
    // compacted context) when one is passed, and no estimate otherwise.
    compactionEnd: (ok: boolean, estimatedTokensAfter?: unknown) => {
      const result = estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter };
      for (const l of listeners)
        (l as (e: unknown) => void)({ type: "compaction_end", ...(ok ? { result } : {}) });
    },
  };
}

describe("bob#225 item 2 — repeated checkpoints after a successful compaction are bounded", () => {
  it("after a checkpoint and a successful compaction with no estimate, over-threshold tool turns do not checkpoint again until one is at or below the threshold", async () => {
    const { steers, stop, compactionEnd } = harness();

    // Over the threshold → one checkpoint (queued so pi continues after its compaction).
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(1);

    // pi compacts, successfully, and reports no estimate of the result; the
    // following tool turns are still over the threshold.
    compactionEnd(true);

    // Each of these over-threshold tool turns: NO further checkpoint.
    for (const tokens of [60_001, 61_000, 62_000, 70_000, 90_000]) {
      expect(await stop(tokens)).toBe(false);
    }
    expect(steers.length).toBe(1);

    // A tool turn at or below the threshold re-arms the check; the next tool
    // turn over it checkpoints again.
    expect(await stop(THRESHOLD)).toBe(false);
    expect(await stop(THRESHOLD + 1)).toBe(true);
    expect(steers.length).toBe(2);
  });

  it("logs the suppression once across repeated over-threshold tool turns", async () => {
    const { logs, stop, compactionEnd } = harness();
    await stop(60_000);
    compactionEnd(true);
    await stop(60_001);
    await stop(62_000);
    await stop(70_000);
    expect(logs.filter((m) => /not checkpointing again until/.test(m)).length).toBe(1);
  });

  it("does not checkpoint at the threshold, only over it (pi's shouldCompact is a strict comparison)", async () => {
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
    expect(await stop(60_000)).toBe(false); // already checkpointed for this threshold; no estimate
    expect(await stop(40_000)).toBe(false); // a tool turn at or below → re-arm
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(2);
  });

  it("a successful compaction estimated at or below the threshold re-arms the check: the next over-threshold tool turn checkpoints", async () => {
    const { steers, stop, compactionEnd } = harness();
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(1);

    // pi's estimate of the compacted context is BELOW the threshold.
    compactionEnd(true, 40_000);
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(2);

    // An estimate exactly AT the threshold re-arms too (at or below).
    compactionEnd(true, THRESHOLD);
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(3);
  });

  it("a successful compaction estimated above the threshold keeps the check suppressed: the next over-threshold tool turn does not checkpoint", async () => {
    const { steers, logs, stop, compactionEnd } = harness();
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(1);

    compactionEnd(true, THRESHOLD + 1);
    expect(await stop(60_000)).toBe(false);
    expect(await stop(70_000)).toBe(false);
    expect(steers.length).toBe(1);
    expect(logs.filter((m) => /not checkpointing again until/.test(m)).length).toBe(1);
  });

  it("a successful compaction whose estimate is not a usable number keeps the check suppressed", async () => {
    for (const estimate of [Number.NaN, Number.POSITIVE_INFINITY, -1, "40000", null]) {
      const { steers, stop, compactionEnd } = harness();
      expect(await stop(60_000)).toBe(true);
      compactionEnd(true, estimate);
      expect(await stop(60_000), `estimate ${String(estimate)}`).toBe(false);
      expect(steers.length).toBe(1);
    }
  });
});
