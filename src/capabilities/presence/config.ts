// Config surface for the presence capability.
//
// SECURITY (Sherlock will scrutinize this file):
//   * Like the flair capability, config carries a KEY FILE PATH (keyFile),
//     never the key itself. The Ed25519 key is read from that file by
//     FlairHttpClient at startup and is never logged / echoed / returned in a
//     beat or a turn summary / placed in an error message. See flair/client.ts.
//   * The presence capability talks ONLY to the configured `url` and signs
//     every request as `agentId` — it cannot act as another agent (the
//     signature is over the agent's own key) and cannot reach a host the
//     config did not name.
//
// The capability is a self-describing pi extension: it owns CONFIG_SCHEMA so the
// package is portable. Bob's blessed catalog pre-validates the agent's bob.yaml
// `presence:` block against this same object before the extension loads. The
// extension reads its *resolved* config from the env var the Bob loader sets
// (BOB_CAP_PRESENCE, a JSON blob) — config (url, id, key PATH, cadence), never
// the key.
//
// The `{ url, keyFile, agentId }` block mirrors the flair block exactly (same
// fields, written by the same onboard path). `agentId` is defaulted to the
// agent name by that onboard path; here it is required so the capability fails
// fast at load if the loader did not provide it.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// Env var the Bob loader sets to the JSON-encoded resolved config block. Holds
// config only (url, agentId, key PATH, cadence flags) — never the private key.
export const CONFIG_ENV_VAR = "BOB_CAP_PRESENCE";

// Activity enum the server enforces (mirrors Flair's Presence.post activity
// enumeration). The busy beat uses `busyActivity`; the settled beat uses "idle".
const ACTIVITY_VALUES = ["coding", "reviewing", "planning", "debugging", "idle"] as const;
export type PresenceActivity = (typeof ACTIVITY_VALUES)[number];

// Durability tiers, same set as the flair memory writes.
const DURABILITY_VALUES = ["ephemeral", "standard", "persistent", "permanent"] as const;

export const CONFIG_SCHEMA = Type.Object(
  {
    // Flair base URL the presence heartbeat + turn summaries are sent to.
    url: Type.String({
      minLength: 1,
      description: "Flair base URL, e.g. http://127.0.0.1:19926",
    }),
    // This agent's Flair id (the principal every request is signed as).
    agentId: Type.String({
      minLength: 1,
      pattern: "^[a-z0-9-]+$",
      description: "This agent's Flair id (e.g. pulse). Defaults to the agent name.",
    }),
    // Path to the agent's Ed25519 private key (base64 PKCS8 or PEM). The key
    // is read from here at startup; it is never in config/env/logs.
    keyFile: Type.String({
      minLength: 1,
      description: "Path to the agent's Ed25519 private key. Never inlined.",
    }),
    // The activity label the busy beat (agent_start) reports (default "coding").
    busyActivity: Type.Optional(
      Type.Union(
        ACTIVITY_VALUES.map((a) => Type.Literal(a)),
        { default: "coding", description: "Activity reported when the agent starts a turn." },
      ),
    ),
    // Beacon re-fire cadence (default 60_000ms). Fires liveness-only beats so a
    // long turn does not read as "offline" on the roster.
    beaconIntervalMs: Type.Optional(
      Type.Integer({
        minimum: 1000,
        default: 60000,
        description: "Milliseconds between liveness-only beacon beats (default 60s).",
      }),
    ),
    // Cap on the runtime-authored currentTask label (default 120). The Flair
    // server caps currentTask at 200; we cap tighter so the label always lands.
    currentTaskMaxChars: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 200,
        default: 120,
        description: "Max length of the runtime-authored currentTask label (default 120).",
      }),
    ),
    // Turn-end summary settings.
    summary: Type.Optional(
      Type.Object(
        {
          // Master switch. When false, no turn summary is written. Default true.
          enabled: Type.Optional(Type.Boolean({ default: true })),
          // Durability of the written turn summary (default "standard" — ages with
          // the store; the forensic trail + rehydration supplement, not the
          // pinned task contract).
          durability: Type.Optional(
            Type.Union(
              DURABILITY_VALUES.map((d) => Type.Literal(d)),
              {
                default: "standard",
                description: "Durability of the written turn summary (default standard).",
              },
            ),
          ),
          // Hard cap on the serialized summary JSON. Exceeding it triggers the
          // truncated safety net (a compact, self-identifying record).
          maxChars: Type.Optional(
            Type.Integer({
              minimum: 1,
              default: 2048,
              description: "Max serialized turn-summary length.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type PresenceCapabilityConfig = Static<typeof CONFIG_SCHEMA>;

// Parse + validate the config from the env var. Throws an actionable error (no
// secrets — this payload holds only a key PATH) when the var is missing or the
// JSON fails the schema.
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PresenceCapabilityConfig {
  const raw = env[CONFIG_ENV_VAR];
  if (!raw || raw.trim() === "") {
    throw new Error(
      `presence capability: ${CONFIG_ENV_VAR} is not set — Bob's loader must provide the resolved config block.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the raw blob (defense in depth — no secret here, but the habit
    // matters).
    throw new Error(`presence capability: ${CONFIG_ENV_VAR} is not valid JSON.`);
  }
  if (!Value.Check(CONFIG_SCHEMA, parsed)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, parsed)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `presence capability: config is invalid${where}: ${first?.message ?? "schema check failed"}`,
    );
  }
  return parsed as PresenceCapabilityConfig;
}
