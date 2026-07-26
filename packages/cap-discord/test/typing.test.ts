import { describe, expect, it } from "bun:test";
import { createTypingHeartbeat, TYPING_INTERVAL_MS, TYPING_MAX_MS } from "../src/typing.js";

// The heartbeat primitive on its own, driven with REAL timers at a few ms (the
// same shape as the existing connectTimeoutMs tests — no clock faking).

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class TypingStub {
  readonly calls: string[] = [];
  mode: "ok" | "reject" | "throw" = "ok";
  async sendTyping(channelId: string): Promise<void> {
    this.calls.push(channelId);
    if (this.mode === "reject") throw new Error("429 rate limited");
  }
}

// A stub whose sendTyping throws SYNCHRONOUSLY (before returning a promise) —
// a `.catch()` alone would not contain this.
class SyncThrowStub {
  readonly calls: string[] = [];
  sendTyping(channelId: string): Promise<void> {
    this.calls.push(channelId);
    throw new Error("sync explosion");
  }
}

describe("typing heartbeat — cadence", () => {
  it("defaults sit inside Discord's ~10s indicator expiry", () => {
    // The whole reason this is a heartbeat: one call only shows for ~10s.
    expect(TYPING_INTERVAL_MS).toBeLessThan(10_000);
    expect(TYPING_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
    expect(TYPING_MAX_MS).toBeGreaterThan(TYPING_INTERVAL_MS);
  });

  it("pulses immediately on start", () => {
    const client = new TypingStub();
    const hb = createTypingHeartbeat({ client, intervalMs: 10 });
    hb.start("chan-1");
    expect(client.calls).toEqual(["chan-1"]);
    hb.stop();
  });

  it("keeps pulsing on the interval until stopped", async () => {
    const client = new TypingStub();
    const hb = createTypingHeartbeat({ client, intervalMs: 10 });
    hb.start("chan-1");
    await sleep(60);
    expect(client.calls.length).toBeGreaterThanOrEqual(3);
    hb.stop();
  });

  it("stop() halts the pulses", async () => {
    const client = new TypingStub();
    const hb = createTypingHeartbeat({ client, intervalMs: 10 });
    hb.start("chan-1");
    await sleep(35);
    hb.stop();
    const atStop = client.calls.length;
    await sleep(60);
    expect(client.calls.length).toBe(atStop);
  });

  it("stop() is idempotent and safe when nothing is running", () => {
    const client = new TypingStub();
    const hb = createTypingHeartbeat({ client, intervalMs: 10 });
    expect(() => {
      hb.stop();
      hb.stop();
    }).not.toThrow();
    hb.start("chan-1");
    expect(() => {
      hb.stop();
      hb.stop();
    }).not.toThrow();
    expect(client.calls).toEqual(["chan-1"]);
  });

  it("start() on a live heartbeat re-points it rather than stacking a timer", async () => {
    const client = new TypingStub();
    const hb = createTypingHeartbeat({ client, intervalMs: 10 });
    hb.start("chan-1");
    hb.start("chan-2");
    await sleep(45);
    hb.stop();
    // Only chan-2 pulses after the re-point; chan-1 got exactly its immediate one.
    expect(client.calls.filter((c) => c === "chan-1")).toEqual(["chan-1"]);
    expect(client.calls.filter((c) => c === "chan-2").length).toBeGreaterThanOrEqual(2);
  });
});

describe("typing heartbeat — failures are swallowed", () => {
  it("a rejecting sendTyping does not throw out of start()", async () => {
    const client = new TypingStub();
    client.mode = "reject";
    const logs: string[] = [];
    const hb = createTypingHeartbeat({ client, intervalMs: 10, log: (m) => logs.push(m) });
    expect(() => hb.start("chan-1")).not.toThrow();
    await sleep(35);
    hb.stop();
    // It kept trying (a transient 429 shouldn't kill the indicator for the turn)
    // and every failure was logged, not raised.
    expect(client.calls.length).toBeGreaterThanOrEqual(2);
    expect(logs.every((l) => /typing indicator failed for chan-1/.test(l))).toBe(true);
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });

  it("a SYNCHRONOUSLY throwing client is contained too", async () => {
    const client = new SyncThrowStub();
    const logs: string[] = [];
    const hb = createTypingHeartbeat({ client, intervalMs: 10, log: (m) => logs.push(m) });
    expect(() => hb.start("chan-1")).not.toThrow();
    await sleep(35);
    hb.stop();
    expect(logs.some((l) => /sync explosion/.test(l))).toBe(true);
  });

  it("logging is optional — no log seam still swallows", async () => {
    const client = new TypingStub();
    client.mode = "reject";
    const hb = createTypingHeartbeat({ client, intervalMs: 10 });
    expect(() => hb.start("chan-1")).not.toThrow();
    await sleep(25);
    hb.stop();
    expect(client.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("typing heartbeat — self-bounded", () => {
  it("stops itself at the ceiling even if nobody ever calls stop()", async () => {
    const client = new TypingStub();
    const logs: string[] = [];
    // Ceiling of 30ms with a 10ms cadence: it must give up ~3 pulses in and stay
    // quiet, rather than typing forever because agent_end never fired.
    const hb = createTypingHeartbeat({
      client,
      intervalMs: 10,
      maxMs: 30,
      log: (m) => logs.push(m),
    });
    hb.start("chan-1");
    await sleep(120);
    const settled = client.calls.length;
    expect(settled).toBeLessThanOrEqual(6);
    await sleep(60);
    expect(client.calls.length).toBe(settled); // genuinely stopped, not just slow
    expect(logs.some((l) => /ceiling/.test(l))).toBe(true);
  });

  it("the ceiling resets on each start (a new turn gets a full window)", async () => {
    const client = new TypingStub();
    const hb = createTypingHeartbeat({ client, intervalMs: 10, maxMs: 30 });
    hb.start("chan-1");
    await sleep(120); // ceiling reached, heartbeat dead
    const afterFirst = client.calls.length;
    hb.start("chan-1"); // next turn
    await sleep(45);
    hb.stop();
    expect(client.calls.length).toBeGreaterThan(afterFirst + 1);
  });
});
