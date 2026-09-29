// The testable core of the discord capability, decoupled from both discord.js
// and pi's real ExtensionAPI so it can be unit-tested with fakes (no live
// gateway, no real token, no LLM). `index.ts` is the thin pi-extension factory
// that constructs the real DiscordJsClient + adapts pi and calls this.
//
// What this wires:
//   1. Three outbound tools (discord_reply / discord_react / discord_fetch)
//      via pi.registerTool, each enforcing the channel allow-list and routing
//      through the injected DiscordClient (discord.js → correct UA + 429
//      retry-after).
//   2. An after_provider_response hook that surfaces 429s (per spec §3/§7).
//   3. An inbound gateway listener: on a message that passes the channel
//      allow-list + (optionally) mention filter, strip the bot @-mention, mint
//      an IMMUTABLE turn identity for that message and call bob's
//      admitTurn(origin, cleaned). Route its returned final text back to THAT
//      turn's own channel and message. A message that arrives while a turn is
//      running is queued as its own turn (bob's FIFO admission), never merged
//      into the running turn's destination.
//   4. During a turn the outbound tools are BOUND to that turn's channel: the
//      reply tool refuses any other channel (even an allow-listed one) and the
//      fetch tool reads only the turn's channel. Outside a turn (a cron/heartbeat
//      prompt, a one-shot `bob run`) today's behaviour is unchanged.
//   5. A typing-indicator heartbeat spanning that turn, so the channel shows
//      "<bot> is typing…" for as long as the agent is actually working (see
//      typing.ts for why it has to repeat).

import { type TSchema, Type } from "typebox";
import type { DiscordClient, DiscordMessage } from "../../shell/discord-types.js";
import type { TurnAdmission } from "../../shell/turn-admission.js";
import { cleanContent } from "./clean.js";
import type { DiscordCapabilityConfig } from "./config.js";
import { createTypingHeartbeat } from "./typing.js";

// A pi assistant message, narrowed to what reply-routing reads. The real
// AgentMessage union (pi-ai) is wider; we only need the assistant role + its
// text content blocks. Declared structurally so a test fake and pi's real
// AgentMessage both satisfy it.
export interface AssistantMessageLike {
  role: string;
  // AssistantMessage.content is (TextContent | ThinkingContent | ToolCall)[];
  // we read only the text blocks. `unknown[]` keeps the fake + real type
  // compatible without importing pi-ai here.
  content: unknown;
}

// The minimal slice of pi's ExtensionAPI this core needs. Declared structurally
// so tests pass a tiny fake and the real ExtensionAPI satisfies it. Keeping it
// minimal also documents exactly which pi primitives the capability touches.
//
export interface PiLike {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
  on(
    event: "after_provider_response",
    handler: (event: { status: number; headers: Record<string, string> }) => void,
  ): void;
}

// Discord caps a single message at 2000 chars; we trim defensively below that.
const DISCORD_MAX_REPLY_CHARS = 1900;
// Cap on discord_fetch to keep a single read bounded.
const FETCH_MAX_LIMIT = 50;
const FETCH_DEFAULT_LIMIT = 20;
// Max time to wait for the gateway to connect before giving up. A hung connect
// (e.g. a rate-limited/blocked egress IP — the Cloudflare-1015 class that
// stalled Pulse on the old Portland VM) would otherwise never settle and freeze
// the persistent session at startup. index.ts's try/catch only catches
// rejections, not hangs — so we convert a hang into a rejection here.
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

// Race a promise against a timeout, rejecting with `message` on timeout. The
// caller (index.ts) catches the rejection + continues, so a stuck gateway no
// longer blocks startup — the outbound tools + session still come up.
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  // If `p` settles (rejects) AFTER we've already timed out, nobody is awaiting
  // it — swallow that late rejection so it isn't an unhandled rejection.
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Result of wiring — returned so the factory (and tests) can drive/inspect it.
export interface WiredCapability {
  // Connect the gateway + start listening. The factory awaits this.
  start(): Promise<void>;
  // Disconnect the gateway (for shutdown / tests).
  stop(): Promise<void>;
}

// A dispatched inbound message owns an IMMUTABLE turn identity: the reply
// destination (channel + message), the author and the surface kind. It is
// captured once, at dispatch, and the final reply is addressed to THIS identity
// — never to a shared "latest message" slot a later message could overwrite.
// `guildId` is absent for a DM; `isDM` is the explicit projection of that.
export interface DiscordTurn {
  readonly id: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly guildId?: string;
  readonly isDM: boolean;
}

