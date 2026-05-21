import { describe, it, expect } from "bun:test";
import { DiscordJsClient } from "../src/index.js";

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
