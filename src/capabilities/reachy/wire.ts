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

const TRANSCRIPT_LINE = Type.Object({
  type: Type.Literal("transcript"),
  text: Type.String(),
  ts: Type.String(),
  wakeHeard: Type.Boolean(),
  speakerId: Type.Optional(Type.String()),
});
const PRESENCE_LINE = Type.Object({
  type: Type.Literal("presence"),
  count: Type.Integer(),
  known: Type.Array(Type.String()),
});
const HEALTH_LINE = Type.Object({ type: Type.Literal("health") }, { additionalProperties: true });

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
  if (type === "proposal") {
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
