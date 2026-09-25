import { describe, expect, it } from "bun:test";
import type { PresenceCapabilityConfig } from "../../../src/capabilities/presence/config.js";
import {
  type BeaconScheduler,
  type BuildTurnSummaryArgs,
  buildTurnSummary,
  type PresenceFlairClient,
  type PresenceHandle,
  type PresenceMessage,
  type PresencePiLike,
  SUMMARY_MAX_RETRIES,
  wirePresence,
} from "../../../src/capabilities/presence/index.js";
import { tagPrompt } from "../../../src/shell/turn-origin.js";

// ── Fakes (no live Flair, no real key, no network, fake clock) ──────────────

// A fake FlairHttpClient that records presenceBeat + write calls and can fail or
// hold (defer resolution) beats so the in-flight-cap path is deterministic.
class FakePresenceClient implements PresenceFlairClient {
  beats: Array<{ activity?: string; currentTask?: string | null | undefined }> = [];
  writes: Array<{ content: string; opts?: { durability?: string } }> = [];
  beatReject = "flair 500: beat boom";
  writeReject = "flair 500: write boom";
  failBeats = false;
  failWrites = false;
  holdBeats = false;
  private pendingResolvers: Array<() => void> = [];

  async presenceBeat(opts: {
    activity?: "coding" | "reviewing" | "planning" | "debugging" | "idle";
    currentTask?: string | null | undefined;
  }): Promise<void> {
    this.beats.push({ activity: opts.activity, currentTask: opts.currentTask });
    if (this.failBeats) throw new Error(this.beatReject);
    if (this.holdBeats) {
      // Hold the promise so beatInFlight stays true until the test releases it.
      return new Promise<void>((resolve) => this.pendingResolvers.push(resolve));
    }
    return;
  }

  releaseHeldBeats(): void {
    for (const r of this.pendingResolvers) r();
    this.pendingResolvers = [];
  }

  async write(
    content: string,
    opts?: { durability?: string; supersedes?: string },
  ): Promise<{ id: string }> {
    this.writes.push({ content, opts });
    if (this.failWrites) throw new Error(this.writeReject);
    return { id: `pulse-${this.writes.length}` };
  }
}

// A fake pi that records the four presence subscriptions and lets a test fire
// each event on demand. Handlers are stored keyed by event name.
class FakePresencePi implements PresencePiLike {
  private handlers: Record<string, (e: unknown) => void | Promise<void>> = {};

  on(
    event: "before_agent_start" | "agent_start" | "agent_settled" | "agent_end",
    handler: (e: unknown) => void | Promise<void>,
  ): void {
    this.handlers[event] = handler;
  }

  fireBeforeAgentStart(prompt: string): void {
    this.handlers.before_agent_start?.({ prompt });
  }
  fireAgentStart(): void {
    this.handlers.agent_start?.({});
  }
  fireAgentSettled(): void {
    this.handlers.agent_settled?.({});
  }
  fireAgentEnd(messages: PresenceMessage[]): void {
    this.handlers.agent_end?.({ messages });
  }
}

// A fake beacon scheduler: does NOT auto-start a timer (unlike the production
// default). It captures the fire fn so a test can tick the beacon manually.
function makeFakeScheduler() {
  let fire: (() => void) | undefined;
  let stopped = false;
  const scheduler: BeaconScheduler = (_intervalMs, f) => {
    fire = f;
    return {
      tick(): void {
        fire?.();
      },
      stop(): void {
        stopped = true;
        fire = undefined; // stop() halts the interval (models clearInterval)
      },
    };
  };
  return {
    scheduler,
    tick: () => fire?.(),
    get stopped() {
      return stopped;
    },
  };
}

// Let all pending microtasks + a macrotask drain, so fire-and-forget work in the
// capability (beat promises, the summary IIFE, the write retries) has settled.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// A default test config. Summary is enabled; cadence is fast for the beacon.
function baseConfig(overrides: Partial<PresenceCapabilityConfig> = {}): PresenceCapabilityConfig {
  return {
    url: "http://127.0.0.1:9926",
    agentId: "pulse",
    keyFile: "/unused",
    ...overrides,
    summary: {
      enabled: true,
      durability: "standard",
      maxChars: 2048,
      ...overrides.summary,
    },
  } as PresenceCapabilityConfig;
}

// ── 1. Beats: busy / idle / beacon-liveness ─────────────────────────────────

