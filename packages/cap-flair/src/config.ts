// Config surface for the flair (memory) capability.
//
// SECURITY (Sherlock will scrutinize this file):
//   * The agent's PRIVATE KEY is NEVER inlined in config and NEVER read from an
//     env var. Config carries a *file path* (`keyFile`); the key is read from
//     that file by the client at startup, held in memory, and never logged,
//     echoed, or returned in a tool result / error. See client.ts.
//   * The capability talks ONLY to the configured `url` and signs every request
//     as `agentId` — it cannot act as another agent (the signature is over the
//     agent's own key) and cannot reach a host the config didn't name.
//
// The capability is a self-describing pi extension: it owns its typebox schema
// (CONFIG_SCHEMA) so the package is portable. Bob's blessed catalog mirrors the
// same schema (manifest.ts) to pre-validate the agent's bob.yaml `flair:` block
// before the extension loads. The extension reads its *resolved* config from a
// single env var the Bob loader sets (BOB_CAP_FLAIR, a JSON blob) — config
// (url, id, key PATH) only, never the key itself.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// Env var the Bob loader sets to the JSON-encoded resolved config block. Holds
// config only (url, agentId, key PATH) — never the private key.
export const CONFIG_ENV_VAR = "BOB_CAP_FLAIR";

// typebox schema for the flair capability's config block (the bob.yaml `flair:`
// block, and the JSON the loader passes through CONFIG_ENV_VAR).
export const CONFIG_SCHEMA = Type.Object(
  {
    // Flair base URL the agent's memory lives behind (its local spoke or a hub).
    url: Type.String({
      minLength: 1,
      description: "Flair base URL, e.g. http://127.0.0.1:9926",
    }),
    // This agent's Flair id (the principal every request is signed as). Snake/
    // kebab lowercase — matches the Flair Agent record id.
    agentId: Type.String({
      minLength: 1,
      pattern: "^[a-z0-9-]+$",
      description: "This agent's Flair id (e.g. pulse).",
    }),
    // Path to the agent's Ed25519 private key (base64-encoded PKCS8 DER). The
    // key is read from here at startup; it is never in config/env/logs.
    keyFile: Type.String({
      minLength: 1,
      description: "Path to the agent's Ed25519 private key (base64 PKCS8). Never inlined.",
    }),
  },
  { additionalProperties: false },
);

export type FlairCapabilityConfig = Static<typeof CONFIG_SCHEMA>;

// Parse + validate the config from the env var. Throws an actionable error (no
// secrets — this payload holds only a key PATH) when the var is missing or the
// JSON fails the schema. Returns the typed config.
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FlairCapabilityConfig {
  const raw = env[CONFIG_ENV_VAR];
  if (!raw || raw.trim() === "") {
    throw new Error(
      `flair capability: ${CONFIG_ENV_VAR} is not set — Bob's loader must provide the resolved config block.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the raw blob (defense in depth — no secret here, but the habit
    // matters).
    throw new Error(`flair capability: ${CONFIG_ENV_VAR} is not valid JSON.`);
  }
  if (!Value.Check(CONFIG_SCHEMA, parsed)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, parsed)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `flair capability: config is invalid${where}: ${first?.message ?? "schema check failed"}`,
    );
  }
  return parsed as FlairCapabilityConfig;
}
