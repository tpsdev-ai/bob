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

import { Type } from "typebox";
import { Value } from "typebox/value";

export type ProposalAction = "ignore" | "look" | "acknowledge" | "answer" | "think" | "ask" | "say";

/** The typed proposal schema (spec §3.3): constrained decoding, NEVER prose. A
 *  prose-only proposal (a free-text field, no action) fails this schema. */
export const PROPOSAL_SCHEMA = Type.Object(
  {
    action: Type.Union([
      Type.Literal("ignore"),
      Type.Literal("look"),
      Type.Literal("acknowledge"),
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

export interface OrgEvent {
  id: string;
  kind: string;
  authorId: string;
  summary: string;
  refId?: string;
  metadata: Record<string, unknown>;
  tsMs: number;
}

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
  return {
    id: `evt_${kind}_${state.nowMs()}`,
    kind,
    authorId: "jarvis",
    summary,
    refId,
    // Every admitted action carries the proposal's confidence and its inputs' ids.
    metadata: { confidence: proposal.confidence, inputs: proposal.inputs },
    tsMs: state.nowMs(),
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
      orgEvent: (() => {
        const ev = orgEvent(
          "reachy.memory",
          "wrote a private memory from a verified speaker",
          { action: "think", args: {}, confidence: 1, inputs: [] },
          state,
        );
        ev.metadata.speakerId = transcript.speakerId;
        return ev;
      })(),
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

const MEMORY_BACKED_ACTIONS = new Set(["answer", "think"]);

/**
 * Decide what to do with a proposal. Authority stays in bob: `answer` and
 * memory-backed speech are OFF in v1 (fail closed); `look`/`acknowledge` are
 * rate-limited; `ask` is one line; only `presence`-safe, non-memory `say` may
 * emit. `think` injects no turn in S3.
 */
export function decideProposal(
  proposal: Proposal,
  state: PolicyState,
  transcript: Transcript | null,
): Decision {
  if (state.mute) return { kind: "drop" };

  const verified = transcript ? speakerVerified(transcript.speakerId, state.enrolment) : false;
  const isAddressed = transcript ? addressed(transcript.text, state.wakeName) : false;

  // Memory-backed speech OFF outright: a `say`/`answer` that references memory
  // inputs is refused, whatever the speaker.
  if (
    MEMORY_BACKED_ACTIONS.has(proposal.action) ||
    (proposal.action === "say" && proposal.inputs.some((i) => i.startsWith("mem_")))
  ) {
    return {
      kind: "refused",
      action: proposal.action,
      reason: "memory-backed speech is off in v1 (fail closed)",
    };
  }
  if (proposal.action === "think") {
    return { kind: "refused", action: proposal.action, reason: "think injects no turn in S3" };
  }
  if (proposal.action === "ignore") return { kind: "none" };
  if (proposal.action === "ask") {
    return {
      kind: "admitted",
      action: "ask",
      orgEvent: orgEvent("reachy.ask", "asked a one-line question", proposal, state),
    };
  }
  if (proposal.action === "say") {
    if (!isAddressed) return { kind: "refused", action: "say", reason: "not addressed" };
    return {
      kind: "admitted",
      action: "say",
      orgEvent: orgEvent("reachy.say", "said a non-memory line", proposal, state),
    };
  }
  if (proposal.action === "look" || proposal.action === "acknowledge") {
    // Physical action: rate-limited for an unverified speaker (one per minute).
    if (!verified) {
      const last = state.lastAcknowledgeAtMs ?? -Infinity;
      if (state.nowMs() - last < ACKNOWLEDGE_MIN_INTERVAL_MS) {
        return {
          kind: "refused",
          action: proposal.action,
          reason: "unverified speaker, already acknowledged within the minute",
        };
      }
    }
    const kind = proposal.action === "look" ? "reachy.look" : "reachy.acknowledge";
    return {
      kind: "admitted",
      action: proposal.action,
      orgEvent: orgEvent(kind, `admitted ${proposal.action}`, proposal, state),
    };
  }
  return { kind: "none" };
}
