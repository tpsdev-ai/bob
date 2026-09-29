// discord.js binding for the shell's DiscordClient interface.
//
// Lives inside the discord capability because that is its only consumer. It was
// a separate package for as long as the capabilities were separately published;
// nothing else ever imported it.
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

import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type RESTOptions,
  Routes,
} from "discord.js";
import type { DiscordClient, DiscordMessage } from "../../shell/discord-types.js";

// The REST request function this binding hands to discord.js, replacing
// @discordjs/rest's own strategy.
//
// @discordjs/rest returns a response built with `new Headers(res.headers)`.
// Under Node, its default strategy uses the `undici` package the lockfile
// pins, and undici negotiates HTTP/2 by default; Discord's edge serves h2, and
// Node's http2 client tags the response headers object with a
// `Symbol(sensitiveHeaders)` key. undici's Headers constructor rejects that
// symbol ("Key Symbol(sensitiveHeaders) in init is a symbol, which cannot be
// converted to a ByteString"), so EVERY REST call fails — the gateway never
// connects and no Discord message is sent or received.
//
// The runtime's global `fetch` does not go through the pinned `undici` package
// and has no such problem, so the capability performs the request itself. The
// REST manager builds the init: an uppercase `method`, a `body` (a JSON string
// for this binding's calls, or null for GET/HEAD), `headers` (a plain object of
// string values) and an `AbortSignal`. We forward exactly those, copying the
// headers by their OWN enumerable string keys only, so no symbol-keyed entry
// (the `sensitiveHeaders` one included) can reach a Headers constructor.
//
// Two things the manager offers are deliberately NOT forwarded:
//
//   * `dispatcher` / agent. @discordjs/rest only sets one when a caller gives
//     the manager an agent, and this binding never does (DiscordJsClient never
//     calls setAgent); in this capability the value is always absent. When a
//     caller did set one it is an npm-undici dispatcher, and Node's global
//     fetch rejects a foreign dispatcher ("invalid onRequestStart method"), so
//     forwarding it would fail every request — the same class of failure this
//     function exists to remove. We drop it instead of passing it through.
//
//   * redirects. A followed cross-origin redirect drops the Authorization
//     header, so an authenticated call could leave the process unauthenticated;
//     and the Discord API does not redirect. We ask fetch not to follow and turn
//     any 3xx into an error that names the status and the target host.
//
// Derive the host a redirect points at, for the error text. A missing or
// unparseable Location is named as such, never assumed benign.
function redirectTargetHost(location: string | null, base: string): string {
  if (!location) return "an unspecified location";
  try {
    return new URL(location, base).host;
  } catch {
    return "an unparseable location";
  }
}

export async function makeDiscordRestRequest(
  url: string,
  init: Parameters<RESTOptions["makeRequest"]>[1],
): Promise<Response> {
  const headers = new Headers();
  const initHeaders = (init.headers ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(initHeaders)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: (init.body ?? undefined) as NonNullable<Parameters<typeof fetch>[1]>["body"],
    signal: init.signal ?? undefined,
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    // Attempt to cancel the unread body before rejecting the redirect; a failed
    // cancel must not replace the redirect error below.
    await res.body?.cancel().catch(() => {});
    throw new Error(
      `discord REST: refusing to follow a redirect (HTTP ${res.status} to ${redirectTargetHost(
        res.headers.get("location"),
        url,
      )})`,
    );
  }
  return res;
}

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
      // Give the REST manager a request path that never builds a Headers from an
      // h2-tagged response (see makeDiscordRestRequest). Without this, the
      // capability cannot make ANY REST call under Node.
      rest: { makeRequest: makeDiscordRestRequest as RESTOptions["makeRequest"] },
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
