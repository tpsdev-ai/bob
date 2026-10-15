// reachy/wire.ts — the ONE wire shape for the sidecar's inbound JSON lines, and
// its validation. Decoding happens HERE, before policy: a line that does not match
// the schema is MALFORMED (the caller emits an OrgEvent `reachy.malformed`), never
// thrown into the handler.
//
// Line shape (spec §3.2) — one JSON object per line, `type` plus the payload at
// the top level:
//   {"type":"transcript","text":…,"ts":…,"wakeHeard":bool,"speakerId"?:id}
//   {"type":"proposal","action":…,"args":{…},"confidence":num,"inputs":[id]}
//   {"type":"presence","count":n,"known":[id]}
//   {"type":"health","protocol":"reachy-voice/1",…}   (bob#356, below)
//
// bob#356 V1 — the `reachy-voice/1` handshake. On every connection bob first
// sends ONE control command, `configure`, carrying the protocol, bob's profile,
// bob's wake name and a fresh configuration generation. The sidecar answers with
// a strict health line that must repeat all four exactly and carry the exact
// version bob pins (`config.sidecarVersion`). Until that health line is
// accepted, the connection carries control/status traffic only: bob sends no
// action. A protocol failure disconnects and attempts an alarm, retrying that
// reason after a failed write. The comparison is `checkHealth` below.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ReachyProfile } from "./config.js";
import { isValidProposal, type PolicyState, type Proposal, type Transcript } from "./policy.js";

/** The wire protocol bob speaks. A sidecar on any other protocol is refused. */
export const VOICE_PROTOCOL = "reachy-voice/1";

/** The sidecar's wake-detection mode, as it ASSERTS it (bob#356 NEW-9: the mode
 *  gates no authority; bob's own name compare stays the gate). Each mode fixes
 *  what the trained-artifact fields may say (`checkHealth`):
 *   - `off`: no ears at all — no capture, no wake model, no speech-to-text
 *     (V1). No trained artifact is reported: both fields null.
 *   - `gate-only`: the name gate on transcripts while a model TRAINS (V2). It
 *     carries no matching trained artifact: one for this name means training
 *     is done, and an always-transcribing gate must not outlive it.
 *   - `trained`: a trained wake model for this exact name (V2): the phrase is
 *     the wake name and the model hash is present. */
export const WAKE_MODES = ["off", "gate-only", "trained"] as const;
export type WakeMode = (typeof WAKE_MODES)[number];

