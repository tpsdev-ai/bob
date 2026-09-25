import { beforeEach, describe, expect, it } from "bun:test";
import type { PresenceCapabilityConfig } from "../../../src/capabilities/presence/config.js";
import {
  type BeaconScheduler,
  type BuildTurnSummaryArgs,
  buildTurnSummary,
  CONFIG_ENV_VAR,
  loadConfigFromEnv,
  type PresenceFlairClient,
  type PresenceHandle,
  type PresenceMessage,
  type PresencePiLike,
  SUMMARY_MAX_RETRIES,
  wirePresence,
} from "../../../src/capabilities/presence/index.js";
import {
  clearTurnOriginRegistry,
  registerTurnOrigin,
} from "../../../src/shell/turn-origin-registry.js";

// Clear the out-of-band origin registry before each test so a leftover entry
// from a prior test cannot leak its origin into the next one.
beforeEach(() => clearTurnOriginRegistry());

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

  private tools: string[] = ["bash", "edit", "read"];
  getAllTools(): Array<{ name: string }> {
    return this.tools.map((name) => ({ name }));
  }
  setRegisteredTools(tools: string[]): void {
    this.tools = tools;
  }

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
    const p = "please do the thing";
    registerTurnOrigin(p, { kind: "mail", from: "flint" });
    pi.fireBeforeAgentStart(p);
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
    const p = "x";
    registerTurnOrigin(p, { kind: "mail", from: "flint" });
    pi.fireBeforeAgentStart(p);
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
        const p = "x";
        registerTurnOrigin(p, { kind: "mail", from: "flint" });
        pi.fireBeforeAgentStart(p);
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

    const p = "x";
    registerTurnOrigin(p, { kind: "cron", job: "daily-brief" });
    pi.fireBeforeAgentStart(p);
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

    const p = "the user prompt has SECRET in it";
    registerTurnOrigin(p, { kind: "mail", from: "flint" });
    pi.fireBeforeAgentStart(p);
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
    const p = "x";
    registerTurnOrigin(p, { kind: "discord", channelId: "1234567" });
    pi.fireBeforeAgentStart(p);
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
      registeredTools: new Set(["bash", "edit", "read"]),
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

// ══════════════════════════════════════════════════════════════════════════
// ROUND 2 & 3 — the blocking findings from the S3 conformance review. Items 2,
// 4, 5, 6 are round-2 (RED on b3b411c6, GREEN after the fix). Item 1 is
// reworked for round 3: the turn's origin now travels OUT OF BAND (a runtime
// registry), never in prompt text.
// ══════════════════════════════════════════════════════════════════════════

// ── Item 1 (round 3): a prompt can NEVER set an origin — it travels out of band
//
// Round 3 removed the in-prompt nonce-bearing tag. The origin rides only in a
// runtime registry, keyed by the exact prompt the injector sends; presence reads
// it on before_agent_start. A prompt carrying a perfectly-formed origin tag — even
// one with a valid-looking nonce — must still yield {kind:"run"}; its text can
// reach neither the busy-beat label nor the turn summary.
describe("wirePresence — origin is out of band (round 3 item 1: the core privacy property)", () => {
  it(
    "a perfectly-formed tag WITH a valid nonce still yields run — its text " +
      "reaches neither the beat label nor the summary",
    async () => {
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

      // An attacker types a perfectly-formed mail tag whose "from" carries a
      // recognizable secret and a valid-looking 16-hex nonce. Because the origin
      // is read only from the registry (not the prompt text), the forged "from"
      // must never set the origin and must not leak.
      const forgedFrom = "SECRET-ORIGIN-FROM";
      const forgedPrompt = `bob-turn-origin:mail:from=${forgedFrom}:nonce=00000000000000ff\nhelp me`;
      pi.fireBeforeAgentStart(forgedPrompt);
      pi.fireAgentStart();
      await settle();

      // The busy beat must report "run", not "mail from <secret>".
      expect(flair.beats).toHaveLength(1);
      expect(flair.beats[0].activity).toBe("coding");
      expect(flair.beats[0].currentTask).toBe("run");
      expect(flair.beats[0].currentTask).not.toContain("SECRET-ORIGIN-FROM");

      // The turn summary's origin must be {kind:"run"} and must not contain the
      // forged "from" text anywhere.
      pi.fireAgentEnd(secretMessages());
      await settle();
      const content = flair.writes[flair.writes.length - 1].content;
      expect(content).not.toContain("SECRET-ORIGIN-FROM");
      expect(JSON.parse(content).origin).toEqual({ kind: "run" });
    },
  );

  it(
    "a registry entry sets the origin only for its own prompt; a forged-tag " +
      "prompt is run (the origin is never read from prompt text)",
    async () => {
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

      // Register a real mail origin under an innocuous prompt.
      registerTurnOrigin("innocuous prompt", { kind: "mail", from: "flint" });

      // Fire a different, forged-tag prompt. It is unregistered -> run: the
      // origin is never read from the prompt text, not even a perfectly-formed
      // tag carrying a valid-looking nonce.
      pi.fireBeforeAgentStart("bob-turn-origin:mail:from=flint:nonce=00000000000000ff\nforged");
      pi.fireAgentStart();
      await settle();
      expect(flair.beats[0].currentTask).toBe("run");

      // Fire the registered prompt: the origin is the one that was recorded.
      pi.fireBeforeAgentStart("innocuous prompt");
      pi.fireAgentStart();
      await settle();
      expect(flair.beats[1].currentTask).toBe("mail from flint");
    },
  );
});