describe("wirePresence — beats", () => {
  it("busy beat on agent_start carries busyActivity + the origin label", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler } = makeFakeScheduler();
    const cfg = baseConfig({ busyActivity: "coding" });
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 1_700_000_000_000,
      scheduleBeacon: scheduler,
    });

    // A mail-tagged prompt drives the origin.
    pi.fireBeforeAgentStart(tagPrompt("please do the thing", { kind: "mail", from: "flint" }));
    pi.fireAgentStart();
    await settle();

    expect(flair.beats).toHaveLength(1);
    expect(flair.beats[0]).toEqual({ activity: "coding", currentTask: "mail from flint" });
  });

  it("honors a custom busyActivity (e.g. 'debugging')", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler } = makeFakeScheduler();
    const cfg = baseConfig({ busyActivity: "debugging" });
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 1,
      scheduleBeacon: scheduler,
    });
    pi.fireBeforeAgentStart("an untagged run");
    pi.fireAgentStart();
    await settle();
    expect(flair.beats[0]).toEqual({ activity: "debugging", currentTask: "run" });
  });

  it("idle beat on agent_settled carries activity:'idle' and no currentTask", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler } = makeFakeScheduler();
    const cfg = baseConfig();
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 1,
      scheduleBeacon: scheduler,
    });
    pi.fireAgentSettled();
    await settle();
    // currentTask:null is omitted by the client, so the recorded beat has
    // activity:'idle' and no currentTask key (or a null/undefined currentTask).
    expect(flair.beats[0].activity).toBe("idle");
    expect(flair.beats[0].currentTask).toBe(null);
  });

  // THE load-bearing beacon assertion: a beacon tick posts a beat with NO
  // activity and NO currentTask (an empty body), so the server preserves the
  // prior activity stamp — the beacon can never erase a busy stamp.
  it("beacon tick posts a liveness-only beat (empty opts: no activity/currentTask)", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler, tick } = makeFakeScheduler();
    const cfg = baseConfig({ beaconIntervalMs: 60_000 });
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 1,
      scheduleBeacon: scheduler,
    });

    // First a busy beat lands so the roster reads "busy".
    pi.fireBeforeAgentStart(tagPrompt("x", { kind: "mail", from: "flint" }));
    pi.fireAgentStart();
    await settle();
    expect(flair.beats[0]).toEqual({ activity: "coding", currentTask: "mail from flint" });

    // Now fire the beacon. It must NOT carry activity/currentTask.
    tick();
    await settle();
    expect(flair.beats).toHaveLength(2);
    const beaconBeat = flair.beats[1];
    expect(beaconBeat.activity).toBeUndefined();
    expect(beaconBeat.currentTask).toBeUndefined();
    expect(beaconBeat).toEqual({});
  });

  it("stop() halts the beacon (no further ticks)", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler, tick } = makeFakeScheduler();
    const cfg = baseConfig();
    const handle: PresenceHandle = wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 1,
      scheduleBeacon: scheduler,
    });
    tick();
    await settle();
    expect(flair.beats).toHaveLength(1);
    handle.stop();
    tick();
    await settle();
    expect(flair.beats).toHaveLength(1);
  });
});

// ── 2. Resilience: no throw into pi, in-flight cap, collapsed failures ──────

describe("wirePresence — resilience", () => {
  it("NEVER throws into pi when every beat rejects; one collapsed log line", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    flair.failBeats = true; // every beat rejects with the same message
    const { scheduler } = makeFakeScheduler();
    const logs: string[] = [];
    const cfg = baseConfig();
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: (m) => logs.push(m),
      now: () => 1,
      scheduleBeacon: scheduler,
    });

    // Fire 5 busy beats, each allowed to settle (so the cap releases between
    // them and the repeated identical failure collapses to one log line).
    let threw = false;
    for (let i = 0; i < 5; i++) {
      try {
        pi.fireBeforeAgentStart(tagPrompt("x", { kind: "mail", from: "flint" }));
        pi.fireAgentStart();
      } catch {
        threw = true;
      }
      await settle();
    }
    expect(threw).toBe(false);
    expect(flair.beats).toHaveLength(5); // all 5 got through (cap released between them)
    expect(logs.filter((l) => l.includes("heartbeat failed"))).toHaveLength(1);
  });

  it("enforces one in-flight beat at a time (drops the burst)", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    flair.holdBeats = true; // the first beat's promise stays pending
    const { scheduler, tick } = makeFakeScheduler();
    const cfg = baseConfig({ beaconIntervalMs: 60_000 });
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 1,
      scheduleBeacon: scheduler,
    });

    // Fire one busy beat (held), then a burst of beacon ticks. Only the
    // first presenceBeat is in flight; the rest are dropped by the cap.
    pi.fireAgentStart();
    for (let i = 0; i < 4; i++) tick();
    await settle();
    expect(flair.beats).toHaveLength(1); // the rest were dropped

    // Release the held beat; the cap frees and the next beat gets through.
    flair.releaseHeldBeats();
    await settle();
    tick();
    await settle();
    expect(flair.beats).toHaveLength(2);
  });

  it("a NEW distinct failure logs again after a recovery", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler } = makeFakeScheduler();
    const logs: string[] = [];
    const cfg = baseConfig();
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: (m) => logs.push(m),
      now: () => 1,
      scheduleBeacon: scheduler,
    });

    // First failure logs.
    flair.failBeats = true;
    pi.fireAgentStart();
    await settle();
    expect(logs).toHaveLength(1);

    // Recovery (success) resets the collapse flag.
    flair.failBeats = false;
    pi.fireAgentStart();
    await settle();
    expect(logs).toHaveLength(1); // no log on success

    // A NEW (different) failure logs again.
    flair.beatReject = "a different failure";
    flair.failBeats = true;
    pi.fireAgentStart();
    await settle();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain("different failure");
  });
});

