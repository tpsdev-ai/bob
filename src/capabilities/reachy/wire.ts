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
//   {"type":"health", …}

import { Type } from "typebox";
import { Value } from "typebox/value";
import { isValidProposal, type PolicyState, type Proposal, type Transcript } from "./policy.js";

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
// The health fields the STUB actually sends: `ok`, plus `replayEnd` on the
// end-of-replay marker. Nothing else — an unknown field is malformed.
const HEALTH_LINE = Type.Object(
  {
    type: Type.Literal("health"),
    ok: Type.Boolean(),
    replayEnd: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type DecodedLine =
  | { kind: "transcript"; transcript: Transcript }
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "presence"; presence: { count: number; known: string[] } }
  | { kind: "health"; health: Record<string, unknown> }
  | { kind: "malformed"; reason: string };

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
  if (type === "health" && Value.Check(HEALTH_LINE, obj)) {
    return { kind: "health", health: obj };
  }
  return { kind: "malformed", reason: `unrecognised line (type=${JSON.stringify(type)})` };
}

export { type PolicyState, Type };
