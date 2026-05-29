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

import type { DiscordClient, DiscordMessage } from "@tpsdev-ai/bob-shell";
import { type TSchema, Type } from "typebox";
import { cleanContent } from "./clean.js";
import type { DiscordCapabilityConfig } from "./config.js";

// The minimal slice of pi's ExtensionAPI this core needs. Declared structurally
// so tests pass a tiny fake and the real ExtensionAPI satisfies it. Keeping it
// minimal also documents exactly which pi primitives the capability touches.
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
  sendUserMessage(content: string): void;
}

// Discord caps a single message at 2000 chars; we trim defensively below that.
const DISCORD_MAX_REPLY_CHARS = 1900;
// Cap on discord_fetch to keep a single read bounded.
const FETCH_MAX_LIMIT = 50;
const FETCH_DEFAULT_LIMIT = 20;

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
}

function ok(text: string): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text }], details: {} };
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

  // --- Inbound listener -------------------------------------------------
  // Drives the agent on an incoming Discord message. ENFORCES the channel
  // allow-list (and mention filter unless dispatchAll) so an arbitrary user on
  // a non-allowed channel can never steer the agent. Only does real work in a
  // persistent session (PR4); wired + unit-tested now with a mocked gateway.
  client.on("message", (msg: DiscordMessage) => {
    if (!allowed.has(msg.channelId)) return; // trust boundary
    if (!config.dispatchAll && !msg.mentionsBot) return;
    const cleaned = cleanContent(msg.content);
    if (cleaned.length === 0) return;
    pi.sendUserMessage(cleaned);
  });

  return {
    async start() {
      await client.connect();
    },
    async stop() {
      await client.disconnect();
    },
  };
}