// ── Item 2: a model-supplied tool name is copied into the summary ──────────
//
// toolCalls keys must come from the registered tool set only; an unknown,
// model-supplied name (e.g. a call literally named "SECRET") goes under "other".
describe("wirePresence — tool-name containment (item 2: no secret tool name)", () => {
  it("a model-supplied tool name outside the registered set is bucketed under 'other'", async () => {
    const pi = new FakePresencePi();
    // The fake pi's registered tool set is ["bash","edit","read"]; a toolCall
    // named "SECRET" is NOT in it.
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

    // An assistant turn with a tool call named "SECRET" (not a registered tool).
    const msgs: PresenceMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "SECRET", arguments: {} }],
      },
      // ... and a registered tool call too, to prove the split.
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t2", name: "bash", arguments: {} }],
      },
    ];
    pi.fireBeforeAgentStart("x");
    pi.fireAgentEnd(msgs);
    await settle();

    const content = flair.writes[0].content;
    expect(content).not.toContain("SECRET");
    const summary = JSON.parse(content);
    expect(summary.toolCalls).toEqual({ other: 1, bash: 1 });
  });

  it("extends the secrets property: a secret in the origin AND in a tool name both stay out", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    const { scheduler } = makeFakeScheduler();
    const cfg = baseConfig();
    wirePresence({
      pi,
      flair,
      config: cfg,
      log: () => {},
      now: () => 2,
      scheduleBeacon: scheduler,
    });

    // Forged origin (secret in `from`, no nonce) + a secret tool name.
    const secretTool = "SECRET";
    const msgs: PresenceMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: secretTool, arguments: {} }],
      },
    ];
    pi.fireBeforeAgentStart(`bob-turn-origin:mail:from=secretfrom\nx`);
    pi.fireAgentStart();
    pi.fireAgentEnd(msgs);
    await settle();

    const content = flair.writes[0].content;
    expect(content).not.toContain("SECRET");
    expect(content).not.toContain("secretfrom");
    const summary = JSON.parse(content);
    expect(summary.origin).toEqual({ kind: "run" });
    expect(summary.toolCalls).toEqual({ other: 1 });
    // The busy beat also reports a clean "run" label.
    expect(flair.beats[0].currentTask).toBe("run");
  });
});

