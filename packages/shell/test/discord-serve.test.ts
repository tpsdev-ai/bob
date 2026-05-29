import { describe, expect, it } from "bun:test";
import type { DiscordClient, DiscordMessage } from "../src/discord-bridge.js";
import { startDiscordListener } from "../src/discord-serve.js";
import type { RunOptions, RunResult } from "../src/run.js";

// Fake DiscordClient that we drive synchronously from tests. Captures
// replies for assertion + lets us pipe in messages via fire().
class FakeDiscordClient implements DiscordClient {
  private handler?: (msg: DiscordMessage) => void;
  readonly replies: Array<{ channelId: string; text: string; replyTo?: string }> = [];
  connectCalled = false;
  disconnectCalled = false;

  on(_event: "message", handler: (msg: DiscordMessage) => void): void {
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
  async react(_channelId: string, _messageId: string, _emoji: string): Promise<void> {
    // discord-serve (the superseded per-message path) never reacts; satisfy
    // the interface so this fake still type-checks after the capability work
    // extended DiscordClient with react/fetchRecent.
  }
  async fetchRecent(_channelId: string, _limit: number): Promise<DiscordMessage[]> {
    return [];
  }
  // Test driver
  async fire(msg: Partial<DiscordMessage> & Pick<DiscordMessage, "channelId" | "content">) {
    const full: DiscordMessage = {
      id: msg.id ?? "m1",
      channelId: msg.channelId,
      authorId: msg.authorId ?? "user-123",
      authorName: msg.authorName ?? "user",
      content: msg.content,
      mentionsBot: msg.mentionsBot ?? false,
    };
    this.handler?.(full);
    // Let async dispatch settle
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("startDiscordListener", () => {
  const baseOpts = (overrides: Partial<Parameters<typeof startDiscordListener>[0]> = {}) => {
    const client = new FakeDiscordClient();
    const runCalls: RunOptions[] = [];
    const runFn = async (opts: RunOptions): Promise<RunResult> => {
      runCalls.push(opts);
      return { exitCode: 0, launcherPath: "/fake/launcher", args: [] };
    };
    return {
      args: {
        agentName: "testbot",
        listenChannelIds: ["channel-A"],
        client,
        runFn,
        captureOutput: async () => "the agent's reply",
        ...overrides,
      },
      client,
      runCalls,
    };
  };

  it("connects the client on start", async () => {
    const { args, client } = baseOpts();
    await startDiscordListener(args);
    expect(client.connectCalled).toBe(true);
  });

  it("dispatches to runAgent and replies for bot-mentions on listened channels", async () => {
    const { args, client, runCalls } = baseOpts();
    await startDiscordListener(args);
    await client.fire({
      channelId: "channel-A",
      content: "<@123456> what's the brief?",
      mentionsBot: true,
    });
    expect(runCalls.length).toBe(1);
    // Verifies the @-mention prefix is stripped before being sent to the agent.
    expect(runCalls[0].prompt).toBe("what's the brief?");
    expect(runCalls[0].name).toBe("testbot");
    expect(client.replies.length).toBe(1);
    expect(client.replies[0].text).toBe("the agent's reply");
    expect(client.replies[0].replyTo).toBe("m1");
  });

  it("ignores messages on un-listened channels", async () => {
    const { args, client, runCalls } = baseOpts();
    await startDiscordListener(args);
    await client.fire({
      channelId: "channel-X-not-listed",
      content: "<@123456> hello",
      mentionsBot: true,
    });
    expect(runCalls.length).toBe(0);
    expect(client.replies.length).toBe(0);
  });

  it("ignores non-mention messages by default (dispatchAll=false)", async () => {
    const { args, client, runCalls } = baseOpts();
    await startDiscordListener(args);
    await client.fire({
      channelId: "channel-A",
      content: "ambient chatter",
      mentionsBot: false,
    });
    expect(runCalls.length).toBe(0);
  });

  it("dispatches everything when dispatchAll=true", async () => {
    const { args, client, runCalls } = baseOpts({ dispatchAll: true });
    await startDiscordListener(args);
    await client.fire({
      channelId: "channel-A",
      content: "ambient chatter",
      mentionsBot: false,
    });
    expect(runCalls.length).toBe(1);
    expect(runCalls[0].prompt).toBe("ambient chatter");
  });

  it("passes through the model override when set", async () => {
    const { args, client, runCalls } = baseOpts({ model: "claude-sonnet-4-6" });
    await startDiscordListener(args);
    await client.fire({
      channelId: "channel-A",
      content: "<@123> hi",
      mentionsBot: true,
    });
    expect(runCalls[0].model).toBe("claude-sonnet-4-6");
  });

  it("uses defaultCaptureOutput when captureOutput is omitted — replies from result.stdout", async () => {
    const runFn = async (_opts: RunOptions): Promise<RunResult> => ({
      exitCode: 0,
      launcherPath: "/fake",
      args: [],
      stdout: "the agent's reply from stdout\n",
    });
    const { args, client } = baseOpts({ captureOutput: undefined, runFn });
    await startDiscordListener(args);
    await client.fire({
      channelId: "channel-A",
      content: "<@123> hi",
      mentionsBot: true,
    });
    expect(client.replies.length).toBe(1);
    expect(client.replies[0].text).toBe("the agent's reply from stdout");
  });

  it("requests captureStdout when dispatching to runAgent", async () => {
    const { args, client, runCalls } = baseOpts();
    await startDiscordListener(args);
    await client.fire({
      channelId: "channel-A",
      content: "<@123> hi",
      mentionsBot: true,
    });
    expect(runCalls[0].captureStdout).toBe(true);
  });

  it("suppresses reply when defaultCaptureOutput sees empty stdout", async () => {
    const runFn = async (): Promise<RunResult> => ({
      exitCode: 0,
      launcherPath: "/fake",
      args: [],
      stdout: "",
    });
    const { args, client } = baseOpts({ captureOutput: undefined, runFn });
    await startDiscordListener(args);
    await client.fire({
      channelId: "channel-A",
      content: "<@123> hi",
      mentionsBot: true,
    });
    expect(client.replies.length).toBe(0);
  });

  it("posts a session-failure marker when runAgent exits non-zero", async () => {
    const failingRun = async (): Promise<RunResult> => ({
      exitCode: 42,
      launcherPath: "/fake",
      args: [],
    });
    const { args, client } = baseOpts({ runFn: failingRun });
    await startDiscordListener(args);
    await client.fire({
      channelId: "channel-A",
      content: "<@123> hi",
      mentionsBot: true,
    });
    expect(client.replies.length).toBe(1);
    expect(client.replies[0].text).toMatch(/exited with code 42/);
  });
});
