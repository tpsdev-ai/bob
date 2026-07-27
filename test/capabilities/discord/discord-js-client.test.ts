import { describe, expect, it } from "bun:test";
import {
  DiscordJsClient,
  shouldProcessMessage,
} from "../../../src/capabilities/discord/discord-js-client.js";

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
    expect(typeof client.sendTyping).toBe("function");
  });

  it("registers a message handler without throwing", () => {
    const client = new DiscordJsClient({ token: "fake", botUserId: "12345" });
    expect(() => {
      client.on("message", () => {});
    }).not.toThrow();
  });
});

describe("outbound via REST (no gateway / login)", () => {
  interface RestCall {
    method: string;
    route: string;
    options?: { body?: Record<string, unknown>; query?: URLSearchParams };
  }
  // Stub the underlying discord.js client's REST manager (the only thing
  // outbound touches now — no channels.fetch, no login). GET returns raw API
  // messages (snake_case + a mentions ARRAY, as the real REST endpoint does).
  function stubRest(client: DiscordJsClient): RestCall[] {
    const calls: RestCall[] = [];
    const rec =
      (method: string) =>
      async (route: string, options?: RestCall["options"]): Promise<unknown> => {
        calls.push({ method, route, options });
        if (method !== "get") return undefined;
        return [
          {
            id: "m1",
            channel_id: "chan-1",
            author: { id: "111", username: "alice" },
            content: "hi",
            mentions: [{ id: "999" }],
          },
          {
            id: "m2",
            channel_id: "chan-1",
            author: { id: "222", username: "bobby" },
            content: "yo",
            mentions: [],
          },
        ];
      };
    // biome-ignore lint/suspicious/noExplicitAny: test stub for a private field
    (client as any).client = { rest: { post: rec("post"), put: rec("put"), get: rec("get") } };
    return calls;
  }

  it("reply POSTs to the channel-messages route with content + reply reference", async () => {
    const client = new DiscordJsClient({ token: "fake", botUserId: "999" });
    const calls = stubRest(client);
    await client.reply("chan-1", "hello", { replyTo: "m9" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("post");
    expect(calls[0]?.route).toContain("chan-1");
    expect(calls[0]?.options?.body?.content).toBe("hello");
    expect((calls[0]?.options?.body?.message_reference as { message_id: string })?.message_id).toBe(
      "m9",
    );
  });

  it("reply omits the reference when there's no replyTo", async () => {
    const client = new DiscordJsClient({ token: "fake", botUserId: "999" });
    const calls = stubRest(client);
    await client.reply("chan-1", "plain");
    expect(calls[0]?.options?.body?.message_reference).toBeUndefined();
  });

  it("react PUTs the own-reaction route with the URL-encoded emoji", async () => {
    const client = new DiscordJsClient({ token: "fake", botUserId: "999" });
    const calls = stubRest(client);
    await client.react("chan-1", "m9", "✅");
    expect(calls[0]?.method).toBe("put");
    expect(calls[0]?.route).toContain("chan-1");
    expect(calls[0]?.route).toContain(encodeURIComponent("✅"));
  });

  it("sendTyping POSTs the channel-typing route with no body", async () => {
    const client = new DiscordJsClient({ token: "fake", botUserId: "999" });
    const calls = stubRest(client);
    await client.sendTyping("chan-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("post");
    expect(calls[0]?.route).toBe("/channels/chan-1/typing");
    expect(calls[0]?.options).toBeUndefined();
  });

  it("fetchRecent maps raw API messages (snake_case + mentions array → mentionsBot)", async () => {
    const client = new DiscordJsClient({ token: "fake", botUserId: "999" });
    stubRest(client);
    const out = await client.fetchRecent("chan-1", 10);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(out[0]).toEqual({
      id: "m1",
      channelId: "chan-1",
      authorId: "111",
      authorName: "alice",
      content: "hi",
      mentionsBot: true, // botUserId 999 is in m1's mentions
    });
    expect(out[1]?.mentionsBot).toBe(false); // 999 not in m2's mentions
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