const TRANSCRIPT_LINE = Type.Object(
  {
    type: Type.Literal("transcript"),
    text: Type.String(),
    ts: Type.String(),
    wakeHeard: Type.Boolean(),
    speakerId: Type.Optional(Type.String()),
  },
  // A trust boundary is STRICT: an unknown field is malformed (round 3 item 4).
  { additionalProperties: false },
);
const PRESENCE_LINE = Type.Object(
  {
    type: Type.Literal("presence"),
    count: Type.Integer(),
    known: Type.Array(Type.String()),
  },
  // Strict outer envelope: an unknown field is malformed (round 4 item 3).
  { additionalProperties: false },
);
// The proposal envelope is strict too. `args` is deliberately open — the policy
// owns the per-action argument shape (`isValidProposal`), not the wire.
const PROPOSAL_LINE = Type.Object(
  {
    type: Type.Literal("proposal"),
    action: Type.String(),
    args: Type.Unknown(),
    confidence: Type.Number(),
    inputs: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
// bob#356: the strict `reachy-voice/1` health line. Every field except the
// OPTIONAL `replayEnd` (the stub's end-of-replay marker) is REQUIRED (a legacy
// `{type:"health",ok:true}` is malformed), every string and number is bounded,
// and an unknown field is malformed.
export const HEALTH_LINE = Type.Object(
  {
    type: Type.Literal("health"),
    protocol: Type.Literal(VOICE_PROTOCOL),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    profile: Type.Union([Type.Literal("voice"), Type.Literal("reachy")]),
    // The configuration generation bob pushed on THIS connection.
    generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    wakeName: Type.String({ minLength: 1, maxLength: 32 }),
    mode: Type.Union([Type.Literal("off"), Type.Literal("gate-only"), Type.Literal("trained")]),
    // The name the installed wake model was trained for, and that model's
    // sha256 — null when there is none.
    trainedPhrase: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
    modelHash: Type.Union([Type.String({ pattern: "^[0-9a-f]{64}$" }), Type.Null()]),
    // The mute the sidecar REPORTS. V1's sidecar does not read the hardware
    // switch: it reports its operator's `--device-mute` setting.
    muted: Type.Boolean(),
    ok: Type.Boolean(),
    replayEnd: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SidecarHealth = Static<typeof HEALTH_LINE>;

export type DecodedLine =
  | { kind: "transcript"; transcript: Transcript }
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "presence"; presence: { count: number; known: string[] } }
  | { kind: "health"; health: SidecarHealth }
  // `protocol: true` marks a health line that failed the strict schema: a
  // handshake failure (disconnect and an attempted alarm), not a per-line audit.
  | { kind: "malformed"; reason: string; protocol?: true };

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Decode one line (a raw string or an already-parsed object) into a DecodedLine. */
export function decodeLine(raw: unknown): DecodedLine {
  const line = typeof raw === "string" ? safeJson(raw) : raw;
  if (line === null || typeof line !== "object")
    return { kind: "malformed", reason: "not a JSON object" };
  const obj = line as Record<string, unknown>;
  const type = obj.type;
  // The socket client hands an oversized line as this marker (never buffered).
  if (type === "__oversized__")
    return { kind: "malformed", reason: "line exceeds the 64 KiB bound" };
  if (type === "transcript" && Value.Check(TRANSCRIPT_LINE, obj)) {
    return {
      kind: "transcript",
      transcript: {
        text: obj.text as string,
        ts: obj.ts as string,
        wakeHeard: obj.wakeHeard as boolean,
        speakerId: (obj.speakerId as string | undefined) ?? undefined,
      },
    };
  }
  if (type === "proposal" && Value.Check(PROPOSAL_LINE, obj)) {
    const proposal = {
      action: obj.action,
      args: obj.args,
      confidence: obj.confidence,
      inputs: obj.inputs,
    };
    if (isValidProposal(proposal)) return { kind: "proposal", proposal: proposal as Proposal };
    return {
      kind: "malformed",
      reason: "proposal failed the typed schema (prose or out-of-enum action)",
    };
  }
  if (type === "presence" && Value.Check(PRESENCE_LINE, obj)) {
    return {
      kind: "presence",
      presence: { count: obj.count as number, known: obj.known as string[] },
    };
  }
  if (type === "health") {
    if (Value.Check(HEALTH_LINE, obj)) return { kind: "health", health: obj as SidecarHealth };
    // Content-free: name the protocol failure, never echo the sidecar's values.
    return {
      kind: "malformed",
      reason: `health line is not ${VOICE_PROTOCOL} (a missing, unknown or out-of-bounds field)`,
      protocol: true,
    };
  }
  return { kind: "malformed", reason: `unrecognised line (type=${JSON.stringify(type)})` };
}

/** What bob expects the sidecar to repeat on this connection. */
export interface HandshakeExpectation {
  version: string;
  profile: ReachyProfile;
  wakeName: string;
  generation: number;
}

/** The control command bob sends first on every connection (bob#356 V1). */
export function configureArgs(expect: HandshakeExpectation): Record<string, unknown> {
  return {
    protocol: VOICE_PROTOCOL,
    profile: expect.profile,
    wakeName: expect.wakeName,
    generation: expect.generation,
  };
}

/**
 * Compare a decoded health line with what bob pushed. Returns the NAMES of the
 * fields that do not match (never the sidecar's values, so the alarm stays
 * bounded and content-free); an empty list is a match. The rules:
 *   - version, profile, wake name and generation must equal bob's EXACTLY — the
 *     sidecar can neither downgrade nor upgrade the profile;
 *   - `ok` must be true;
 *   - the trained artifact is a PAIR: phrase and hash are both null or both set;
 *   - `off` reports no artifact; `gate-only` reports no artifact for THIS name;
 *     `trained` reports exactly this name's artifact (see WAKE_MODES). The
 *     mode itself grants nothing.
 */
export function checkHealth(health: SidecarHealth, expect: HandshakeExpectation): string[] {
  const bad: string[] = [];
  if (health.version !== expect.version) bad.push("version");
  if (health.profile !== expect.profile) bad.push("profile");
  if (health.wakeName !== expect.wakeName) bad.push("wakeName");
  if (health.generation !== expect.generation) bad.push("generation");
  if (health.ok !== true) bad.push("ok");
  if ((health.trainedPhrase === null) !== (health.modelHash === null)) {
    bad.push("trainedPhrase/modelHash pair");
  } else if (health.mode === "off") {
    if (health.trainedPhrase !== null) bad.push("trainedPhrase (mode off)");
  } else if (health.mode === "gate-only") {
    if (health.trainedPhrase === expect.wakeName) bad.push("trainedPhrase (mode gate-only)");
  } else {
    if (health.trainedPhrase !== expect.wakeName) bad.push("trainedPhrase");
    if (health.modelHash === null) bad.push("modelHash");
  }
  return bad;
}

export { type PolicyState, Type };