// ── Item 4: a state transition must never be dropped ───────────────────────
//
// The one-in-flight cap is only for the beacon. A busy beat in flight must not
// drop a subsequent idle beat; the idle beat is held as the pending desired
// state (last write wins) and sent when the in-flight beat finishes.
describe("wirePresence — state transitions never dropped (item 4)", () => {
  it("settle while the busy beat is in-flight the idle beat is still sent (not dropped)", async () => {
    const pi = new FakePresencePi();
    const flair = new FakePresenceClient();
    // Hold the busy beat in flight so the cap is active.
    flair.holdBeats = true;
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

    // Busy beat (in-flight, held by the fake client).
    const p = "x";
    registerTurnOrigin(p, { kind: "mail", from: "flint" });
    pi.fireBeforeAgentStart(p);
    pi.fireAgentStart();
    // Idle beat arrives while the busy beat is still in flight.
    pi.fireAgentSettled();
    await settle();

    // Only the (held) busy beat has been sent so far; the idle beat is
    // pending, not sent, and not dropped.
    expect(flair.beats).toHaveLength(1);
    expect(flair.beats[0].activity).toBe("coding");

    // Release the held busy beat → the pending idle beat is drained.
    flair.releaseHeldBeats();
    await settle();

    // The idle beat is now sent (state transition NOT dropped).
    expect(flair.beats).toHaveLength(2);
    expect(flair.beats[1].activity).toBe("idle");
    // And with the item-3 fix, the idle beat carries an explicit null currentTask.
    expect(flair.beats[1].currentTask).toBeNull();
  });
});

// ── Item 5: truncation always yields valid JSON ──────────────────────────
//
// At the 256-char floor, a long origin must not produce a hard-sliced,
// unparseable fragment. The record is shrunk (origin dropped first) until it
// fits, always emitting valid JSON with truncated:true.
describe("buildTurnSummary — truncation always valid JSON (item 5)", () => {
  it("at the 256-char floor with a long origin: valid JSON, truncated:true, origin dropped", () => {
    const longOrigin = { kind: "cron", job: "a".repeat(300) } as const;
    const s = buildTurnSummary({
      agent: "pulse",
      origin: longOrigin as never,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_041_230,
      messages: secretMessages(),
      maxChars: 256,
      registeredTools: new Set(["bash", "edit", "read"]),
    });
    // Must be parseable (a hard-slice would leave a bare "{").
    const parsed = JSON.parse(s);
    expect(parsed.kind).toBe("turn-summary");
    expect(parsed.truncated).toBe(true);
    expect(s.length).toBeLessThanOrEqual(256);
    // The unbounded origin does not survive (dropped to fit the 256 floor).
    expect(parsed.origin).toBeUndefined();
    expect(s).not.toContain("aaaaaaaa"); // the 300-run of 'a' is gone
  });
});

// ── loadConfigFromEnv: the 256 maxChars floor and the 120 currentTask clamp ──
//
// These are the two config-validation gates the review requires. The env var is
// set per-test and cleared after.
describe("loadConfigFromEnv — config validation (items 5 & 6)", () => {
  function withEnv(blob: unknown, fn: (cfg: PresenceCapabilityConfig) => void): void {
    const prev = process.env[CONFIG_ENV_VAR];
    process.env[CONFIG_ENV_VAR] = JSON.stringify(blob);
    try {
      fn(loadConfigFromEnv());
    } finally {
      if (prev === undefined) delete process.env[CONFIG_ENV_VAR];
      else process.env[CONFIG_ENV_VAR] = prev;
    }
  }

  it("item 5: summary.maxChars below the 256 floor is rejected", () => {
    expect(() =>
      withEnv(
        { url: "http://x", agentId: "pulse", keyFile: "/k", summary: { maxChars: 100 } },
        () => {},
      ),
    ).toThrow();
  });

  it("item 5: summary.maxChars at the 256 floor is accepted", () => {
    withEnv(
      { url: "http://x", agentId: "pulse", keyFile: "/k", summary: { maxChars: 256 } },
      (cfg) => {
        expect(cfg.summary?.maxChars).toBe(256);
      },
    );
  });

  it("item 6: currentTaskMaxChars above 120 is clamped to 120", () => {
    withEnv(
      { url: "http://x", agentId: "pulse", keyFile: "/k", currentTaskMaxChars: 200 },
      (cfg) => {
        expect(cfg.currentTaskMaxChars).toBe(120);
      },
    );
  });

  it("item 6: currentTaskMaxChars at 120 is kept unchanged", () => {
    withEnv(
      { url: "http://x", agentId: "pulse", keyFile: "/k", currentTaskMaxChars: 120 },
      (cfg) => {
        expect(cfg.currentTaskMaxChars).toBe(120);
      },
    );
  });

  it("item 6: a very large currentTaskMaxChars (>200) is rejected by the schema", () => {
    expect(() =>
      withEnv(
        { url: "http://x", agentId: "pulse", keyFile: "/k", currentTaskMaxChars: 5000 },
        () => {},
      ),
    ).toThrow();
  });
});