// Build the immutable turn identity from the inbound message. `id` is a stable
// composite of the two ids that define the destination, so a turn is addressable
// and cannot collide with another turn on the same channel.
export function createDiscordTurn(msg: DiscordMessage): DiscordTurn {
  return {
    id: `${msg.channelId}:${msg.id}`,
    channelId: msg.channelId,
    messageId: msg.id,
    authorId: msg.authorId,
    ...(msg.guildId !== undefined ? { guildId: msg.guildId } : {}),
    isDM: msg.guildId === undefined,
  };
}

export interface WireOptions {
  // Required for inbound service; a one-shot run only registers outbound tools.
  admitTurn?: TurnAdmission["admitTurn"];
  // The runtime's current-turn origin reader (bob's turn admission). While a
  // turn is running, readOrigin() names its origin; the reply/fetch tools use it
  // to stay inside the turn's channel. Outside a turn it returns {kind:"run"},
  // and the tools keep today's behaviour. Absent in a one-shot `bob run`.
  readOrigin?: TurnAdmission["readOrigin"];
  pi: PiLike;
  client: DiscordClient;
  config: DiscordCapabilityConfig;
  // Logger seam — defaults to console. Tests inject a capture. NOTHING here
  // ever logs the token (it lives only inside the client).
  log?: (msg: string) => void;
  // Max ms to wait for the gateway connect before giving up (default 15s).
  // Tests inject a small value to exercise the hang path quickly.
  connectTimeoutMs?: number;
  // Re-fire cadence for the typing indicator (default 8s — just inside
  // Discord's ~10s expiry). Tests inject a few ms to exercise the heartbeat
  // without waiting.
  typingIntervalMs?: number;
  // Ceiling on a single typing heartbeat (default 5min) — the backstop for a
  // turn that never emits agent_end.
  typingMaxMs?: number;
}

function ok(text: string): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text }], details: {} };
}

// Extract the final assistant text from the messages a prompt produced. We take
// the LAST assistant message's text blocks (the agent's concluding answer after
// any tool calls) — pi's AssistantMessage.content is an array of
// (text | thinking | toolCall) blocks; we keep only `text`, dropping thinking +
// tool calls. Returns "" when there's no assistant text (a tool-only turn).
function finalAssistantText(messages: AssistantMessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    return assistantContentToText(msg.content).trim();
  }
  return "";
}

function assistantContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") {
      out += block;
      continue;
    }
    const b = block as { type?: string; text?: string };
    if (b && b.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

export function wireDiscordCapability(opts: WireOptions): WiredCapability {
  const { pi, client, config } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));
  const allowed = new Set(config.channelIds);

  const requireAllowed = (channelId: string): void => {
    if (!allowed.has(channelId)) {
      // Channel allow-list is the trust boundary. Refuse out-of-list channels
      // on the OUTBOUND side too (not just inbound) so the agent can't be
      // tricked into posting somewhere it shouldn't.
      throw new Error(
        `discord: channel ${channelId} is not in the configured allow-list; refusing.`,
      );
    }
  };

  // A turn is bound to ONE channel. While a discord turn is running, the
  // outbound tools may touch only that channel; a different one is refused, even
  // if it is on the allow-list (the allow-list is the trust boundary, the turn
  // binding is the routing boundary). `readOrigin()` names the running turn;
  // {kind:"run"} (no turn / cron / mail) leaves today's behaviour untouched.
  const requireTurnChannel = (channelId: string): void => {
    const origin = opts.readOrigin?.();
    if (origin?.kind !== "discord") return;
    if (origin.channelId !== channelId) {
      throw new Error(
        `discord: this turn is bound to channel ${origin.channelId}; refusing to use channel ${channelId}.`,
      );
    }
  };

  // --- Outbound tool: discord_reply -------------------------------------
  pi.registerTool({
    name: "discord_reply",
    label: "Discord Reply",
    description:
      "Post a message to an allow-listed Discord channel. Optionally reply to a specific message by id.",
    parameters: Type.Object({
      channelId: Type.String({ pattern: "^[0-9]+$", description: "Target channel id." }),
      text: Type.String({ minLength: 1, description: "Message text." }),
      replyTo: Type.Optional(
        Type.String({ pattern: "^[0-9]+$", description: "Message id to quote-reply to." }),
      ),
    }),
    async execute(_id, params) {
      const channelId = params.channelId as string;
      const text = params.text as string;
      const replyTo = params.replyTo as string | undefined;
      requireAllowed(channelId);
      requireTurnChannel(channelId);
      const trimmed =
        text.length <= DISCORD_MAX_REPLY_CHARS
          ? text
          : `${text.slice(0, DISCORD_MAX_REPLY_CHARS)}…`;
      await client.reply(channelId, trimmed, replyTo ? { replyTo } : undefined);
      return ok(`posted to ${channelId}`);
    },
  });

  // --- Outbound tool: discord_react -------------------------------------
  pi.registerTool({
    name: "discord_react",
    label: "Discord React",
    description: "Add an emoji reaction to a message in an allow-listed channel.",
    parameters: Type.Object({
      channelId: Type.String({ pattern: "^[0-9]+$", description: "Channel of the message." }),
      messageId: Type.String({ pattern: "^[0-9]+$", description: "Message to react to." }),
      emoji: Type.String({
        minLength: 1,
        description: "Unicode emoji (e.g. ✅) or a custom-emoji ref (name:id).",
      }),
    }),
    async execute(_id, params) {
      const channelId = params.channelId as string;
      const messageId = params.messageId as string;
      const emoji = params.emoji as string;
      requireAllowed(channelId);
      requireTurnChannel(channelId);
      await client.react(channelId, messageId, emoji);
      return ok(`reacted ${emoji} on ${messageId}`);
    },
  });

  // --- Outbound tool: discord_fetch -------------------------------------
  pi.registerTool({
    name: "discord_fetch",
    label: "Discord Fetch",
    description: "Fetch the most recent messages from an allow-listed channel (newest first).",
    parameters: Type.Object({
      channelId: Type.String({ pattern: "^[0-9]+$", description: "Channel to read." }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: FETCH_MAX_LIMIT,
          description: `How many recent messages (1-${FETCH_MAX_LIMIT}, default ${FETCH_DEFAULT_LIMIT}).`,
        }),
      ),
    }),
    async execute(_id, params) {
      const channelId = params.channelId as string;
      const limit = Math.min(
        (params.limit as number | undefined) ?? FETCH_DEFAULT_LIMIT,
        FETCH_MAX_LIMIT,
      );
      requireAllowed(channelId);
      requireTurnChannel(channelId);
      const messages = await client.fetchRecent(channelId, limit);
      const rendered = messages.map((m) => `[${m.id}] ${m.authorName}: ${m.content}`).join("\n");
      return ok(rendered.length > 0 ? rendered : "(no messages)");
    },
  });

  // --- 429 surfacing (spec §3/§7) ---------------------------------------
  // discord.js already honors retry-after on the REST path; this hook surfaces
  // the model-provider's 429s (the after_provider_response event exposes HTTP
  // status + headers) so a rate-limited agent turn is visible in logs.
  pi.on("after_provider_response", (event) => {
    if (event.status === 429) {
      const retryAfter = event.headers["retry-after"] ?? "?";
      log(`discord: provider returned 429 (retry-after: ${retryAfter}s)`);
    }
  });

  // Each inbound request owns its reply target and typing heartbeat until its
  // admission settles. No latest-sender slot can route a cron reply to Discord.
  const typings = new Set<ReturnType<typeof createTypingHeartbeat>>();
  client.on("message", (msg: DiscordMessage) => {
    if (!allowed.has(msg.channelId)) return;
    if (!config.dispatchAll && !msg.mentionsBot) return;
    const cleaned = cleanContent(msg.content);
    if (cleaned.length === 0) return;
    // The destination is captured HERE, at dispatch. The reply below is
    // addressed to THIS turn's channel/message, so a later inbound message on
    // another channel can never move where this turn's answer lands.
    const turn = createDiscordTurn(msg);
    const typing = createTypingHeartbeat({
      client,
      intervalMs: opts.typingIntervalMs,
      maxMs: opts.typingMaxMs,
      log,
    });
    typings.add(typing);
    typing.start(turn.channelId);
    void (async () => {
      try {
        if (!opts.admitTurn) throw new Error("bob turn admission is unavailable");
        const messages = await opts.admitTurn(
          { kind: "discord", channelId: turn.channelId },
          cleaned,
        );
        const text = finalAssistantText(messages as AssistantMessageLike[]);
        if (text.length === 0) return;
        const trimmed =
          text.length <= DISCORD_MAX_REPLY_CHARS
            ? text
            : `${text.slice(0, DISCORD_MAX_REPLY_CHARS)}…`;
        await client.reply(turn.channelId, trimmed, { replyTo: turn.messageId });
      } catch (err) {
        const reason = err instanceof Error ? err.message : "inbound turn failed";
        log(`discord: inbound turn/reply failed for ${turn.channelId}: ${reason}`);
      } finally {
        typing.stop();
        typings.delete(typing);
      }
    })();
  });

  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  return {
    async start() {
      if (!opts.admitTurn) throw new Error("discord: bob turn admission is unavailable");
      await withTimeout(
        client.connect(),
        connectTimeoutMs,
        `discord gateway connect timed out after ${connectTimeoutMs}ms`,
      );
    },
    async stop() {
      // Clear any live heartbeat BEFORE dropping the gateway — a shutdown must
      // not leave an interval poking a channel we're no longer connected to.
      for (const typing of typings) typing.stop();
      typings.clear();
      await client.disconnect();
    },
  };
}
