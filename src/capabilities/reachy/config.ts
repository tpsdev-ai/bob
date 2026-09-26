// reachy/config.ts — the config surface for the `reachy` capability (spec §3.1).
//
// The extension reads its RESOLVED config from one env var the Bob loader sets
// (BOB_CAP_REACHY, a JSON blob) — config only, never a secret. The capability
// holds no keys OF ITS OWN, but its Flair client's signer reads the agent key
// file (see index.ts) to sign Flair requests, and it talks to the sidecar only
// through the socket. In S3 the sidecar is a STUB launched as the agent's OWN
// user; it is NOT run as its own OS user here (that is S2 — see index.ts).

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const CONFIG_ENV_VAR = "BOB_CAP_REACHY";

export const CONFIG_SCHEMA = Type.Object(
  {
    // Path to the sidecar's UNIX socket.
    socket: Type.String({ minLength: 1, description: "UNIX socket the sidecar listens on." }),
    // Exact pin of the sidecar's protocol version the capability speaks.
    sidecarVersion: Type.String({ minLength: 1, description: "Exact sidecar version pin." }),
    // The wake name — a string compare in bob, never the sidecar's flag.
    wakeName: Type.String({
      minLength: 1,
      default: "jarvis",
      description: "Wake name (string compare in bob).",
    }),
    // Physical mute: no transcripts, no proposals, no frames.
    mute: Type.Boolean({ default: false, description: "Drop every event (physical mute)." }),
    // BOB-OWNED enrolment: speakerId → memberId. EMPTY by default in v1, so
    // nothing is speakerVerified and `answer`/writes are OFF (spec §4).
    enrolledSpeakers: Type.Record(Type.String(), Type.String(), {
      default: {},
      description: "BOB-owned speakerId → memberId map. Empty in v1 (nothing verified).",
    }),
  },
  { additionalProperties: false },
);

export type ReachyCapabilityConfig = Static<typeof CONFIG_SCHEMA>;

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReachyCapabilityConfig {
  const raw = env[CONFIG_ENV_VAR];
  if (!raw || raw.trim() === "") {
    throw new Error(
      `reachy capability: ${CONFIG_ENV_VAR} is not set — Bob's loader must provide the resolved config block.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`reachy capability: ${CONFIG_ENV_VAR} is not valid JSON.`);
  }
  if (!Value.Check(CONFIG_SCHEMA, parsed)) {
    // Apply schema defaults (wakeName, mute, enrolledSpeakers) then re-check.
    parsed = Value.Default(CONFIG_SCHEMA, parsed);
  }
  if (!Value.Check(CONFIG_SCHEMA, parsed)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, parsed)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `reachy capability: config is invalid${where}: ${first?.message ?? "schema check failed"}`,
    );
  }
  return parsed as ReachyCapabilityConfig;
}
