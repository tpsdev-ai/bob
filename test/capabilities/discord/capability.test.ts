import { describe, expect, it } from "bun:test";
import {
  type AssistantMessageLike,
  createDiscordTurn,
  type PiLike,
  wireDiscordCapability,
} from "../../../src/capabilities/discord/capability.js";
import type { DiscordCapabilityConfig } from "../../../src/capabilities/discord/config.js";
import type { DiscordClient, DiscordMessage } from "../../../src/shell/discord-types.js";
import { ReasoningOnlyExhaustedError } from "../../../src/shell/reasoning-retry.js";
import { createTurnAdmission } from "../../../src/shell/turn-admission.js";
import type { TurnOrigin } from "../../../src/shell/turn-origin.js";

// --- Fakes (no live gateway, no real token, no LLM) -------------------------

type ToolDef = Parameters<PiLike["registerTool"]>[0];

type AgentEndHandler = (event: { messages: AssistantMessageLike[] }) => void | Promise<void>;

class FakePi implements PiLike {
  readonly tools = new Map<string, ToolDef>();
  readonly userMessages: string[] = [];
  rateHandler?: (e: { status: number; headers: Record<string, string> }) => void;
  agentEndHandler?: AgentEndHandler;

  registerTool(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }
  on(
    event: "after_provider_response" | "agent_end",
    handler: typeof this.rateHandler | AgentEndHandler,
  ): void {
    if (event === "after_provider_response") {
      this.rateHandler = handler as typeof this.rateHandler;
    } else {
      this.agentEndHandler = handler as AgentEndHandler;
    }
  }
  private completions: Array<(messages: unknown[]) => void> = [];
  // A simple single-valued stand-in for the running turn's origin, NOT a model
  // of the real admission: the real admission is a FIFO whose origin spans the
  // whole admitted prompt, while this fake admits every message immediately and
  // replaces the origin (its `admitTurn` never QUEUES). The binding property is
  // pinned against the REAL admission in the tests below, which is why that
  // distinction matters; here it only backs the per-call checks.
  currentOrigin: TurnOrigin = { kind: "run" };
  readOrigin = (): TurnOrigin => this.currentOrigin;
  admitTurn = (origin: TurnOrigin, content: string): Promise<unknown[]> => {
    this.userMessages.push(content);
    this.currentOrigin = origin;
    return new Promise((resolve) => this.completions.push(resolve));
  };
  // Simulate the agent finishing a turn with the given assistant text. Drives
  // the agent_end reply-routing path. `await` so the async reply post settles.
  async finishTurn(assistantText: string | undefined): Promise<void> {
    const messages: AssistantMessageLike[] =
      assistantText === undefined
        ? [{ role: "assistant", content: [{ type: "text", text: "" }] }]
        : [{ role: "assistant", content: [{ type: "text", text: assistantText }] }];
    this.completions.shift()?.(messages);
    // The finished turn is no longer running; if none remains, the origin is
    // back to run. (A later queued turn takes over via its own admitTurn call.)
    if (this.completions.length === 0) this.currentOrigin = { kind: "run" };
    await Promise.resolve();
    await Promise.resolve();
  }
  // helper
  async call(name: string, params: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.execute(`call-${name}`, params);
  }
}

class FakeDiscordClient implements DiscordClient {
  private handler?: (msg: DiscordMessage) => void;
  readonly replies: Array<{ channelId: string; text: string; replyTo?: string }> = [];
  readonly reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  // Every typing pulse, in order — the heartbeat assertions count these.
  readonly typings: string[] = [];
  fetchReturns: DiscordMessage[] = [];
  // message id -> the channel it lives in, recorded as messages are `fire`d, so
  // `fetchMessage` can mimic Discord: a lookup in the WRONG channel is null
  // (404), exactly as the real client reports it.
  readonly messageChannels = new Map<string, string>();
  connectCalled = false;
  disconnectCalled = false;
  replyThrows = false;
  connectHangs = false;
  typingThrows = false;

  on(_e: "message", handler: (msg: DiscordMessage) => void): void {
    this.handler = handler;
  }
  async connect(): Promise<void> {
    this.connectCalled = true;
    if (this.connectHangs) await new Promise<void>(() => {}); // never resolves
  }
  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
  }
  async reply(channelId: string, text: string, opts?: { replyTo?: string }): Promise<void> {
    if (this.replyThrows) throw new Error("simulated discord REST failure");
    this.replies.push({ channelId, text, replyTo: opts?.replyTo });
  }
  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji });
  }
  async fetchRecent(_channelId: string, _limit: number): Promise<DiscordMessage[]> {
    return this.fetchReturns;
  }
  async fetchMessage(channelId: string, messageId: string): Promise<DiscordMessage | null> {
    const ch = this.messageChannels.get(messageId);
    if (ch === undefined || ch !== channelId) return null;
    return {
      id: messageId,
      channelId: ch,
      authorId: "u1",
      authorName: "user",
      content: "",
      mentionsBot: false,
    };
  }
  async sendTyping(channelId: string): Promise<void> {
    if (this.typingThrows) throw new Error("simulated discord typing failure");
    this.typings.push(channelId);
  }
  fire(msg: Partial<DiscordMessage> & Pick<DiscordMessage, "channelId" | "content">): void {
    const id = msg.id ?? "m1";
    this.messageChannels.set(id, msg.channelId);
    this.handler?.({
      id,
      channelId: msg.channelId,
      authorId: msg.authorId ?? "u1",
      authorName: msg.authorName ?? "user",
      content: msg.content,
      mentionsBot: msg.mentionsBot ?? false,
    });
  }
}

// Heartbeat assertions drive REAL timers at a few ms (the same shape as the
// existing connectTimeoutMs tests) rather than faking the clock.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setup(
  overrides: Partial<DiscordCapabilityConfig> = {},
  wireOverrides: { typingIntervalMs?: number; typingMaxMs?: number } = {},
) {
  const pi = new FakePi();
  const client = new FakeDiscordClient();
  const logs: string[] = [];
  const config: DiscordCapabilityConfig = {
    tokenFile: "/secrets/bot.token",
    channelIds: ["channel-A", "channel-B"],
    dispatchAll: false,
    ...overrides,
  };
  const wired = wireDiscordCapability({
    pi,
    admitTurn: pi.admitTurn,
    readOrigin: pi.readOrigin,
    client,
    config,
    log: (m) => logs.push(m),
    ...wireOverrides,
  });
  return { pi, client, logs, config, wired };
}

