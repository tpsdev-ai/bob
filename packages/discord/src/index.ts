// discord.js binding for milton-shell's DiscordClient interface.
//
// Importing this package pulls discord.js (~30MB of WS + REST). Agents
// that don't need Discord shouldn't depend on this package — keep the
// shell-only install slim.

import { Client, GatewayIntentBits, Events, type Message } from "discord.js";
import type { DiscordClient, DiscordMessage } from "@tpsdev-ai/milton-shell";

export interface DiscordJsClientOptions {
  // Bot token. Read from a secret file in production; passed inline in
  // tests is OK.
  token: string;
  // The bot's user ID. Needed to determine whether a message
  // @-mentioned us. If unset, we accept anything that contains the
  // configured bot's user ID once the gateway READY event arrives.
  botUserId?: string;
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
      // Skip bot's own messages
      if (m.author.bot) return;
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
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`channel ${channelId} not text-based or not fetchable`);
    }
    await (channel as unknown as { send: (payload: unknown) => Promise<unknown> }).send({
      content: text,
      reply: opts?.replyTo ? { messageReference: opts.replyTo } : undefined,
    });
  }
}
