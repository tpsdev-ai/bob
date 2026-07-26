// Discord client + message interfaces — the seam between Bob and discord.js.
//
// These two types are the contract the discord.js binding (@tpsdev-ai/bob-discord
// DiscordJsClient) implements and the discord capability (@tpsdev-ai/bob-cap-discord)
// consumes. They live here (not in a serve module) so they survive the PR4
// cleanup that removed the per-message subprocess path (discord-serve.ts) and
// the DiscordBridge class — those were superseded by the persistent runtime +
// the discord capability, but the client/message shapes are still load-bearing.
//
// Built around an injected interface so callers (and tests) stay dep-free:
// bob-shell stays importable without discord.js for agents that don't need it.

export interface DiscordMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  // True if this message mentioned the agent (bot). The capability filters
  // these vs. ambient channel chatter unless dispatchAll is set.
  mentionsBot: boolean;
}

export interface DiscordClient {
  on(event: "message", handler: (msg: DiscordMessage) => void): void;
  reply(channelId: string, text: string, opts?: { replyTo?: string }): Promise<void>;
  // Add an emoji reaction to a message. `emoji` is a unicode emoji
  // (e.g. "✅") or a custom-emoji identifier ("name:id"). Used by the
  // discord capability's `discord_react` tool.
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  // Fetch the most recent messages on a channel (newest first, capped by
  // `limit`). Used by the discord capability's `discord_fetch` tool so the
  // agent can read recent context without an inbound event. Does not include
  // the bot filtering the gateway listener applies — it's a raw read.
  fetchRecent(channelId: string, limit: number): Promise<DiscordMessage[]>;
  // Fire the "<bot> is typing…" affordance on a channel — the signal that the
  // agent picked the message up and is working on it.
  //
  // This is a PULSE, not a switch. Discord displays the indicator for about ten
  // seconds and there is no "stop typing" endpoint: it expires on its own, and
  // posting a message clears it immediately. A caller that wants it visible for
  // a whole agent turn must therefore re-fire on a cadence — see the typing
  // heartbeat in @tpsdev-ai/bob-cap-discord.
  //
  // Cosmetic by contract: callers treat a rejection as a non-event (the reply
  // still has to go out), so implementations need not be more reliable than the
  // underlying REST call.
  sendTyping(channelId: string): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
