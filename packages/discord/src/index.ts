// discord.js binding for bob-shell's DiscordClient interface.
//
// Importing this package pulls discord.js (~30MB of WS + REST). Agents
// that don't need Discord shouldn't depend on this package — keep the
// shell-only install slim.
//
// OUTBOUND vs INBOUND are decoupled (so a one-shot `bob run` stays minimal):
//   * OUTBOUND (reply/react/fetch) goes through `client.rest` — discord.js's
//     REST manager. It needs only the token (setToken in the constructor); it
//     does NOT require login()/a gateway connection. It still sends the correct
//     `User-Agent` and honors `Retry-After` on 429 (the @discordjs/rest
//     RequestManager hygiene — the thing the failed raw `curl` lacked). This is
//     NOT a raw fetch: it's the client's own REST path.
//   * INBOUND (the message listener) needs the gateway, so it requires
//     connect() (login). Only the PERSISTENT runtime calls connect(); a one-shot
//     run gets the outbound REST tools with no gateway, no duplicate login.

import type { DiscordClient, DiscordMessage } from "@tpsdev-ai/bob-shell";
import { Client, Events, GatewayIntentBits, type Message, Routes } from "discord.js";

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

// The slice of a raw Discord API message (REST GET /channels/:id/messages) that
// fetchRecent reads. (Raw API uses snake_case + a mentions ARRAY — not the
// discord.js Message object.)
interface RawApiMessage {
  id: string;
  channel_id: string;
  author: { id: string; username: string };
  content: string;
  mentions?: Array<{ id: string }>;
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
    // Enable the REST manager WITHOUT logging in — outbound works in a one-shot
    // run with no gateway connection. (login() also sets the token; doing it
    // here makes REST usable before/without connect().)
    this.client.rest.setToken(this.token);

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

  // Open the gateway (login). INBOUND-only — outbound already works via REST.
  // The persistent runtime calls this; a one-shot run does not.
  async connect(): Promise<void> {
    await this.client.login(this.token);
  }

  async disconnect(): Promise<void> {
    await this.client.destroy();
  }

  // --- OUTBOUND (REST, no gateway needed) -------------------------------

  async reply(channelId: string, text: string, opts?: { replyTo?: string }): Promise<void> {
    await this.client.rest.post(Routes.channelMessages(channelId), {
      body: {
        content: text,
        // Raw API reply shape. fail_if_not_exists:false → if the referenced
        // message is gone, post a normal message instead of erroring.
        message_reference: opts?.replyTo
          ? { message_id: opts.replyTo, fail_if_not_exists: false }
          : undefined,
      },
    });
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    // PUT /channels/:c/messages/:m/reactions/:emoji/@me — emoji must be URL-
    // encoded (unicode glyph or a "name:id" custom-emoji ref).
    await this.client.rest.put(
      Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji)),
    );
  }

  async sendTyping(channelId: string): Promise<void> {
    // POST /channels/:c/typing — no body. Discord shows "<bot> is typing…" for
    // ~10s and then it silently expires; there is no stop endpoint. Anything
    // that outlives that window re-fires on a cadence (the capability's typing
    // heartbeat) rather than calling this once.
    await this.client.rest.post(Routes.channelTyping(channelId));
  }

  async fetchRecent(channelId: string, limit: number): Promise<DiscordMessage[]> {
    const raw = (await this.client.rest.get(Routes.channelMessages(channelId), {
      query: new URLSearchParams({ limit: String(limit) }),
    })) as RawApiMessage[];
    return raw.map((m) => ({
      id: m.id,
      channelId: m.channel_id,
      authorId: m.author.id,
      authorName: m.author.username,
      content: m.content,
      mentionsBot: this.resolvedBotUserId
        ? (m.mentions ?? []).some((u) => u.id === this.resolvedBotUserId)
        : false,
    }));
  }
}
