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
// for the same threshold until it re-arms, and only a VALID reading (a finite
// token count above zero) at or below the threshold re-arms it: a tool turn's
// usage, or a successful compaction's `estimatedTokensAfter`. A tool turn with
// invalid usage (all-zero, non-finite, negative) neither re-arms nor
// checkpoints. A successful compaction with no valid estimate, or an estimate
// above the threshold, keeps the check suppressed. These tests drive the hook
// directly with a fake session and SYNTHETIC compaction_end events; they do not
// run pi's compaction.

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

type Usage = NonNullable<StopAfterTurnContext["message"]["usage"]>;

function toolTurn(u: Usage): StopAfterTurnContext {
  return { message: { stopReason: "toolUse", usage: u }, toolResults: [{}] };
}

// Usage pi's compaction code treats as carrying no valid data (all-zero), and
// usage whose context size is not a finite count above zero.
const INVALID_USAGE: ReadonlyArray<[string, Usage]> = [
  ["all-zero", usage(0)],
  ["NaN", { input: Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: Number.NaN }],
  [
    "Infinity",
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: Number.POSITIVE_INFINITY },
  ],
  ["negative", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: -5 }],
];

function harness() {
  const steers: string[] = [];
  // The compaction reserve pi's settings report, changeable mid-test (a live
  // threshold change: threshold = window - reserve).
  let reserveTokens = RESERVE;
  const logs: string[] = [];
  const listeners = new Set<(event: never) => void>();
  const session = {
    agent: {} as MidRunCompactionSession["agent"],
    settingsManager: {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens,
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
  const turn = async (u: Usage) => {
    const hook = session.agent.shouldStopAfterTurn;
    if (hook === undefined) throw new Error("installMidRunCompaction installed no hook");
    return await hook(toolTurn(u), undefined);
  };
  return {
    session,
    steers,
    logs,
    // A turn that ended in tool calls, whose last response carried `tokens`.
    stop: async (tokens: number) => await turn(usage(tokens)),
    // A turn that ended in tool calls, whose last response carried usage `u`.
    turn,
    setReserve: (tokens: number) => {
      reserveTokens = tokens;
    },
    // A SYNTHETIC compaction_end: success (true) or failure (false). pi's own
    // success path always supplies `estimatedTokensAfter`; a success built here
    // WITHOUT one exercises the missing-estimate handling, not current pi.
    compactionEnd: (ok: boolean, estimatedTokensAfter?: unknown) => {
      const result = estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter };
      for (const l of listeners)
        (l as (e: unknown) => void)({ type: "compaction_end", ...(ok ? { result } : {}) });
    },
  };
}

describe("bob#225 item 2 — repeated checkpoints after a successful compaction are bounded", () => {
  it("after a checkpoint and a synthetic successful compaction with no estimate, over-threshold tool turns do not checkpoint again until one is at or below the threshold", async () => {
    const { steers, stop, compactionEnd } = harness();

    // Over the threshold → one checkpoint (queued so pi continues after its compaction).
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(1);

    // A synthetic successful compaction_end with no estimate (pi's success path
    // supplies one; this covers a result without it); the following tool turns
    // are still over the threshold.
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
    expect(
      logs.filter((m) => /not checkpointing again for this threshold until/.test(m)).length,
    ).toBe(1);
  });

  it("does not checkpoint at the threshold, only over it (pi's shouldCompact is a strict comparison)", async () => {
    const { steers, stop } = harness();
    expect(await stop(THRESHOLD)).toBe(false);
    expect(steers.length).toBe(0);
    expect(await stop(THRESHOLD + 1)).toBe(true);
    expect(steers.length).toBe(1);
  });

  it("a compaction that does NOT complete keeps checkpoints off (unchanged); a success ends that failed-compaction state while the latch may still suppress checkpoints", async () => {
    const { steers, stop, compactionEnd } = harness();
    expect(await stop(60_000)).toBe(true);
    expect(steers.length).toBe(1);
    // The next turn arrives with no compaction_end: pi declined.
    expect(await stop(61_000)).toBe(false);
    // Even after the context drops and crosses again, a declined compaction stays off.
    expect(await stop(40_000)).toBe(false);
    expect(await stop(60_000)).toBe(false);
    expect(steers.length).toBe(1);
    // A synthetic successful compaction (no estimate) ends the suppressed
    // state; the checkpoint already fired for this threshold still holds.
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
    expect(
      logs.filter((m) => /not checkpointing again for this threshold until/.test(m)).length,
    ).toBe(1);
  });

  it("a successful compaction whose estimate is not a valid token count keeps the check suppressed", async () => {
    for (const estimate of [Number.NaN, Number.POSITIVE_INFINITY, -1, "40000", null]) {
      const { steers, stop, compactionEnd } = harness();
      expect(await stop(60_000)).toBe(true);
      compactionEnd(true, estimate);
      expect(await stop(60_000), `estimate ${String(estimate)}`).toBe(false);
      expect(steers.length).toBe(1);
    }
  });

  it("a checkpoint at a changed threshold starts a new cycle: its later suppression is logged too", async () => {
    const { steers, logs, stop, compactionEnd, setReserve } = harness();
    const suppressionLogs = () =>
      logs.filter((m) => /not checkpointing again for this threshold until/.test(m));

    // Cycle 1, threshold 50_000: a checkpoint, a compaction estimated above the
    // threshold, then repeated over-threshold turns: one suppression log.
    expect(await stop(60_000)).toBe(true);
    compactionEnd(true, THRESHOLD + 1);
    expect(await stop(60_000)).toBe(false);
    expect(await stop(61_000)).toBe(false);
    expect(suppressionLogs().length).toBe(1);

    // The threshold changes live (reserve 40_000: threshold 60_000). A tool turn
    // over the NEW threshold checkpoints without the old one re-arming.
    setReserve(40_000);
    expect(await stop(70_000)).toBe(true);
    expect(steers.length).toBe(2);

    // Cycle 2: a compaction estimated above the new threshold, then repeated
    // over-threshold turns: this cycle's suppression is logged as well.
    compactionEnd(true, 60_001);
    expect(await stop(70_000)).toBe(false);
    expect(await stop(71_000)).toBe(false);
    expect(steers.length).toBe(2);
    expect(suppressionLogs().length).toBe(2);
    expect(suppressionLogs()[1]).toContain("(60000 of 100000)");
  });

  for (const [label, invalid] of INVALID_USAGE) {
    it(`invalid (${label}) tool-turn usage after a compaction estimated above the threshold does not re-arm the check`, async () => {
      const { steers, stop, turn, compactionEnd } = harness();
      expect(await stop(60_000)).toBe(true);
      compactionEnd(true, THRESHOLD + 1);

      // Invalid usage between the compaction and the next over-threshold turn.
      expect(await turn(invalid)).toBe(false);
      expect(await stop(60_000)).toBe(false);
      expect(steers.length).toBe(1);

      // Control: VALID usage at or below the threshold does re-arm it.
      expect(await stop(40_000)).toBe(false);
      expect(await stop(60_000)).toBe(true);
      expect(steers.length).toBe(2);
    });

    it(`invalid (${label}) tool-turn usage never checkpoints, even when the check is armed`, async () => {
      const { steers, stop, turn } = harness();
      expect(await turn(invalid)).toBe(false);
      expect(steers.length).toBe(0);
      // The check is still armed: a valid over-threshold turn checkpoints.
      expect(await stop(60_000)).toBe(true);
      expect(steers.length).toBe(1);
    });
  }
});
