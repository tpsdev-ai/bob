import { describe, expect, it } from "bun:test";
import { DiscordJsClient, shouldProcessMessage } from "../src/index.js";

// PR-6 keeps tests light — discord.js requires a real WS connection
// to exercise the message-create path, so we limit unit coverage to
// construction + interface conformance. End-to-end validation lives in
// the Pulse-EA bring-up integration test (PR-8).

describe("DiscordJsClient", () => {
  it("can be constructed with a token", () => {
    const client = new DiscordJsClient({ token: "fake-token", botUserId: "12345" });
    expect(client).toBeDefined();
  });

  it("implements the DiscordClient interface shape", () => {
    const client = new DiscordJsClient({ token: "fake", botUserId: "12345" });
    expect(typeof client.on).toBe("function");
    expect(typeof client.connect).toBe("function");
    expect(typeof client.disconnect).toBe("function");
    expect(typeof client.reply).toBe("function");
  });

  it("registers a message handler without throwing", () => {
    const client = new DiscordJsClient({ token: "fake", botUserId: "12345" });
    expect(() => {
      client.on("message", () => {});
    }).not.toThrow();
  });
});

describe("fetchRecent", () => {
  // discord.js `messages.fetch` resolves a Collection (a Map subclass) keyed by
  // snowflake. The bug iterated the Collection directly (`for…of`), yielding
  // [key, Message] PAIRS, so `m.author.id` threw. This reproduces that shape
  // with a plain Map and asserts we iterate `.values()`.
  function fakeMessage(id: string, authorId: string, content: string) {
    return {
      id,
      channelId: "chan-1",
      author: { id: authorId, username: `u-${authorId}` },
      content,
      mentions: { users: new Map<string, unknown>([["999", {}]]) },
    };
  }

  it("maps a Collection of messages, iterating values not [key,value] entries", async () => {
    const client = new DiscordJsClient({ token: "fake", botUserId: "999" });
    const collection = new Map<string, unknown>([
      ["m1", fakeMessage("m1", "111", "hello")],
      ["m2", fakeMessage("m2", "999", "self")],
    ]);
    // Stub the underlying discord.js client so requireTextChannel + fetch resolve.
    // biome-ignore lint/suspicious/noExplicitAny: test stub for a private field
    (client as any).client = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: () => undefined,
          messages: { fetch: async () => collection },
        }),
      },
    };

    const out = await client.fetchRecent("chan-1", 10);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(out[0]?.authorId).toBe("111");
    expect(out[1]?.mentionsBot).toBe(true); // mentions.users carries botUserId 999
  });
});

describe("shouldProcessMessage", () => {
  const own = "1472671820091232491"; // the agent's own bot id

  it("skips the agent's own messages (self-loop guard)", () => {
    expect(shouldProcessMessage(own, own)).toBe(false);
  });

  it("processes messages from a human", () => {
    expect(shouldProcessMessage("284437008405757953", own)).toBe(true);
  });

  it("processes messages from OTHER bots/agents (EA must hear hand-offs)", () => {
    expect(shouldProcessMessage("1472818438786383993", own)).toBe(true);
  });

  it("processes everything until our own id resolves (post-READY in practice)", () => {
    expect(shouldProcessMessage(own, undefined)).toBe(true);
  });
});
