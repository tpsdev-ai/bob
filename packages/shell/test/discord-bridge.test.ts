import { describe, it, expect, beforeEach } from "bun:test";
import { DiscordBridge, type DiscordClient, type DiscordMessage } from "../src/discord-bridge.js";

interface ReplyRecord {
  channelId: string;
  text: string;
  replyTo?: string;
}

class StubClient implements DiscordClient {
  private handler?: (msg: DiscordMessage) => void;
  connected = false;
  disconnected = false;
  replies: ReplyRecord[] = [];

  on(_event: "message", handler: (msg: DiscordMessage) => void): void {
    this.handler = handler;
  }
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.disconnected = true; }
  async reply(channelId: string, text: string, opts?: { replyTo?: string }): Promise<void> {
    this.replies.push({ channelId, text, replyTo: opts?.replyTo });
  }
  // Test helper — simulate a Discord message arrival.
  emit(msg: DiscordMessage): void {
    this.handler?.(msg);
  }
}

const baseMsg = (overrides: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id: "m1",
  channelId: "channel-A",
  authorId: "user-1",
  authorName: "skewed",
  content: "hello agent",
  mentionsBot: true,
  ...overrides,
});

describe("DiscordBridge", () => {
  let client: StubClient;

  beforeEach(() => {
    client = new StubClient();
  });

  it("rejects an empty listenChannelIds", () => {
    expect(() => new DiscordBridge({
      listenChannelIds: [],
      client,
      dispatch: async () => undefined,
    })).toThrow(/listenChannelIds/);
  });

  it("connects + disconnects via the client", async () => {
    const bridge = new DiscordBridge({
      listenChannelIds: ["channel-A"],
      client,
      dispatch: async () => undefined,
    });
    await bridge.start();
    expect(client.connected).toBe(true);
    await bridge.stop();
    expect(client.disconnected).toBe(true);
  });

  it("dispatches a bot-mention on a listened channel and posts the reply", async () => {
    const seen: DiscordMessage[] = [];
    const bridge = new DiscordBridge({
      listenChannelIds: ["channel-A"],
      client,
      dispatch: async (msg) => {
        seen.push(msg);
        return `re: ${msg.content}`;
      },
    });
    await bridge.start();
    await bridge.handle(baseMsg({ id: "m-test" }));

    expect(seen).toHaveLength(1);
    expect(client.replies).toHaveLength(1);
    expect(client.replies[0]).toMatchObject({
      channelId: "channel-A",
      text: "re: hello agent",
      replyTo: "m-test",
    });
    expect(bridge.stats.dispatched).toBe(1);
    expect(bridge.stats.replied).toBe(1);
  });

  it("ignores messages on unlistened channels", async () => {
    const seen: DiscordMessage[] = [];
    const bridge = new DiscordBridge({
      listenChannelIds: ["channel-A"],
      client,
      dispatch: async (msg) => { seen.push(msg); return undefined; },
    });
    await bridge.start();
    await bridge.handle(baseMsg({ channelId: "channel-OTHER" }));
    expect(seen).toHaveLength(0);
    expect(bridge.stats.received).toBe(1);
    expect(bridge.stats.dispatched).toBe(0);
  });

  it("ignores non-mention messages by default", async () => {
    const seen: DiscordMessage[] = [];
    const bridge = new DiscordBridge({
      listenChannelIds: ["channel-A"],
      client,
      dispatch: async (msg) => { seen.push(msg); return undefined; },
    });
    await bridge.start();
    await bridge.handle(baseMsg({ mentionsBot: false }));
    expect(seen).toHaveLength(0);
    expect(bridge.stats.dispatched).toBe(0);
  });

  it("dispatchAll=true picks up ambient chatter too", async () => {
    const seen: DiscordMessage[] = [];
    const bridge = new DiscordBridge({
      listenChannelIds: ["channel-A"],
      dispatchAll: true,
      client,
      dispatch: async (msg) => { seen.push(msg); return undefined; },
    });
    await bridge.start();
    await bridge.handle(baseMsg({ mentionsBot: false }));
    expect(seen).toHaveLength(1);
  });

  it("dispatch returning undefined suppresses the reply", async () => {
    const bridge = new DiscordBridge({
      listenChannelIds: ["channel-A"],
      client,
      dispatch: async () => undefined,
    });
    await bridge.start();
    await bridge.handle(baseMsg());
    expect(client.replies).toHaveLength(0);
    expect(bridge.stats.replied).toBe(0);
    expect(bridge.stats.dispatched).toBe(1);
  });

  it("counts errors in stats but doesn't throw out of handle()", async () => {
    const bridge = new DiscordBridge({
      listenChannelIds: ["channel-A"],
      client,
      dispatch: async () => { throw new Error("boom"); },
    });
    await bridge.start();
    // handle() should propagate the error; the on('message') wrapper catches it.
    // Simulate the wrapper path by emitting via the client's on-handler.
    client.emit(baseMsg());
    // Microtask flush
    await new Promise((r) => setImmediate(r));
    expect(bridge.stats.errors).toBeGreaterThan(0);
    // Bridge still operational
    expect(client.connected).toBe(true);
  });
});
