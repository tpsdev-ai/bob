// reachy/config.ts — the config surface for the `reachy` capability (spec §3.1).
//
// The extension reads its RESOLVED config from one env var the Bob loader sets
// (BOB_CAP_REACHY, a JSON blob) — config only, never a secret. The capability
// holds no keys OF ITS OWN, but its Flair client's signer reads the agent key
// file (see index.ts) to sign Flair requests, and it talks to the sidecar only
// through the socket. The sidecar runs as its own OS user (bob#356 V1; see
// sidecar/reachy-voice/RUNBOOK.md) — bob never launches it.
//
// bob#356 V1: the device PROFILE and the wake name are BOB-OWNED. The sidecar
// reports both in its `reachy-voice/1` health, and a report that differs from
// this config is a handshake failure (disconnect and alarm), never a downgrade
// or an upgrade. The wake name comes from the agent's `voice.wakeName`
// (capability-loader.ts projects it here); a `reachy:` block cannot set it.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const CONFIG_ENV_VAR = "BOB_CAP_REACHY";

/** The device profiles (bob#356 delta 1). `voice` is a microphone and a speaker;
 *  `reachy` adds the head, the antennas and the camera. */
export const PROFILES = ["voice", "reachy"] as const;
export type ReachyProfile = (typeof PROFILES)[number];
export const DEFAULT_PROFILE: ReachyProfile = "voice";

/** The tools each profile registers (bob#356 delta 1): one capability, the
 *  body tools only under `reachy`. The manifest declares the union and this
 *  map; the capability registers exactly the profile's row. */
export const PROFILE_TOOLS: Readonly<Record<ReachyProfile, readonly string[]>> = Object.freeze({
  voice: Object.freeze(["reachy_say", "reachy_state"]),
  reachy: Object.freeze(["reachy_look", "reachy_say", "reachy_state", "reachy_frame"]),
});

/** The default wake name (the class name), used when `voice.wakeName` is unset. */
export const DEFAULT_WAKE_NAME = "jarvis";

/** The SHAPE of a wake name bob will push to the sidecar: lowercase letters, a
 *  single space or hyphen between words, 2–32 characters. The setter-time rules
 *  (2–3 syllables, a word-frequency exclusion, distance from other local agents'
 *  names) belong to `bob onboard` / `bob voice name`, which V1 does not ship. */
export const WAKE_NAME_PATTERN = "^[a-z]+(?:[ -][a-z]+)*$";
export const WAKE_NAME_SCHEMA = Type.String({
  minLength: 2,
  maxLength: 32,
  pattern: WAKE_NAME_PATTERN,
  description: "Wake name, bob-owned (voice.wakeName).",
});

/** One room-publication grant (bob#356 Kern 5): the authenticated turn origins
 *  whose `reachy_say` call may speak in the room without a transcript. Each is
 *  an EXACT origin: `run` (an operator's run), `cron:<job>`, `discord:<channelId>`
 *  or `mail:<sender>`. A `voice` origin can never be granted here. */
export const ROOM_SPEECH_GRANT_PATTERN =
  "^(?:run|cron:[a-z0-9_-]{1,64}|discord:[0-9]{1,20}|mail:[a-z0-9-]{1,64})$";

export const CONFIG_SCHEMA = Type.Object(
  {
    // Path to the sidecar's UNIX socket.
    socket: Type.String({ minLength: 1, description: "UNIX socket the sidecar listens on." }),
    // Exact pin of the sidecar's version: `health.version` must equal it.
    sidecarVersion: Type.String({ minLength: 1, description: "Exact sidecar version pin." }),
    // bob#356: the device profile. Omitted means `voice`; any other value is
    // refused by this schema at bob.yaml load and again at extension load.
    profile: Type.Optional(
      Type.Union([Type.Literal("voice"), Type.Literal("reachy")], {
        description: "Device profile: voice (mic + speaker) or reachy (adds the body).",
      }),
    ),
    // The wake name — bob-owned, projected from `voice.wakeName`. A string
    // compare in bob, never the sidecar's flag.
    wakeName: Type.Optional(WAKE_NAME_SCHEMA),
    // Bob's own mute: no sidecar connection, no transcripts, no proposals, no
    // speech. The sidecar-reported mute is ORed with it.
    mute: Type.Optional(Type.Boolean({ description: "Bob mute: drop every event." })),
    // bob#356: which authenticated turn origins may speak in the room through
    // `reachy_say` without a transcript. Empty by default: no tool-path speech
    // until an operator grants it.
    roomSpeechOrigins: Type.Optional(
      Type.Array(Type.String({ pattern: ROOM_SPEECH_GRANT_PATTERN }), {
        maxItems: 64,
        description:
          "Turn origins allowed to speak in the room: run, cron:<job>, discord:<id>, mail:<agent>.",
      }),
    ),
    // BOB-OWNED enrolment: speakerId → memberId. EMPTY by default in v1, so
    // nothing is speakerVerified and `answer`/writes are OFF (spec §4).
    enrolledSpeakers: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "BOB-owned speakerId → memberId map. Empty in v1 (nothing verified).",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ReachyCapabilityConfigInput = Static<typeof CONFIG_SCHEMA>;

/** The config with every default applied: what the capability runs on. */
export interface ReachyCapabilityConfig {
  socket: string;
  sidecarVersion: string;
  profile: ReachyProfile;
  wakeName: string;
  mute: boolean;
  roomSpeechOrigins: string[];
  enrolledSpeakers: Record<string, string>;
}

/** Validate a config block and apply the defaults. Throws, naming the field. */
export function parseConfig(parsed: unknown): ReachyCapabilityConfig {
  if (!Value.Check(CONFIG_SCHEMA, parsed)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, parsed)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `reachy capability: config is invalid${where}: ${first?.message ?? "schema check failed"}`,
    );
  }
  const c = parsed as ReachyCapabilityConfigInput;
  return {
    socket: c.socket,
    sidecarVersion: c.sidecarVersion,
    profile: c.profile ?? DEFAULT_PROFILE,
    wakeName: c.wakeName ?? DEFAULT_WAKE_NAME,
    mute: c.mute ?? false,
    roomSpeechOrigins: [...(c.roomSpeechOrigins ?? [])],
    enrolledSpeakers: { ...(c.enrolledSpeakers ?? {}) },
  };
}

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
  return parseConfig(parsed);
}