// ── 3. Turn summary: metadata only, no secret text, bounded retry ──────────

// Build a rich message set: an assistant turn with tool calls, a final assistant
// text, and a tool-result "output" — all carrying "SECRET" to prove the summary
// never ingests prompt/model/tool-output text.
function secretMessages(): PresenceMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "the prompt contains the word SECRET here" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "SECRET thinking" },
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
        { type: "toolCall", id: "t2", name: "bash", arguments: {} },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "t3", name: "edit", arguments: {} }],
    },
    {
      role: "toolResult",
      content: [{ type: "text", text: "tool output contains SECRET data here" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "final SECRET answer to the user" }],
    },
  ];
}

describe("wirePresence — turn summary (agent_end)", () => {
  it("writes a metadata-only summary with the right shape", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler } = makeFakeScheduler();
    const cfg = baseConfig();
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 5_000,
      scheduleBeacon: scheduler,
    });

    pi.fireBeforeAgentStart(tagPrompt("x", { kind: "cron", job: "daily-brief" }));
    pi.fireAgentStart();
    pi.fireAgentEnd(secretMessages());
    await settle();

    expect(flair.writes).toHaveLength(1);
    const content = flair.writes[0].content;
    expect(flair.writes[0].opts?.durability).toBe("standard");
    const summary = JSON.parse(content);
    expect(summary.kind).toBe("turn-summary");
    expect(summary.v).toBe(1);
    expect(summary.agent).toBe("pulse");
    expect(summary.origin).toEqual({ kind: "cron", job: "daily-brief" });
    expect(typeof summary.startedAt).toBe("string");
    expect(typeof summary.endedAt).toBe("string");
    expect(typeof summary.durationMs).toBe("number");
    expect(summary.turns).toBe(3); // 3 assistant messages
    expect(summary.toolCalls).toEqual({ bash: 2, edit: 1 }); // by NAME only
    expect(summary.finalTextChars).toBe("final SECRET answer to the user".length);
    expect(summary.truncated).toBe(false);
  });

  it("NEVER puts prompt/model/tool-output text into the summary (secrets property)", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler } = makeFakeScheduler();
    const cfg = baseConfig();
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 10_000,
      scheduleBeacon: scheduler,
    });

    pi.fireBeforeAgentStart(
      tagPrompt("the user prompt has SECRET in it", { kind: "mail", from: "flint" }),
    );
    pi.fireAgentStart();
    pi.fireAgentEnd(secretMessages());
    await settle();

    const content = flair.writes[0].content;
    // The load-bearing assertion: none of the SECRET-bearing text leaks in.
    expect(content.includes("SECRET")).toBe(false);
    expect(JSON.parse(content).origin).toEqual({ kind: "mail", from: "flint" });
  });

  it("truncates a summary that exceeds maxChars and flags truncated:true", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler } = makeFakeScheduler();
    // A tiny maxChars forces truncation while still holding the compact
    // self-identifying record (kind/v/truncated/agent/origin).
    const cfg = baseConfig({ summary: { enabled: true, durability: "standard", maxChars: 160 } });
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 10_000,
      scheduleBeacon: scheduler,
    });

    // A real summary (~270 chars) exceeds maxChars=160 -> truncation.
    pi.fireBeforeAgentStart(tagPrompt("x", { kind: "discord", channelId: "1234567" }));
    pi.fireAgentStart();
    pi.fireAgentEnd(secretMessages());
    await settle();

    const content = flair.writes[0].content;
    expect(content.length).toBeLessThanOrEqual(160);
    const summary = JSON.parse(content);
    expect(summary.truncated).toBe(true);
    expect(summary.kind).toBe("turn-summary");
    expect(summary.agent).toBe("pulse");
    // No secret text even in the truncated record.
    expect(content.includes("SECRET")).toBe(false);
  });

  it("does NOT write a summary when summary.enabled is false", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler } = makeFakeScheduler();
    const cfg = baseConfig({ summary: { enabled: false } });
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 1,
      scheduleBeacon: scheduler,
    });
    pi.fireBeforeAgentStart("x");
    pi.fireAgentEnd(secretMessages());
    await settle();
    expect(flair.writes).toHaveLength(0);
  });

  it("retries the summary write a bounded number of times (×2) then drops + logs", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    flair.failWrites = true; // every write rejects
    const { scheduler } = makeFakeScheduler();
    const logs: string[] = [];
    const cfg = baseConfig();
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: (m) => logs.push(m),
      now: () => 1,
      scheduleBeacon: scheduler,
      // no-op sleep so the 3 attempts run instantly in the test
      sleep: async () => {},
    });
    pi.fireBeforeAgentStart("x");
    pi.fireAgentEnd(secretMessages());
    await settle();

    // 1 initial attempt + 2 retries = 3 write calls, then drop.
    expect(flair.writes).toHaveLength(SUMMARY_MAX_RETRIES + 1);
    const drops = logs.filter((l) => l.includes("turn summary write failed"));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain(`${SUMMARY_MAX_RETRIES + 1} attempts`);
  });
});

