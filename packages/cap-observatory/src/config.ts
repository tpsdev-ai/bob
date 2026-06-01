// Config surface for the observatory (team-view producer) capability.
//
// SECURITY (Sherlock will scrutinize this file):
//   * The OFFICE PRIVATE KEY is NEVER inlined in config and NEVER read from an
//     env var. Config carries a *file path* (`officeKeyFile`); the key is read
//     from that file by the client at startup, held in memory, and never logged,
//     echoed, or returned in a tool result / error. See client.ts.
//   * The capability talks ONLY to the configured `observatoryUrl` and signs
//     every POST as `officeId` with the OFFICE key — it cannot act as another
//     office (the signature is over the office's own key) and cannot reach a
//     host the config didn't name.
//   * NOTE the deliberate difference from cap-flair: the observatory endpoint
//     (POST /IngestEvents) verifies the OFFICE key (ObsOffice.publicKey), NOT a
//     per-agent Flair key. This capability is therefore handed the OFFICE key,
//     never an agent's Flair key.
//
// The capability is a self-describing pi extension: it owns its typebox schema
// (CONFIG_SCHEMA) so the package is portable. Bob's blessed catalog mirrors the
// same schema (manifest.ts) to pre-validate the agent's bob.yaml `observatory:`
// block before the extension loads. The extension reads its *resolved* config
// from a single env var the Bob loader sets (BOB_CAP_OBSERVATORY, a JSON blob) —
// config (url, officeId, key PATH, snapshot sources) only, never the key itself.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// Env var the Bob loader sets to the JSON-encoded resolved config block. Holds
// config only (url, officeId, key PATH, snapshot sources) — never the office key.
export const CONFIG_ENV_VAR = "BOB_CAP_OBSERVATORY";

// One agent's snapshot source — the static identity (role/model) the producer
// reports for an agent in this office, plus the local signal files it reads to
// derive live status (status / currentTask / lastActivity / lastHeartbeat).
//
// SECURITY: these are PATHS to local signal files, not secrets. They are read
// for SUMMARIES only; sanitize() strips anything that slips through.
const SNAPSHOT_SOURCE_SCHEMA = Type.Object(
  {
    // The agent's id (the principal the snapshot is keyed by). Snake/kebab
    // lowercase — matches the office's agent ids (e.g. "flint").
    agentId: Type.String({
      minLength: 1,
      pattern: "^[a-z0-9-]+$",
      description: "This agent's id (e.g. flint).",
    }),
    // Human-readable display name (defaults to agentId if omitted).
    name: Type.Optional(Type.String({ description: "Display name (defaults to agentId)." })),
    // Static identity reported in the snapshot — from the agent's bob.yaml.
    role: Type.Optional(Type.String({ description: "The agent's role (e.g. Strategy)." })),
    model: Type.Optional(Type.String({ description: "The agent's model (e.g. claude-opus-4-8)." })),
    // "agent" | "human" — the snapshot type (matches ObsAgentSnapshot.type).
    type: Type.Optional(
      Type.Union([Type.Literal("agent"), Type.Literal("human")], {
        description: 'Snapshot type: "agent" (default) or "human".',
      }),
    ),
    // PATH to a Beads in-progress signal — the producer reads the in-progress
    // task SUMMARY/title from here for currentTask. Never the raw prompt or
    // session transcript.
    beadsFile: Type.Optional(
      Type.String({ description: "Path to a Beads in-progress JSON signal (task summary only)." }),
    ),
    // PATH to the agent's heartbeat/activity signal — the producer reads its
    // mtime/contents to derive lastActivity + lastHeartbeat and liveness.
    heartbeatFile: Type.Optional(
      Type.String({ description: "Path to the agent's heartbeat/activity signal file." }),
    ),
  },
  { additionalProperties: false },
);

export type SnapshotSource = Static<typeof SNAPSHOT_SOURCE_SCHEMA>;

// typebox schema for the observatory capability's config block (the bob.yaml
// `observatory:` block, and the JSON the loader passes through CONFIG_ENV_VAR).
export const CONFIG_SCHEMA = Type.Object(
  {
    // Observatory base URL the office reports to (rockit Flair / a hub).
    observatoryUrl: Type.String({
      minLength: 1,
      description: "Observatory base URL, e.g. http://127.0.0.1:9926",
    }),
    // This office's id (the principal every POST is signed as). Snake/kebab
    // lowercase — matches the ObsOffice record id (e.g. "rockit").
    officeId: Type.String({
      minLength: 1,
      pattern: "^[a-z0-9-]+$",
      description: "This office's id (e.g. rockit).",
    }),
    // Path to the OFFICE Ed25519 private key (base64-encoded PKCS8 DER). The key
    // is read from here at startup; it is never in config/env/logs. NOTE: this
    // is the OFFICE key, distinct from any agent's Flair key.
    officeKeyFile: Type.String({
      minLength: 1,
      description:
        "Path to the OFFICE Ed25519 private key (base64 PKCS8). Never inlined. Distinct from agent Flair keys.",
    }),
    // Staleness threshold (seconds) — if an agent's lastHeartbeat is older than
    // this, the producer reports status "stale". Default 600 (= 2× a 5-min
    // cron) mirrors ObsOffice.staleThresholdSeconds so every surface agrees.
    staleThresholdSeconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Heartbeat-age (s) past which an agent is reported stale (default 600).",
      }),
    ),
    // The agents this office reports each tick (batched into one POST).
    agents: Type.Array(SNAPSHOT_SOURCE_SCHEMA, {
      minItems: 1,
      description: "The office's agents — each self-reported as one ObsAgentSnapshot per tick.",
    }),
  },
  { additionalProperties: false },
);

export type ObservatoryCapabilityConfig = Static<typeof CONFIG_SCHEMA>;

// Parse + validate the config from the env var. Throws an actionable error (no
// secrets — this payload holds only a key PATH) when the var is missing or the
// JSON fails the schema. Returns the typed config.
export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ObservatoryCapabilityConfig {
  const raw = env[CONFIG_ENV_VAR];
  if (!raw || raw.trim() === "") {
    throw new Error(
      `observatory capability: ${CONFIG_ENV_VAR} is not set — Bob's loader must provide the resolved config block.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the raw blob (defense in depth — no secret here, but the habit
    // matters).
    throw new Error(`observatory capability: ${CONFIG_ENV_VAR} is not valid JSON.`);
  }
  if (!Value.Check(CONFIG_SCHEMA, parsed)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, parsed)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `observatory capability: config is invalid${where}: ${first?.message ?? "schema check failed"}`,
    );
  }
  return parsed as ObservatoryCapabilityConfig;
}
