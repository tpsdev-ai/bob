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
//      allow-list + (optionally) mention filter, strip the bot @-mention and
//      pi.sendUserMessage(cleaned) to drive the agent. The agent's reply goes
//      back out via the discord_reply tool.
//   4. A typing-indicator heartbeat spanning that turn, so the channel shows
//      "<bot> is typing…" for as long as the agent is actually working (see
//      typing.ts for why it has to repeat).

import type { DiscordClient, DiscordMessage } from "@tpsdev-ai/bob-shell";
import { type TSchema, Type } from "typebox";
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
// REPLY ROUTING (PR4): the listener correlates an inbound Discord message with
// the turn it drives by remembering the originating channel at inject time and
// consuming it on `agent_end` (fired once per prompt, carrying that prompt's
// messages). The final assistant text is posted back to the originating channel
// — deterministic, not dependent on the LLM choosing discord_reply with the
// right channel id. So PiLike additionally needs the `agent_end` event.
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
  on(
    event: "agent_end",
    handler: (event: { messages: AssistantMessageLike[] }) => void | Promise<void>,
  ): void;
  sendUserMessage(content: string): void;
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

export interface WireOptions {
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

  // --- Reply routing (PR4) ----------------------------------------------
  // The originating context for the turn currently being driven by an inbound
  // Discord message: which channel to post the reply back to, and the inbound
  // message id to quote-reply to. The persistent session processes one prompt
  // at a time and `agent_end` fires once per prompt, so a single pending
  // pointer (set when we inject, consumed on agent_end) is the correct
  // correlation — no per-message id matching needed, and it can't be steered by
  // a later inbound message because sendUserMessage on a busy session is queued.
  let pending: { channelId: string; replyTo: string } | undefined;

  // "The agent is thinking" affordance for the same window: started when we
  // inject the prompt, stopped when the turn ends. See typing.ts for why a
  // one-shot call doesn't work.
  const typing = createTypingHeartbeat({
    client,
    intervalMs: opts.typingIntervalMs,
    maxMs: opts.typingMaxMs,
    log,
  });

  // On agent turn completion, post the assistant's final text back to the
  // channel the inbound message came from. This is the DETERMINISTIC reply path
  // — it does not rely on the LLM calling discord_reply with the right channel.
  // If the turn wasn't driven by an inbound Discord message (e.g. a heartbeat
  // tick or a cron prompt), `pending` is undefined and we post nothing.
  pi.on("agent_end", async (event) => {
    const target = pending;
    pending = undefined; // consume regardless, so a silent turn can't leak into the next
    try {
      if (!target) return;
      const text = finalAssistantText(event.messages);
      if (text.length === 0) return; // nothing to say (e.g. the agent only ran tools)
      const trimmed =
        text.length <= DISCORD_MAX_REPLY_CHARS
          ? text
          : `${text.slice(0, DISCORD_MAX_REPLY_CHARS)}…`;
      try {
        await client.reply(target.channelId, trimmed, { replyTo: target.replyTo });
      } catch (err) {
        // A failed post must not crash the persistent session — log + continue.
        // The error from discord.js names the cause, never the token.
        const reason = err instanceof Error ? err.message : "reply failed";
        log(`discord: failed to post reply to ${target.channelId}: ${reason}`);
      }
    } finally {
      // The turn is over on EVERY path out of here — the reply landed, there was
      // nothing to say, or something threw. Stop typing in a `finally` so the
      // indicator can never outlive the work it describes; a stuck heartbeat is
      // worse than no heartbeat.
      typing.stop();
    }
  });

  // --- Inbound listener -------------------------------------------------
  // Drives the agent on an incoming Discord message. ENFORCES the channel
  // allow-list (and mention filter unless dispatchAll) so an arbitrary user on
  // a non-allowed channel can never steer the agent. Records the originating
  // channel so agent_end can route the reply back to it.
  client.on("message", (msg: DiscordMessage) => {
    if (!allowed.has(msg.channelId)) return; // trust boundary
    if (!config.dispatchAll && !msg.mentionsBot) return;
    const cleaned = cleanContent(msg.content);
    if (cleaned.length === 0) return;
    // Remember where to send the reply. The most recent inbound message wins
    // if several arrive before a turn completes — they're queued onto the same
    // session, and the reply goes to whoever spoke last (acceptable: the agent
    // sees the full queued context and answers the latest).
    pending = { channelId: msg.channelId, replyTo: msg.id };
    // Light the typing indicator BEFORE handing the prompt over: the gap this
    // exists to fill starts at the first token of model latency, not after it.
    typing.start(msg.channelId);
    try {
      pi.sendUserMessage(cleaned);
    } catch (err) {
      // The prompt never reached the agent, so no agent_end will fire to stop
      // the heartbeat. Clear it here rather than leaving it to the ceiling, then
      // rethrow — swallowing an injection failure would silently drop the
      // message.
      pending = undefined;
      typing.stop();
      throw err;
    }
  });

  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  return {
    async start() {
      await withTimeout(
        client.connect(),
        connectTimeoutMs,
        `discord gateway connect timed out after ${connectTimeoutMs}ms`,
      );
    },
    async stop() {
      // Clear any live heartbeat BEFORE dropping the gateway — a shutdown must
      // not leave an interval poking a channel we're no longer connected to.
      typing.stop();
      await client.disconnect();
    },
  };
}
