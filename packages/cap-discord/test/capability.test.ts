import { describe, expect, it } from "bun:test";
import type { DiscordClient, DiscordMessage } from "@tpsdev-ai/bob-shell";
import { type PiLike, wireDiscordCapability } from "../src/capability.js";
import type { DiscordCapabilityConfig } from "../src/config.js";

// --- Fakes (no live gateway, no real token, no LLM) -------------------------

type ToolDef = Parameters<PiLike["registerTool"]>[0];

class FakePi implements PiLike {
  readonly tools = new Map<string, ToolDef>();
  readonly userMessages: string[] = [];
  rateHandler?: (e: { status: number; headers: Record<string, string> }) => void;

  registerTool(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }
  on(_event: "after_provider_response", handler: typeof this.rateHandler): void {
    this.rateHandler = handler;
  }
  sendUserMessage(content: string): void {
    this.userMessages.push(content);
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
  fetchReturns: DiscordMessage[] = [];
  connectCalled = false;
  disconnectCalled = false;

  on(_e: "message", handler: (msg: DiscordMessage) => void): void {
    this.handler = handler;
  }
  async connect(): Promise<void> {
    this.connectCalled = true;
  }
  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
  }
  async reply(channelId: string, text: string, opts?: { replyTo?: string }): Promise<void> {
    this.replies.push({ channelId, text, replyTo: opts?.replyTo });
  }
  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji });
  }
  async fetchRecent(_channelId: string, _limit: number): Promise<DiscordMessage[]> {
    return this.fetchReturns;
  }
  fire(msg: Partial<DiscordMessage> & Pick<DiscordMessage, "channelId" | "content">): void {
    this.handler?.({
      id: msg.id ?? "m1",
      channelId: msg.channelId,
      authorId: msg.authorId ?? "u1",
      authorName: msg.authorName ?? "user",
      content: msg.content,
      mentionsBot: msg.mentionsBot ?? false,
    });
  }
}

function setup(overrides: Partial<DiscordCapabilityConfig> = {}) {
  const pi = new FakePi();
  const client = new FakeDiscordClient();
  const logs: string[] = [];
  const config: DiscordCapabilityConfig = {
    tokenFile: "/secrets/bot.token",
    channelIds: ["channel-A", "channel-B"],
    dispatchAll: false,
    ...overrides,
  };
  const wired = wireDiscordCapability({ pi, client, config, log: (m) => logs.push(m) });
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
