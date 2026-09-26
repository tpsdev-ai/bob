// reachy/policy.ts — the POLICY core (pure, testable, no pi/pi-socket/network).
//
// Design spec §3.3: the sidecar is an UNTRUSTED PROPOSER; bob holds AUTHORITY.
// Everything the sidecar emits is input, never a decision. This module is the
// decision: given a transcript/proposal and bob-owned state (the wake name and
// the enrolment), it returns either "do nothing" or an ADMITTED action with the
// OrgEvent that must be recorded for it.
//
// v1 fail-closed rules (spec §4, this slice S3):
//   * `speakerVerified` requires speakerId ∈ bob's OWN enrolment. In v1 the
//     enrolment is EMPTY by default, so nothing is verified and `answer`/writes
//     are OFF.
//   * A memory is written ONLY when addressed AND speakerVerified — visibility
//     `private`, author `jarvis`, speakerId in metadata. Non-member speech is
//     EPHEMERAL (no write, never recallable).
//   * Memory-backed speech is OFF outright (a `say` whose inputs reference a
//     memory is refused); `answer` is OFF in v1.
//   * `mute` drops every event — no transcripts, no proposals, no frames, no
//     OrgEvents.

import { randomBytes, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";

export type ProposalAction =
  | "ignore"
  | "look"
  | "acknowledge"
  | "frame"
  | "answer"
  | "think"
  | "ask"
  | "say";

/** The typed proposal schema (spec §3.3): constrained decoding, NEVER prose. A
 *  prose-only proposal (a free-text field, no action) fails this schema. */
export const PROPOSAL_SCHEMA = Type.Object(
  {
    action: Type.Union([
      Type.Literal("ignore"),
      Type.Literal("look"),
      Type.Literal("acknowledge"),
      Type.Literal("frame"),
      Type.Literal("answer"),
      Type.Literal("think"),
      Type.Literal("ask"),
      Type.Literal("say"),
    ]),
    args: Type.Record(Type.String(), Type.Unknown()),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    inputs: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

/** True when `p` is a valid typed proposal (never prose). */
export function isValidProposal(p: unknown): boolean {
  return Value.Check(PROPOSAL_SCHEMA, p);
}

export interface Proposal {
  action: ProposalAction;
  args: Record<string, unknown>;
  confidence: number;
  // The ids of the inputs the proposal was derived from (audit trail).
  inputs: string[];
}

export interface Transcript {
  text: string;
  ts: string;
  // The sidecar's OWN flag — a hint only. bob recomputes `addressed` and never
  // trusts this for authority (spec §3.2/§3.3).
  wakeHeard: boolean;
  speakerId?: string;
}

export interface PolicyState {
  // SSR "jarvis" — a string compare in bob, never the sidecar's flag.
  wakeName: string;
  // speakerId → memberId. EMPTY by default in v1 (nothing is verified).
  enrolment: Record<string, string>;
  mute: boolean;
  // Rate-limit state for an unverified speaker's acknowledge (one per minute).
  nowMs: () => number;
  lastAcknowledgeAtMs?: number;
}

import type { OrgEventRecord } from "../observatory/snapshot.js";
/** The reachy audit event IS the record the rest of bob emits (observatory). */
export type OrgEvent = OrgEventRecord;

export interface MemoryWrite {
  content: string;
  visibility: "private";
  authorId: string;
  metadata: { speakerId: string };
}

export type Decision =
  | { kind: "drop" }
  | { kind: "none" }
  | { kind: "admitted"; action: string; orgEvent: OrgEvent }
  | { kind: "refused"; action: string; reason: string };

/** `addressed` = the wake name appears in the transcript text (string compare). */
export function addressed(text: string, wakeName: string): boolean {
  if (!wakeName) return false;
  return text.toLowerCase().includes(wakeName.toLowerCase());
}

/** `speakerVerified` = speakerId maps to an enrolled member in BOB's enrolment. */
export function speakerVerified(
  speakerId: string | undefined,
  enrolment: Record<string, string>,
): boolean {
  if (!speakerId) return false;
  return Object.hasOwn(enrolment, speakerId);
}

export const ACKNOWLEDGE_MIN_INTERVAL_MS = 60_000;

function orgEvent(
  kind: string,
  summary: string,
  proposal: Proposal,
  state: PolicyState,
  refId?: string,
): OrgEvent {
  const tsMs = state.nowMs();
  return {
    // A UUID, never a time + short suffix: OrgEvent ids must be unique across
    // processes, not just within one (round 4).
    id: `evt_${kind}_${randomUUID()}`,
    kind,
    authorId: "jarvis",
    // The record shape carries no free metadata: the inputs' ids go in targetIds
    // and the proposal's confidence is stated in the summary.
    summary: `${summary} (confidence ${proposal.confidence})`,
    refId,
    targetIds: proposal.inputs,
    createdAt: new Date(tsMs).toISOString(),
    nonce: randomBytes(8).toString("hex"),
    tsMs,
  };
}

/**
 * Decide what to do with a transcript. Returns:
 *   - drop: muted (no event);
 *   - none: not addressed;
 *   - memory: addressed AND verified → a private memory write + its OrgEvent;
 *   - ephemeral: addressed but NOT verified → no write, at most one acknowledge
 *     per minute for that speaker.
 */
export function decideTranscript(
  transcript: Transcript,
  state: PolicyState,
):
  | { kind: "drop" }
  | { kind: "none" }
  | { kind: "memory"; write: MemoryWrite; orgEvent: OrgEvent }
  | { kind: "ephemeral"; orgEvent?: OrgEvent } {
  if (state.mute) return { kind: "drop" };
  if (!addressed(transcript.text, state.wakeName)) return { kind: "none" };

  const verified = speakerVerified(transcript.speakerId, state.enrolment);
  if (verified && transcript.speakerId) {
    const write: MemoryWrite = {
      content: transcript.text,
      visibility: "private",
      authorId: "jarvis",
      metadata: { speakerId: transcript.speakerId },
    };
    return {
      kind: "memory",
      write,
      orgEvent: orgEvent(
        // INTENT, not outcome: the write has not happened yet. A second,
        // correlated event records written/failed (round 5 item 3).
        "reachy.memory.attempt",
        `attempting a private memory write from a verified speaker ${transcript.speakerId}`,
        {
          action: "think",
          args: {},
          confidence: 1,
          inputs: transcript.speakerId ? [transcript.speakerId] : [],
        },
        state,
      ),
    };
  }

  // Addressed but not verified: EPHEMERAL. At most one acknowledge per minute.
  const last = state.lastAcknowledgeAtMs ?? -Infinity;
  if (state.nowMs() - last < ACKNOWLEDGE_MIN_INTERVAL_MS) {
    return { kind: "ephemeral" };
  }
  return {
    kind: "ephemeral",
    orgEvent: orgEvent(
      "reachy.acknowledge",
      "acknowledged an unverified speaker (ephemeral, no memory)",
      { action: "acknowledge", args: {}, confidence: 1, inputs: [] },
      state,
    ),
  };
}

/**
 * Admit ONE action against the policy — the SAME path a proposal and a tool call
 * take (round 2, item 3). `answer` and memory-backed speech are OFF in v1 (fail
 * closed); `think` injects no turn in S3; `look`/`acknowledge` are rate-limited
 * for an unverified speaker — and ADMITTING one advances the rate limit, so the
 * next within the minute refuses; `ask` is one line; `say` is admitted only when
 * addressed. Every admitted action returns exactly one OrgEvent.
 */
export function admitAction(
  action: ProposalAction,
  args: Record<string, unknown>,
  confidence: number,
  inputs: string[],
  state: PolicyState,
  transcript: Transcript | null,
): Decision {
  if (state.mute) return { kind: "drop" };
  const verified = transcript ? speakerVerified(transcript.speakerId, state.enrolment) : false;
  const isAddressed = transcript ? addressed(transcript.text, state.wakeName) : false;
  const proposal: Proposal = { action, args, confidence, inputs };

  if (action === "answer" || (action === "say" && inputs.length > 0)) {
    // v1: `say` accepts NO memory reference at all — any input is a refusal.
    return { kind: "refused", action, reason: "memory-backed speech is off in v1 (fail closed)" };
  }
  if (action === "think") return { kind: "refused", action, reason: "think injects no turn in S3" };
  if (action === "ignore") return { kind: "none" };
  if (action === "say" && !isAddressed) return { kind: "refused", action, reason: "not addressed" };
  if (
    action === "look" ||
    action === "acknowledge" ||
    action === "frame" ||
    action === "say" ||
    action === "ask"
  ) {
    if (!verified && (action === "look" || action === "acknowledge" || action === "frame")) {
      const last = state.lastAcknowledgeAtMs ?? -Infinity;
      if (state.nowMs() - last < ACKNOWLEDGE_MIN_INTERVAL_MS) {
        return {
          kind: "refused",
          action,
          reason: "unverified speaker, already acknowledged within the minute",
        };
      }
      state.lastAcknowledgeAtMs = state.nowMs();
    }
    const kind =
      action === "look"
        ? "reachy.look"
        : action === "acknowledge"
          ? "reachy.acknowledge"
          : action === "frame"
            ? "reachy.frame"
            : action === "say"
              ? "reachy.say"
              : "reachy.ask";
    return {
      kind: "admitted",
      action,
      orgEvent: orgEvent(kind, `admitted ${action}`, proposal, state),
    };
  }
  return { kind: "none" };
}

/** Decide a proposal — a thin wrapper over `admitAction`, which the tools also use. */
export function decideProposal(
  proposal: Proposal,
  state: PolicyState,
  transcript: Transcript | null,
): Decision {
  return admitAction(
    proposal.action,
    proposal.args,
    proposal.confidence,
    proposal.inputs,
    state,
    transcript,
  );
}