describe("wireDiscordCapability — tools", () => {
  it("registers reply/react/fetch", () => {
    const { pi } = setup();
    expect([...pi.tools.keys()].sort()).toEqual([
      "discord_fetch",
      "discord_react",
      "discord_reply",
    ]);
  });

  it("discord_reply posts to an allow-listed channel via the client", async () => {
    const { pi, client } = setup();
    await pi.call("discord_reply", { channelId: "channel-A", text: "hi", replyTo: "m9" });
    expect(client.replies).toEqual([{ channelId: "channel-A", text: "hi", replyTo: "m9" }]);
  });

  it("discord_reply REFUSES a channel outside the allow-list", async () => {
    const { pi, client } = setup();
    await expect(pi.call("discord_reply", { channelId: "evil", text: "x" })).rejects.toThrow(
      /not in the configured allow-list/,
    );
    expect(client.replies).toHaveLength(0);
  });

  it("discord_react routes to client.react and enforces the allow-list", async () => {
    const { pi, client } = setup();
    await pi.call("discord_react", { channelId: "channel-A", messageId: "m1", emoji: "✅" });
    expect(client.reactions).toEqual([{ channelId: "channel-A", messageId: "m1", emoji: "✅" }]);
    await expect(
      pi.call("discord_react", { channelId: "nope", messageId: "m1", emoji: "✅" }),
    ).rejects.toThrow(/allow-list/);
  });

  it("discord_fetch reads recent messages from an allow-listed channel", async () => {
    const { pi, client } = setup();
    client.fetchReturns = [
      {
        id: "1",
        channelId: "channel-A",
        authorId: "a",
        authorName: "alice",
        content: "yo",
        mentionsBot: false,
      },
    ];
    const res = await pi.call("discord_fetch", { channelId: "channel-A", limit: 5 });
    expect(res.content[0].text).toContain("alice: yo");
  });

  it("discord_fetch refuses an un-allowed channel", async () => {
    const { pi } = setup();
    await expect(pi.call("discord_fetch", { channelId: "nope" })).rejects.toThrow(/allow-list/);
  });

  it("discord_reply truncates over-long text", async () => {
    const { pi, client } = setup();
    await pi.call("discord_reply", { channelId: "channel-A", text: "x".repeat(5000) });
    expect(client.replies[0].text.length).toBeLessThanOrEqual(1901);
    expect(client.replies[0].text.endsWith("…")).toBe(true);
  });
});

describe("wireDiscordCapability — inbound listener", () => {
  it("drives the agent on a mention in an allow-listed channel (mention stripped)", () => {
    const { pi, client } = setup();
    client.fire({ channelId: "channel-A", content: "<@123> what's the brief?", mentionsBot: true });
    expect(pi.userMessages).toEqual(["what's the brief?"]);
  });

  it("DROPS messages on a channel outside the allow-list (trust boundary)", () => {
    const { pi, client } = setup();
    client.fire({ channelId: "not-listed", content: "<@123> hi", mentionsBot: true });
    expect(pi.userMessages).toHaveLength(0);
  });

  it("ignores non-mentions by default (dispatchAll=false)", () => {
    const { pi, client } = setup();
    client.fire({ channelId: "channel-A", content: "ambient chatter", mentionsBot: false });
    expect(pi.userMessages).toHaveLength(0);
  });

  it("dispatches all messages on allow-listed channels when dispatchAll=true — still bounded by allow-list", () => {
    const { pi, client } = setup({ dispatchAll: true });
    client.fire({ channelId: "channel-A", content: "ambient", mentionsBot: false });
    client.fire({ channelId: "not-listed", content: "ambient", mentionsBot: false });
    expect(pi.userMessages).toEqual(["ambient"]);
  });

  it("ignores a message that is empty after stripping the mention", () => {
    const { pi, client } = setup();
    client.fire({ channelId: "channel-A", content: "<@123>", mentionsBot: true });
    expect(pi.userMessages).toHaveLength(0);
  });
});

describe("wireDiscordCapability — reply routing (inbound → originating channel)", () => {
  it("posts the agent's reply back to the ORIGINATING channel on agent_end", async () => {
    const { pi, client } = setup();
    // Inbound on channel-B, message id m42.
    client.fire({
      id: "m42",
      channelId: "channel-B",
      content: "<@123> status?",
      mentionsBot: true,
    });
    expect(pi.userMessages).toEqual(["status?"]);
    // Agent finishes its turn with a final answer.
    await pi.finishTurn("all green");
    // Reply routed to channel-B (the originator), quote-replying to m42.
    expect(client.replies).toEqual([{ channelId: "channel-B", text: "all green", replyTo: "m42" }]);
  });

  it("routes to channel C when the inbound message came from channel C (the spec's mocked proof)", async () => {
    const { pi, client } = setup({ channelIds: ["channel-C", "channel-A"] });
    client.fire({ id: "mC", channelId: "channel-C", content: "<@1> ping", mentionsBot: true });
    await pi.finishTurn("pong");
    expect(client.replies).toEqual([{ channelId: "channel-C", text: "pong", replyTo: "mC" }]);
  });

  it("does NOT post when agent_end has no originating Discord message (heartbeat/cron turn)", async () => {
    const { pi, client } = setup();
    // No inbound message fired — a self-directed turn finishes.
    await pi.finishTurn("internal monologue");
    expect(client.replies).toHaveLength(0);
  });

  it("posts nothing for a tool-only turn (no assistant text) but still consumes pending", async () => {
    const { pi, client } = setup();
    client.fire({ id: "m1", channelId: "channel-A", content: "<@1> react", mentionsBot: true });
    await pi.finishTurn(undefined); // empty assistant text
    expect(client.replies).toHaveLength(0);
    // pending was consumed: a later self-directed turn must not leak a reply.
    await pi.finishTurn("late text");
    expect(client.replies).toHaveLength(0);
  });

  it("truncates an over-long reply to Discord's limit", async () => {
    const { pi, client } = setup();
    client.fire({ id: "m1", channelId: "channel-A", content: "<@1> essay", mentionsBot: true });
    await pi.finishTurn("y".repeat(5000));
    expect(client.replies[0].channelId).toBe("channel-A");
    expect(client.replies[0].text.length).toBeLessThanOrEqual(1901);
    expect(client.replies[0].text.endsWith("…")).toBe(true);
  });

  it("a failed reply post is logged, not thrown (persistent session survives)", async () => {
    const { pi, client, logs } = setup();
    client.replyThrows = true;
    client.fire({ id: "m1", channelId: "channel-A", content: "<@1> hi", mentionsBot: true });
    await pi.finishTurn("hello");
    expect(logs.some((l) => /inbound turn\/reply failed for channel-A/.test(l))).toBe(true);
  });

  it("the reply path never includes the bot token (no token in this core)", async () => {
    const { pi, client, config } = setup();
    client.fire({ id: "m1", channelId: "channel-A", content: "<@1> hi", mentionsBot: true });
    await pi.finishTurn("hello");
    const haystack = JSON.stringify({ config, replies: client.replies });
    expect(haystack).not.toContain("tok_");
    expect(config.tokenFile).toBe("/secrets/bot.token");
  });
});

