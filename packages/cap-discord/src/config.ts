// Config surface for the discord capability.
//
// SECURITY (Sherlock will scrutinize this file):
//   * The bot token is NEVER inlined in config and NEVER read from an env var.
//     Config carries a *file path* (`tokenFile`); the token is read from that
//     file at startup, held in memory, and never logged, echoed, or returned in
//     a tool result / error message. See readToken().
//   * The channel allow-list (`channelIds`) is the trust boundary: the inbound
//     listener and the outbound tools both refuse channels outside it, so an
//     arbitrary Discord user cannot steer the agent from an un-allowed channel.
//
// The capability is a self-describing pi extension: it owns its typebox schema
// (CONFIG_SCHEMA) so the package is fully portable. Bob's blessed catalog
// mirrors the same schema (manifest.ts) to pre-validate the agent's bob.yaml
// block before the extension ever loads. The extension reads its *resolved*
// config from a single env var the Bob loader/launcher sets (BOB_CAP_DISCORD,
// a JSON blob) — config, not the secret. The secret stays on disk.

import { readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// Env var the Bob loader sets to the JSON-encoded resolved config block. Holds
// config only (paths, channel ids, flags) — never the token itself.
export const CONFIG_ENV_VAR = "BOB_CAP_DISCORD";

// typebox schema for the discord capability's config block (the bob.yaml
// `discord:` block, and the JSON the loader passes through CONFIG_ENV_VAR).
//
// channelIds is the allow-list and is REQUIRED + non-empty: a discord
// capability with no channel allow-list would let any channel reach the agent,
// which is exactly the confused-deputy lever the spec calls out. Fail closed.
export const CONFIG_SCHEMA = Type.Object(
  {
    // Absolute (or ~-relative) path to a file containing ONLY the bot token.
    // The token is read from here at startup; it is never in config/env/logs.
    tokenFile: Type.String({
      minLength: 1,
      description: "Path to a file containing the Discord bot token (token is never inlined).",
    }),
    // Allow-list of channel IDs the bot listens on and may post to. Required,
    // non-empty — the trust boundary. Snowflake-shaped (digits) entries only.
    channelIds: Type.Array(Type.String({ pattern: "^[0-9]+$" }), {
      minItems: 1,
      description: "Allow-listed Discord channel IDs (the trust boundary).",
    }),
    // The bot's own user ID, used for mention detection + self-message skipping.
    // Optional: discord.js resolves it from the gateway READY event if unset.
    botUserId: Type.Optional(
      Type.String({ pattern: "^[0-9]+$", description: "The bot's own user ID." }),
    ),
    // Dispatch ALL messages on allow-listed channels, not just bot-mentions.
    // Still bounded by channelIds — dispatchAll never widens the channel set.
    dispatchAll: Type.Optional(Type.Boolean({ default: false })),
    // Optional model override for Discord-driven turns (documented metadata for
    // the persistent runtime; the listener itself does not switch models).
    model: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type DiscordCapabilityConfig = Static<typeof CONFIG_SCHEMA>;

// Parse + validate the config from the env var. Throws an actionable error (no
// secrets — there are none in this payload) when the env var is missing or the
// JSON fails the schema. Returns the typed config.
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DiscordCapabilityConfig {
  const raw = env[CONFIG_ENV_VAR];
  if (!raw || raw.trim() === "") {
    throw new Error(
      `discord capability: ${CONFIG_ENV_VAR} is not set — Bob's loader must provide the resolved config block.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do NOT include `raw` in the message — defense in depth (this payload
    // holds no secret, but never echo untrusted/config blobs into logs).
    throw new Error(`discord capability: ${CONFIG_ENV_VAR} is not valid JSON.`);
  }
  if (!Value.Check(CONFIG_SCHEMA, parsed)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, parsed)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `discord capability: config is invalid${where}: ${first?.message ?? "schema check failed"}`,
    );
  }
  // Value.Check is a type guard — `parsed` is now known to satisfy the schema.
  return parsed as DiscordCapabilityConfig;
}

// Read the bot token from the configured file. The token is returned to the
// caller (held in the gateway client's memory) and MUST NOT be logged, echoed,
// included in tool results, or put in the session transcript. On failure, the
// error names the PATH only — never any file contents.
export function readToken(
  tokenFile: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string {
  let contents: string;
  try {
    contents = read(tokenFile);
  } catch (err) {
    // err.message from fs already contains only the path, not contents.
    const reason = err instanceof Error ? err.message : "read failed";
    throw new Error(`discord capability: cannot read token file: ${reason}`);
  }
  const token = contents.trim();
  if (token.length === 0) {
    throw new Error(`discord capability: token file ${tokenFile} is empty.`);
  }
  return token;
}
