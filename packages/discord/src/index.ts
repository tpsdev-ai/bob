// discord.js binding for bob-shell's DiscordClient interface.
//
// Importing this package pulls discord.js (~30MB of WS + REST). Agents
// that don't need Discord shouldn't depend on this package — keep the
// shell-only install slim.

import type { DiscordClient, DiscordMessage } from "@tpsdev-ai/bob-shell";
import { Client, Events, GatewayIntentBits, type Message, type TextBasedChannel } from "discord.js";

// All REST/gateway traffic flows through discord.js, which sends a correct
// `User-Agent` (`DiscordBot (https://discord.js.org, <ver>)`) and honors the
// `Retry-After` header on 429 by default (see @discordjs/rest RequestManager:
// it reads `Retry-After`, sleeps, and retries). The discord capability relies
// on that — the failed `bin/post-discord` curl sent NO User-Agent and ignored
// `retry-after`, which fed the Cloudflare-1015 class. Do NOT introduce a raw
// fetch on this path; keep everything on the client so that hygiene holds.

export interface DiscordJsClientOptions {
  // Bot token. Read from a secret file in production; passed inline in
  // tests is OK.
  token: string;
  // The bot's user ID. Needed to determine whether a message
  // @-mentioned us. If unset, we accept anything that contains the
  // configured bot's user ID once the gateway READY event arrives.
  botUserId?: string;
}

// Whether the gateway listener should process an inbound message. We skip ONLY
// the agent's OWN messages (self-loop guard), keyed on the resolved bot user id.
// We deliberately do NOT skip all bots: an EA like Pulse must hear hand-offs
// from the other TPS agents (Flint/Anvil), and the reply routes back as a
// quote-reply — never an @mention — so there is no bot↔bot mention loop. Until
// the gateway READY event resolves our own id, ownBotId is undefined and we let
// the message through (messages only arrive post-READY in practice, so the id
// is set by then; this just keeps the predicate total).
export function shouldProcessMessage(authorId: string, ownBotId: string | undefined): boolean {
  return !ownBotId || authorId !== ownBotId;
}

export class DiscordJsClient implements DiscordClient {
  private readonly client: Client;
  private readonly token: string;
  private resolvedBotUserId?: string;
  private messageHandler?: (msg: DiscordMessage) => void;

  constructor(opts: DiscordJsClientOptions) {
    this.token = opts.token;
    this.resolvedBotUserId = opts.botUserId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on(Events.ClientReady, (c) => {
      // Pin the bot user ID for mention detection once the gateway is live.
      this.resolvedBotUserId ??= c.user.id;
    });

    this.client.on(Events.MessageCreate, (m: Message) => {
      if (!this.messageHandler) return;
      // Skip ONLY our own messages (self-loop guard) — NOT all bots. See
      // shouldProcessMessage: other agents must be able to reach the EA.
      if (!shouldProcessMessage(m.author.id, this.resolvedBotUserId)) return;
      const mentionsBot = this.resolvedBotUserId
        ? m.mentions.users.has(this.resolvedBotUserId)
        : false;
      this.messageHandler({
        id: m.id,
        channelId: m.channelId,
        authorId: m.author.id,
        authorName: m.author.username,
        content: m.content,
        mentionsBot,
      });
    });
  }

  on(_event: "message", handler: (msg: DiscordMessage) => void): void {
    this.messageHandler = handler;
  }

  async connect(): Promise<void> {
    await this.client.login(this.token);
  }

  async disconnect(): Promise<void> {
    await this.client.destroy();
  }

  async reply(channelId: string, text: string, opts?: { replyTo?: string }): Promise<void> {
    const channel = await this.requireTextChannel(channelId);
    await (channel as unknown as { send: (payload: unknown) => Promise<unknown> }).send({
      content: text,
      reply: opts?.replyTo ? { messageReference: opts.replyTo } : undefined,
    });
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.requireTextChannel(channelId);
    // channel.messages.react goes through discord.js REST (correct UA +
    // retry-after). emoji is a unicode glyph or a "name:id" custom-emoji ref.
    await (
      channel as unknown as {
        messages: { react: (m: string, e: string) => Promise<unknown> };
      }
    ).messages.react(messageId, emoji);
  }

  async fetchRecent(channelId: string, limit: number): Promise<DiscordMessage[]> {
    const channel = await this.requireTextChannel(channelId);
    // discord.js `messages.fetch` returns a Collection (a Map subclass). A bare
    // `for…of` over a Map yields [key, value] PAIRS, not Message objects — so
    // reading `m.author.id` threw "Cannot read properties of undefined
    // (reading 'id')". Iterate `.values()` to get the Messages themselves.
    const collection = await (
      channel as unknown as {
        messages: { fetch: (o: { limit: number }) => Promise<{ values(): Iterable<Message> }> };
      }
    ).messages.fetch({ limit });
    const out: DiscordMessage[] = [];
    for (const m of collection.values()) {
      out.push({
        id: m.id,
        channelId: m.channelId,
        authorId: m.author.id,
        authorName: m.author.username,
        content: m.content,
        mentionsBot: this.resolvedBotUserId ? m.mentions.users.has(this.resolvedBotUserId) : false,
      });
    }
    return out;
  }

  private async requireTextChannel(channelId: string): Promise<TextBasedChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`channel ${channelId} not text-based or not fetchable`);
    }
    return channel;
  }
}