// A harness that wires the capability to the REAL turn admission (bob's FIFO),
// so an inbound message admitted while another turn is running actually QUEUES.
// Only the pi surface, the Discord transport and the session's prompt body are
// fakes — the serialization and the origin binding are production code. The
// fake session records that each prompt STARTED and with which origin, runs an
// optional per-turn body (where the test drives tool calls, exactly as the
// agent would mid-turn), blocks until the test (or a stopping abort) releases
// it, then emits agent_end so the admission captures the turn's messages.
//
// `abort` picks the session's abort(): "stops" (the default) works like pi's —
// it waits on `holdAbort`'s gate, then ends the prompt that was running when it
// was called, once that prompt's body has returned; "rejects" rejects and stops
// nothing; "missing" leaves abort() off the session.
function setupRealAdmission(
  opts: {
    toolLoopLimit?: number;
    loopAbortGraceMs?: number;
    abort?: "stops" | "rejects" | "missing";
  } = {},
) {
  const { abort: abortMode = "stops", ...admissionOpts } = opts;
  const pi = new FakePi();
  const client = new FakeDiscordClient();
  const logs: string[] = [];
  const admission = createTurnAdmission({ ...admissionOpts, log: (m) => logs.push(m) });
  const started: string[] = [];
  const originAtStart: TurnOrigin[] = [];
  const releases = new Map<string, () => void>();
  // A prompt released (by the test or by a stopping abort) before it parks
  // does not park at all.
  const released = new Set<string>();
  const releasePrompt = (text: string): void => {
    released.add(text);
    releases.get(text)?.();
  };
  let onTurn: ((text: string) => void | Promise<void>) | undefined;
  let listener: ((event: { type: string; messages?: unknown[] }) => void) | undefined;
  let abortGate: Promise<void> | undefined;
  let aborts = 0;
  const session = {
    subscribe(l: (event: { type: string; messages?: unknown[] }) => void) {
      listener = l;
      return () => {};
    },
    async waitForIdle(): Promise<void> {},
    ...(abortMode === "missing"
      ? {}
      : {
          // The session's abort. `holdAbort` parks it so a test can observe
          // the interval between the loop break and the abort settling.
          async abort(): Promise<void> {
            aborts += 1;
            if (abortMode === "rejects") throw new Error("abort failed");
            const text = started[started.length - 1];
            if (abortGate) await abortGate;
            if (text !== undefined) releasePrompt(text);
          },
        }),
    async prompt(text: string): Promise<void> {
      started.push(text);
      originAtStart.push(admission.readOrigin());
      await onTurn?.(text);
      if (!released.has(text)) {
        await new Promise<void>((resolve) => releases.set(text, resolve));
      }
      listener?.({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: `${text}::answer` }] }],
      });
    },
    dispose(): void {},
  };
  admission.bind(session as never);
  wireDiscordCapability({
    pi,
    client,
    config: {
      tokenFile: "/secrets/bot.token",
      channelIds: ["111", "222"],
      dispatchAll: false,
    },
    admitTurn: admission.admitTurn,
    readOrigin: admission.readOrigin,
    log: (m) => logs.push(m),
  });
  return {
    pi,
    client,
    logs,
    started,
    originAtStart,
    // The real admission's reader. It is bound to the prompt's async context,
    // so it names a turn only when called from inside that turn's body.
    readOrigin: admission.readOrigin,
    aborts: () => aborts,
    // Park the session's abort() until the given promise settles.
    holdAbort(promise: Promise<void>) {
      abortGate = promise;
    },
    // The session's own tool_execution_start, exactly as pi emits it.
    emitToolStart(toolName: string, args: unknown) {
      listener?.({ type: "tool_execution_start", toolName, args } as never);
    },
    setOnTurn(fn: (text: string) => void | Promise<void>) {
      onTurn = fn;
    },
    release(text: string) {
      releasePrompt(text);
    },
    // Emit an agent_end through the session's subscription, exactly as pi would
    // at an agent-loop boundary (a retry / continuation fires one mid-prompt).
    emitAgentEnd(messages?: unknown[]) {
      listener?.({
        type: "agent_end",
        messages: messages ?? [{ role: "assistant", content: [{ type: "text", text: "mid" }] }],
      });
    },
    // Let the FIFO's microtask chain settle.
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

// A latch the test controls: the promise settles only when the test says so.
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Run one outbound tool and record how it ended: "ok", or the refusal message.
async function attempt(pi: FakePi, name: string, params: Record<string, unknown>): Promise<string> {
  try {
    await pi.call(name, params);
    return "ok";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("wireDiscordCapability — a real queued turn keeps its own origin (issue #227)", () => {
  it("holds A mid-turn while B is admitted, then checks A's origin and tool binding before A ends", async () => {
    const h = setupRealAdmission();
    // A's prompt parks on this latch BEFORE any tool call, so B is admitted
    // while A is still active and has not yet touched Discord.
    const resumeA = deferred();
    // What A observed once resumed. The origin read and the tool calls happen
    // INSIDE A's prompt body, because the real admission binds the origin to
    // the prompt's async context (the test body itself always reads run).
    const aReport = deferred<{
      origin: TurnOrigin;
      crossChannel: Array<{ tool: string; outcome: string }>;
      ownChannel: string;
    }>();
    h.setOnTurn(async (text) => {
      if (text !== "A?") return;
      await resumeA.promise;
      const origin = h.readOrigin();
      const crossChannel: Array<{ tool: string; outcome: string }> = [];
      for (const [tool, params] of [
        ["discord_reply", { channelId: "222", text: "sneak" }],
        ["discord_react", { channelId: "222", messageId: "mB", emoji: "✅" }],
        ["discord_fetch", { channelId: "222" }],
      ] as const) {
        crossChannel.push({ tool, outcome: await attempt(h.pi, tool, params) });
      }
      // Its OWN channel is allowed.
      const ownChannel = await attempt(h.pi, "discord_reply", {
        channelId: "111",
        text: "ok on A",
      });
      aReport.resolve({ origin, crossChannel, ownChannel });
    });

    // 1. A arrives; its turn starts with channel 111's origin and parks on the
    //    latch before any tool call.
    h.client.fire({ id: "mA", channelId: "111", content: "<@1> A?", mentionsBot: true });
    await h.flush();
    expect(h.started).toEqual(["A?"]);
    expect(h.originAtStart).toEqual([{ kind: "discord", channelId: "111" }]);

    // 2. B arrives on the other channel WHILE A is active: it QUEUES — its
    //    prompt has NOT started.
    h.client.fire({ id: "mB", channelId: "222", content: "<@1> B?", mentionsBot: true });
    await h.flush();
    expect(h.started, "B is queued while A runs; it must not start").toEqual(["A?"]);

    // 3. Resume A, with B already admitted. A's origin is still channel 111,
    //    and every outbound tool aimed at B's channel is refused.
    resumeA.resolve();
    const report = await aReport.promise;
    expect(report.origin).toEqual({ kind: "discord", channelId: "111" });
    const refusal = expect.stringMatching(/bound to channel 111.*refusing to use channel 222/);
    expect(report.crossChannel).toEqual([
      { tool: "discord_reply", outcome: refusal },
      { tool: "discord_react", outcome: refusal },
      { tool: "discord_fetch", outcome: refusal },
    ]);
    expect(report.ownChannel).toBe("ok");
    // Nothing reached B's channel, and B still has not started.
    expect(h.client.replies).toEqual([{ channelId: "111", text: "ok on A", replyTo: undefined }]);
    expect(h.client.reactions).toEqual([]);
    await h.flush();
    expect(h.started, "B stays queued until A ends").toEqual(["A?"]);

    // 4. Only now finish A. B then starts with channel 222's origin.
    h.release("A?");
    await h.flush();
    expect(h.started).toEqual(["A?", "B?"]);
    expect(h.originAtStart[1]).toEqual({ kind: "discord", channelId: "222" });

    // Release B: it finishes. Each reply is a regression pin — routing to each
    // message's own channel/message was ALREADY correct on main (each message's
    // callback captures its own destination); this PR does not change routing.
    h.release("B?");
    await h.flush();
    expect(h.client.replies).toEqual([
      { channelId: "111", text: "ok on A", replyTo: undefined },
      { channelId: "111", text: "A?::answer", replyTo: "mA" },
      { channelId: "222", text: "B?::answer", replyTo: "mB" },
    ]);
  });

  it("keeps the binding across a mid-loop agent_end (the origin spans the whole admitted prompt)", async () => {
    const h = setupRealAdmission();
    const report = deferred<Array<{ tool: string; outcome: string }>>();
    h.setOnTurn(async (text) => {
      if (text !== "A?") return;
      // A retry/continuation fires an agent_end INSIDE the prompt. The turn must
      // stay bound to channel 111 after it — a per-call readOrigin() that the
      // agent_end cleared would revert the tools to allowlist reach mid-turn.
      h.emitAgentEnd();
      const after: Array<{ tool: string; outcome: string }> = [];
      for (const [tool, params] of [
        ["discord_reply", { channelId: "222", text: "sneak" }],
        ["discord_react", { channelId: "222", messageId: "mB", emoji: "✅" }],
        ["discord_fetch", { channelId: "222" }],
      ] as const) {
        after.push({ tool, outcome: await attempt(h.pi, tool, params) });
      }
      report.resolve(after);
    });
    h.client.fire({ id: "mA", channelId: "111", content: "<@1> A?", mentionsBot: true });
    await h.flush();
    const after = await report.promise;
    const refusal = expect.stringMatching(/bound to channel 111.*refusing to use channel 222/);
    expect(after).toEqual([
      { tool: "discord_reply", outcome: refusal },
      { tool: "discord_react", outcome: refusal },
      { tool: "discord_fetch", outcome: refusal },
    ]);
    h.release("A?");
    await h.flush();
  });
});

// bob#143 item 3: a loop break fails THIS admission, but pi's prompt may still
// be running — its parallel tool path can execute a call prepared before the
// abort, and the session's abort() may be missing or fail. The turn's origin
// binding must last until the prompt settles, or the in-flight tool reads `run`
// (which the outbound check exempts) and reaches a channel the turn is not
// bound to.
describe("wireDiscordCapability — a loop break keeps the turn's origin binding (bob#143)", () => {
  it("an in-flight tool after the loop break sees the turn's origin while the abort is pending", async () => {
    const h = setupRealAdmission({ toolLoopLimit: 2 });
    const abortGate = deferred();
    h.holdAbort(abortGate.promise);
    const report = deferred<{ origin: TurnOrigin; crossChannel: string; ownChannel: string }>();
    h.setOnTurn(async (text) => {
      if (text !== "A?") return;
      // Two identical calls in a row: the second one fires the loop breaker.
      h.emitToolStart("edit", { path: "f.ts" });
      h.emitToolStart("edit", { path: "f.ts" });
      // The break has fired and the session has been signalled to stop, but the
      // prompt has NOT settled: a tool call pi prepared before the abort runs.
      await new Promise<void>((r) => setTimeout(r, 5));
      report.resolve({
        origin: h.readOrigin(),
        crossChannel: await attempt(h.pi, "discord_reply", { channelId: "222", text: "sneak" }),
        ownChannel: await attempt(h.pi, "discord_reply", { channelId: "111", text: "ok on A" }),
      });
    });
    h.client.fire({ id: "mA", channelId: "111", content: "<@1> A?", mentionsBot: true });
    await h.flush();
    const r = await report.promise;
    // The origin is still this turn's, so the turn-channel binding still holds:
    // the other channel is refused and nothing reached it.
    expect(r.origin).toEqual({ kind: "discord", channelId: "111" });
    expect(r.crossChannel).toMatch(/bound to channel 111.*refusing to use channel 222/);
    expect(r.ownChannel).toBe("ok");
    expect(h.client.replies).toEqual([{ channelId: "111", text: "ok on A", replyTo: undefined }]);
    expect(h.logs.some((m) => m.includes("LOOP BREAKER") && m.includes("edit"))).toBe(true);
    // Let the abort finish: it ends the prompt, the admission's rejection
    // follows, and the inbound path reports the failed turn.
    abortGate.resolve();
    await h.flush();
    expect(h.aborts()).toBe(1);
    expect(
      h.logs.some((m) => m.includes("inbound turn/reply failed") && m.includes("repeated 2 times")),
    ).toBe(true);
  }, 15_000);

  it("if the prompt does not settle in the bound, the binding is kept and the runtime reports it", async () => {
    const h = setupRealAdmission({ toolLoopLimit: 2, loopAbortGraceMs: 20 });
    h.holdAbort(new Promise<void>(() => {})); // the abort never settles
    const report = deferred<{ origin: TurnOrigin; crossChannel: string }>();
    h.setOnTurn(async (text) => {
      if (text !== "A?") return;
      h.emitToolStart("edit", { path: "f.ts" });
      h.emitToolStart("edit", { path: "f.ts" });
      // Wait PAST the bound, so the admission has given up waiting.
      await new Promise<void>((r) => setTimeout(r, 60));
      report.resolve({
        origin: h.readOrigin(),
        crossChannel: await attempt(h.pi, "discord_reply", { channelId: "222", text: "sneak" }),
      });
    });
    h.client.fire({ id: "mA", channelId: "111", content: "<@1> A?", mentionsBot: true });
    await h.flush();
    const r = await report.promise;
    expect(r.origin).toEqual({ kind: "discord", channelId: "111" });
    expect(r.crossChannel).toMatch(/bound to channel 111.*refusing to use channel 222/);
    expect(h.logs.some((m) => m.includes("did not settle within 20ms"))).toBe(true);
    // Let the fake prompt finish so the harness leaves nothing parked.
    h.release("A?");
    await h.flush();
  }, 15_000);

  it("an abort that rejects: a delayed tool keeps the turn's origin, even after a queued turn starts, until the prompt settles", async () => {
    const h = setupRealAdmission({ toolLoopLimit: 2, loopAbortGraceMs: 200, abort: "rejects" });
    const bStarted = deferred();
    const settledA = deferred();
    let originAfterSettle: Promise<TurnOrigin> | undefined;
    const report = deferred<{ origin: TurnOrigin; crossChannel: string; ownChannel: string }>();
    h.setOnTurn(async (text) => {
      if (text === "B?") {
        bStarted.resolve();
        return;
      }
      if (text !== "A?") return;
      // Registered inside A's prompt, so it reads A's origin when it runs.
      originAfterSettle = settledA.promise.then(() => h.readOrigin());
      h.emitToolStart("edit", { path: "f.ts" });
      h.emitToolStart("edit", { path: "f.ts" });
      // The abort rejected, so nothing stops A's prompt. The admission gives up
      // after its 200ms bound and the queued turn B starts while A still runs.
      await bStarted.promise;
      report.resolve({
        origin: h.readOrigin(),
        crossChannel: await attempt(h.pi, "discord_reply", { channelId: "222", text: "sneak" }),
        ownChannel: await attempt(h.pi, "discord_reply", { channelId: "111", text: "ok on A" }),
      });
    });
    h.client.fire({ id: "mA", channelId: "111", content: "<@1> A?", mentionsBot: true });
    h.client.fire({ id: "mB", channelId: "222", content: "<@1> B?", mentionsBot: true });
    await h.flush();
    const startedWhileAdmitted = [...h.started];
    const r = await report.promise;
    // A's delayed tool still has A's origin, after B started with its own.
    expect(r.origin).toEqual({ kind: "discord", channelId: "111" });
    expect(r.crossChannel).toMatch(/bound to channel 111.*refusing to use channel 222/);
    expect(r.ownChannel).toBe("ok");
    expect(startedWhileAdmitted, "B is queued while A's admission runs").toEqual(["A?"]);
    expect(h.started).toEqual(["A?", "B?"]);
    expect(h.originAtStart[1]).toEqual({ kind: "discord", channelId: "222" });
    expect(h.client.replies).toEqual([{ channelId: "111", text: "ok on A", replyTo: undefined }]);
    expect(h.aborts()).toBe(1);
    expect(
      h.logs.some((m) => m.includes("could not signal the session to stop (abort failed)")),
    ).toBe(true);
    expect(h.logs.some((m) => m.includes("did not settle within 200ms"))).toBe(true);
    expect(
      h.logs.some((m) => m.includes("inbound turn/reply failed") && m.includes("repeated 2 times")),
    ).toBe(true);
    // A's prompt settles: only now is its binding released.
    h.release("A?");
    await h.flush();
    settledA.resolve();
    expect(await originAfterSettle).toEqual({ kind: "run" });
    // B finishes on its own channel.
    h.release("B?");
    await h.flush();
    expect(h.client.replies).toEqual([
      { channelId: "111", text: "ok on A", replyTo: undefined },
      { channelId: "222", text: "B?::answer", replyTo: "mB" },
    ]);
  }, 15_000);

  it("a session with no abort(): a delayed tool keeps the turn's origin until the prompt settles", async () => {
    const h = setupRealAdmission({ toolLoopLimit: 2, abort: "missing" });
    const settledA = deferred();
    let originAfterSettle: Promise<TurnOrigin> | undefined;
    const report = deferred<{ origin: TurnOrigin; crossChannel: string; ownChannel: string }>();
    h.setOnTurn(async (text) => {
      if (text !== "A?") return;
      originAfterSettle = settledA.promise.then(() => h.readOrigin());
      h.emitToolStart("edit", { path: "f.ts" });
      h.emitToolStart("edit", { path: "f.ts" });
      // Nothing can stop the prompt; a tool call runs after the break.
      await new Promise<void>((r) => setTimeout(r, 5));
      report.resolve({
        origin: h.readOrigin(),
        crossChannel: await attempt(h.pi, "discord_reply", { channelId: "222", text: "sneak" }),
        ownChannel: await attempt(h.pi, "discord_reply", { channelId: "111", text: "ok on A" }),
      });
    });
    h.client.fire({ id: "mA", channelId: "111", content: "<@1> A?", mentionsBot: true });
    await h.flush();
    const r = await report.promise;
    expect(r.origin).toEqual({ kind: "discord", channelId: "111" });
    expect(r.crossChannel).toMatch(/bound to channel 111.*refusing to use channel 222/);
    expect(r.ownChannel).toBe("ok");
    expect(h.client.replies).toEqual([{ channelId: "111", text: "ok on A", replyTo: undefined }]);
    expect(
      h.logs.some((m) =>
        m.includes("could not signal the session to stop (the session has no abort())"),
      ),
    ).toBe(true);
    // The prompt settles: the binding is released and the turn is reported failed.
    h.release("A?");
    await h.flush();
    settledA.resolve();
    expect(await originAfterSettle).toEqual({ kind: "run" });
    expect(
      h.logs.some((m) => m.includes("inbound turn/reply failed") && m.includes("repeated 2 times")),
    ).toBe(true);
    expect(h.logs.some((m) => m.includes("did not settle"))).toBe(false);
  }, 15_000);
});

describe("wireDiscordCapability — a turn's tools are bound to its channel (issue #227)", () => {
  it("discord_reply to ANOTHER allow-listed channel during a turn is refused", async () => {
    const { pi, client } = setup();
    client.fire({ id: "mA", channelId: "channel-A", content: "<@1> x", mentionsBot: true });
    // Mid-turn on channel A, the agent tries to post to channel-B (allow-listed).
    await expect(
      pi.call("discord_reply", { channelId: "channel-B", text: "sneak" }),
    ).rejects.toThrow(/bound to channel channel-A.*refusing to use channel channel-B/);
    expect(client.replies).toHaveLength(0);
  });

  it("discord_reply to the turn's OWN channel is allowed", async () => {
    const { pi, client } = setup();
    client.fire({ id: "mA", channelId: "channel-A", content: "<@1> x", mentionsBot: true });
    await pi.call("discord_reply", { channelId: "channel-A", text: "ok" });
    expect(client.replies).toEqual([{ channelId: "channel-A", text: "ok", replyTo: undefined }]);
  });

  it("discord_react to ANOTHER allow-listed channel during a turn is refused", async () => {
    const { pi, client } = setup();
    client.fire({ id: "mA", channelId: "channel-A", content: "<@1> x", mentionsBot: true });
    await expect(
      pi.call("discord_react", { channelId: "channel-B", messageId: "mB", emoji: "✅" }),
    ).rejects.toThrow(/bound to channel channel-A.*refusing to use channel channel-B/);
    expect(client.reactions).toHaveLength(0);
  });

  it("discord_react to the turn's OWN channel is allowed", async () => {
    const { pi, client } = setup();
    client.fire({ id: "mA", channelId: "channel-A", content: "<@1> x", mentionsBot: true });
    await pi.call("discord_react", { channelId: "channel-A", messageId: "mA", emoji: "✅" });
    expect(client.reactions).toEqual([{ channelId: "channel-A", messageId: "mA", emoji: "✅" }]);
  });

  it("outside a turn, discord_react on any allow-listed channel is still allowed", async () => {
    const { pi, client } = setup();
    await pi.call("discord_react", { channelId: "channel-B", messageId: "m9", emoji: "👍" });
    expect(client.reactions).toEqual([{ channelId: "channel-B", messageId: "m9", emoji: "👍" }]);
  });

  it("discord_fetch during a turn cannot read another channel", async () => {
    const { pi, client } = setup();
    client.fire({ id: "mA", channelId: "channel-A", content: "<@1> x", mentionsBot: true });
    client.fetchReturns = [
      {
        id: "b1",
        channelId: "channel-B",
        authorId: "u",
        authorName: "bob",
        content: "secret of B",
        mentionsBot: false,
      },
    ];
    await expect(pi.call("discord_fetch", { channelId: "channel-B" })).rejects.toThrow(
      /bound to channel channel-A.*refusing to use channel channel-B/,
    );
    expect(client.replies).toHaveLength(0);
  });

  it("discord_fetch during a turn reads the turn's OWN channel", async () => {
    const { pi, client } = setup();
    client.fire({ id: "mA", channelId: "channel-A", content: "<@1> x", mentionsBot: true });
    client.fetchReturns = [
      {
        id: "a1",
        channelId: "channel-A",
        authorId: "u",
        authorName: "alice",
        content: "hi from A",
        mentionsBot: false,
      },
    ];
    const res = await pi.call("discord_fetch", { channelId: "channel-A", limit: 5 });
    expect(res.content[0].text).toContain("alice: hi from A");
  });

  it("outside a turn, any allow-listed channel is still allowed (today's behaviour)", async () => {
    const { pi, client } = setup();
    await pi.call("discord_reply", { channelId: "channel-B", text: "ambient" });
    expect(client.replies).toEqual([
      { channelId: "channel-B", text: "ambient", replyTo: undefined },
    ]);
  });

  it("an un-allow-listed channel is still refused first (trust boundary unchanged)", async () => {
    const { pi, client } = setup();
    client.fire({ id: "mA", channelId: "channel-A", content: "<@1> x", mentionsBot: true });
    await expect(pi.call("discord_reply", { channelId: "evil", text: "x" })).rejects.toThrow(
      /not in the configured allow-list/,
    );
    expect(client.replies).toHaveLength(0);
  });

  it("discord_reply's replyTo must belong to the turn's channel (refused otherwise)", async () => {
    const { pi, client } = setup();
    client.fire({ id: "mA", channelId: "channel-A", content: "<@1> x", mentionsBot: true });
    // A message that lives in ANOTHER channel cannot be quote-replied from this turn.
    client.messageChannels.set("mB", "channel-B");
    await expect(
      pi.call("discord_reply", { channelId: "channel-A", text: "x", replyTo: "mB" }),
    ).rejects.toThrow(
      /refusing message mB: it cannot be shown to belong to this turn's channel channel-A/,
    );
    expect(client.replies).toHaveLength(0);
    // A message in the turn's OWN channel is allowed.
    await pi.call("discord_reply", { channelId: "channel-A", text: "ok", replyTo: "mA" });
    expect(client.replies).toEqual([{ channelId: "channel-A", text: "ok", replyTo: "mA" }]);
  });

  it("discord_react's messageId must belong to the turn's channel (refused otherwise)", async () => {
    const { pi, client } = setup();
    client.fire({ id: "mA", channelId: "channel-A", content: "<@1> x", mentionsBot: true });
    client.messageChannels.set("mB", "channel-B");
    await expect(
      pi.call("discord_react", { channelId: "channel-A", messageId: "mB", emoji: "✅" }),
    ).rejects.toThrow(
      /refusing message mB: it cannot be shown to belong to this turn's channel channel-A/,
    );
    expect(client.reactions).toHaveLength(0);
  });

  it("a MAIL turn cannot use the discord tools (a non-chat origin is refused, not allowed)", async () => {
    const { pi, client } = setup();
    // A mail turn's origin is not a chat surface, so the turn guard refuses it
    // rather than defaulting to allow. (The mail-turn tool allowlist also
    // excludes these tools; this pins the guard independent of that.)
    pi.currentOrigin = { kind: "mail", from: "flint" };
    await expect(pi.call("discord_reply", { channelId: "channel-A", text: "x" })).rejects.toThrow(
      /from a mail turn: only a discord turn may act on a channel/,
    );
    await expect(pi.call("discord_fetch", { channelId: "channel-A" })).rejects.toThrow(
      /from a mail turn/,
    );
    expect(client.replies).toHaveLength(0);
  });
});

describe("wireDiscordCapability — the turn identity's DM projection (issue #227)", () => {
  it("a message with no guildId is a DM; with a guildId it is not", () => {
    const base = {
      id: "m1",
      channelId: "1",
      authorId: "u",
      authorName: "n",
      content: "x",
      mentionsBot: false,
    };
    expect(createDiscordTurn(base).isDM).toBe(true);
    expect(createDiscordTurn({ ...base, guildId: "9" }).isDM).toBe(false);
  });
});

describe("wireDiscordCapability — typing indicator spans the turn", () => {
  it("starts typing on the originating channel the moment the message is dispatched", () => {
    const { client } = setup();
    client.fire({ id: "m1", channelId: "channel-B", content: "<@1> think", mentionsBot: true });
    // Immediately — not one interval later. The wait starts at dispatch.
    expect(client.typings).toEqual(["channel-B"]);
  });

  it("REPEATS while the turn is in flight (Discord expires the indicator after ~10s)", async () => {
    const { client } = setup({}, { typingIntervalMs: 10 });
    client.fire({ id: "m1", channelId: "channel-A", content: "<@1> slow one", mentionsBot: true });
    await sleep(60);
    // Immediate pulse + repeats. A single call would leave exactly 1.
    expect(client.typings.length).toBeGreaterThanOrEqual(3);
    expect(new Set(client.typings)).toEqual(new Set(["channel-A"]));
  });

  it("STOPS once the turn completes — no pulses after the reply lands", async () => {
    const { pi, client } = setup({}, { typingIntervalMs: 10 });
    client.fire({ id: "m1", channelId: "channel-A", content: "<@1> hi", mentionsBot: true });
    await sleep(35);
    await pi.finishTurn("done");
    const atCompletion = client.typings.length;
    await sleep(60); // several intervals' worth of quiet
    expect(client.typings.length).toBe(atCompletion);
    expect(client.replies).toHaveLength(1);
  });

  it("STOPS when the turn ends with a throw — the indicator can't outlive a failure", async () => {
    const { pi, client } = setup({}, { typingIntervalMs: 10 });
    client.replyThrows = true; // the reply post blows up inside agent_end
    client.fire({ id: "m1", channelId: "channel-A", content: "<@1> hi", mentionsBot: true });
    await sleep(35);
    await pi.finishTurn("this post will fail");
    const atCompletion = client.typings.length;
    await sleep(60);
    expect(client.typings.length).toBe(atCompletion);
    expect(client.replies).toHaveLength(0); // proof the throw path really ran
  });

  it("STOPS on a tool-only turn (no assistant text — the early return still clears it)", async () => {
    const { pi, client } = setup({}, { typingIntervalMs: 10 });
    client.fire({ id: "m1", channelId: "channel-A", content: "<@1> react", mentionsBot: true });
    await sleep(35);
    await pi.finishTurn(undefined);
    const atCompletion = client.typings.length;
    await sleep(60);
    expect(client.typings.length).toBe(atCompletion);
  });

  it("a FAILING typing request never breaks the reply path (cosmetic, swallowed)", async () => {
    const { pi, client, logs } = setup({}, { typingIntervalMs: 10 });
    client.typingThrows = true;
    expect(() => {
      client.fire({ id: "m1", channelId: "channel-A", content: "<@1> hi", mentionsBot: true });
    }).not.toThrow();
    await sleep(25);
    await pi.finishTurn("still replied");
    expect(client.replies).toEqual([
      { channelId: "channel-A", text: "still replied", replyTo: "m1" },
    ]);
    expect(logs.some((l) => /typing indicator failed for channel-A/.test(l))).toBe(true);
  });

  it("does NOT type for a message the allow-list or mention filter drops", () => {
    const { client } = setup();
    client.fire({ channelId: "not-listed", content: "<@1> hi", mentionsBot: true });
    client.fire({ channelId: "channel-A", content: "ambient chatter", mentionsBot: false });
    client.fire({ channelId: "channel-A", content: "<@1>", mentionsBot: true }); // empty after strip
    expect(client.typings).toHaveLength(0);
  });

  it("each inbound admission owns its reply and heartbeat", async () => {
    const { pi, client } = setup({}, { typingIntervalMs: 10 });
    client.fire({ id: "m1", channelId: "channel-A", content: "first", mentionsBot: true });
    client.fire({ id: "m2", channelId: "channel-B", content: "second", mentionsBot: true });
    await pi.finishTurn("first reply");
    const afterFirst = client.typings.length;
    await sleep(35);
    expect(client.typings.slice(afterFirst).every((c) => c === "channel-B")).toBe(true);
    await pi.finishTurn("second reply");
    expect(client.replies).toEqual([
      { channelId: "channel-A", text: "first reply", replyTo: "m1" },
      { channelId: "channel-B", text: "second reply", replyTo: "m2" },
    ]);
    const afterBoth = client.typings.length;
    await sleep(30);
    expect(client.typings.length).toBe(afterBoth);
  });

  it("stop() (shutdown/disconnect) clears a heartbeat that is still running", async () => {
    const { client, wired } = setup({}, { typingIntervalMs: 10 });
    client.fire({ id: "m1", channelId: "channel-A", content: "<@1> hi", mentionsBot: true });
    await sleep(25);
    await wired.stop(); // no agent_end — shutdown mid-turn
    const atShutdown = client.typings.length;
    await sleep(60);
    expect(client.typings.length).toBe(atShutdown);
    expect(client.disconnectCalled).toBe(true);
  });

  it("does not type for a self-directed turn (cron/heartbeat prompt, no inbound message)", async () => {
    const { pi, client } = setup({}, { typingIntervalMs: 10 });
    await pi.finishTurn("internal monologue");
    await sleep(30);
    expect(client.typings).toHaveLength(0);
  });
});

describe("wireDiscordCapability — 429 surfacing + lifecycle", () => {
  it("logs a provider 429 with retry-after via after_provider_response", () => {
    const { pi, logs } = setup();
    pi.rateHandler?.({ status: 429, headers: { "retry-after": "7" } });
    expect(logs.some((l) => /429/.test(l) && /7/.test(l))).toBe(true);
  });

  it("does not log on a 200", () => {
    const { pi, logs } = setup();
    pi.rateHandler?.({ status: 200, headers: {} });
    expect(logs).toHaveLength(0);
  });

  it("start() connects + stop() disconnects the gateway", async () => {
    const { client, wired } = setup();
    await wired.start();
    expect(client.connectCalled).toBe(true);
    await wired.stop();
    expect(client.disconnectCalled).toBe(true);
  });

  it("start() rejects when the gateway connect hangs (timeout)", async () => {
    const pi = new FakePi();
    const client = new FakeDiscordClient();
    client.connectHangs = true;
    const config: DiscordCapabilityConfig = {
      tokenFile: "/s",
      channelIds: ["c"],
      dispatchAll: false,
    };
    const wired = wireDiscordCapability({
      pi,
      admitTurn: pi.admitTurn,
      client,
      config,
      log: () => {},
      connectTimeoutMs: 20,
    });
    await expect(wired.start()).rejects.toThrow(/timed out/);
  });

  it("start() resolves normally when connect is fast (timeout not hit)", async () => {
    const pi = new FakePi();
    const client = new FakeDiscordClient();
    const config: DiscordCapabilityConfig = {
      tokenFile: "/s",
      channelIds: ["c"],
      dispatchAll: false,
    };
    const wired = wireDiscordCapability({
      pi,
      admitTurn: pi.admitTurn,
      client,
      config,
      log: () => {},
      connectTimeoutMs: 5000,
    });
    await wired.start();
    expect(client.connectCalled).toBe(true);
  });
});

describe("wireDiscordCapability — secret hygiene", () => {
  it("never surfaces the token (config carries only a file path)", async () => {
    // The whole config + every tool result + every log line is scanned for a
    // canary. The token never enters this core (it lives in the client), so it
    // cannot leak through tools/logs/transcript.
    const { pi, client, logs, config } = setup();
    const canary = "tok_LEAK_CANARY_999";
    // Drive every surface.
    client.fire({ channelId: "channel-A", content: "<@1> hi", mentionsBot: true });
    const r1 = await pi.call("discord_reply", { channelId: "channel-A", text: "ok" });
    pi.rateHandler?.({ status: 429, headers: { "retry-after": "1" } });
    const haystack = JSON.stringify({
      config,
      tools: [...pi.tools.keys()],
      userMessages: pi.userMessages,
      replies: client.replies,
      logs,
      r1,
    });
    expect(haystack).not.toContain(canary);
    // tokenFile is a PATH, not the token.
    expect(config.tokenFile).toBe("/secrets/bot.token");
  });
});

describe("wireDiscordCapability — a failed admitted turn", () => {
  it("signals the failure and sends no reply when an admitted turn is exhausted (reasoning-only)", async () => {
    const pi = new FakePi();
    const client = new FakeDiscordClient();
    const logs: string[] = [];
    wireDiscordCapability({
      pi,
      admitTurn: async () => {
        throw new ReasoningOnlyExhaustedError(3);
      },
      readOrigin: pi.readOrigin,
      client,
      config: { tokenFile: "/secrets/bot.token", channelIds: ["channel-A"], dispatchAll: false },
      log: (m) => logs.push(m),
    });
    client.fire({ channelId: "channel-A", content: "<@1> hi", mentionsBot: true });
    await sleep(10);
    expect(
      logs.some((l) => l.includes("inbound turn/reply failed") && l.includes("reasoning only")),
    ).toBe(true);
    expect(client.replies).toHaveLength(0);
  }, 10_000);
});