// ── 4. buildTurnSummary — pure, metadata only, truncation ──────────────────

describe("buildTurnSummary — pure metadata", () => {
  function args(overrides: Partial<BuildTurnSummaryArgs> = {}): BuildTurnSummaryArgs {
    return {
      agent: "pulse",
      origin: { kind: "run" },
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_041_230,
      messages: secretMessages(),
      maxChars: 2048,
      ...overrides,
    };
  }

  it("emits the documented shape with counts/labels/timestamps only", () => {
    const s = JSON.parse(buildTurnSummary(args()));
    expect(s.kind).toBe("turn-summary");
    expect(s.v).toBe(1);
    expect(s.agent).toBe("pulse");
    expect(s.origin).toEqual({ kind: "run" });
    expect(new Date(s.startedAt).getTime()).toBe(1_700_000_000_000);
    expect(new Date(s.endedAt).getTime()).toBe(1_700_000_041_230);
    expect(s.durationMs).toBe(41_230);
    expect(s.turns).toBe(3);
    expect(s.toolCalls).toEqual({ bash: 2, edit: 1 });
    expect(s.finalTextChars).toBe("final SECRET answer to the user".length);
    expect(s.truncated).toBe(false);
  });

  it("contains no prompt/model/tool-output text (secrets property)", () => {
    const s = buildTurnSummary(args({ origin: { kind: "mail", from: "flint" } }));
    expect(s.includes("SECRET")).toBe(false);
    expect(s).toContain("flint"); // the origin label is allowed
  });

  it("never counts tool-result (output) messages, only toolCall names", () => {
    const msgs: PresenceMessage[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: {} }] },
      {
        role: "toolResult",
        content: [
          { type: "text", text: "bash: output" },
          { type: "toolCall", id: "b", name: "bash", arguments: {} },
        ],
      },
    ];
    // The toolResult block contains a stray "toolCall" that must NOT be counted.
    const s = JSON.parse(buildTurnSummary(args({ messages: msgs })));
    expect(s.toolCalls).toEqual({ bash: 1 });
    expect(s.turns).toBe(1); // only the one assistant message
  });

  it("hard-slices to maxChars and flags truncated:true when over budget", () => {
    // maxChars small enough to force truncation but large enough to hold the
    // compact self-identifying record.
    const s = buildTurnSummary(
      args({ maxChars: 160, origin: { kind: "discord", channelId: "1234567" } }),
    );
    expect(s.length).toBeLessThanOrEqual(160);
    const parsed = JSON.parse(s);
    expect(parsed.truncated).toBe(true);
    expect(parsed.kind).toBe("turn-summary");
    expect(parsed.agent).toBe("pulse");
    expect(s.includes("SECRET")).toBe(false);
  });

  it("counts turns as assistant messages and finalTextChars as the last assistant's text length", () => {
    // No final assistant text → 0; multiple assistant messages → correct count.
    const msgs: PresenceMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }] },
      { role: "assistant", content: [{ type: "toolCall", id: "b", name: "read", arguments: {} }] },
      { role: "toolResult", content: [{ type: "text", text: "result" }] },
    ];
    const s = JSON.parse(buildTurnSummary(args({ messages: msgs })));
    expect(s.turns).toBe(2);
    expect(s.toolCalls).toEqual({ read: 2 });
    expect(s.finalTextChars).toBe(0); // no assistant text block
  });
});
