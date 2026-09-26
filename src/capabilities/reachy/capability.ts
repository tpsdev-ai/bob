// reachy/capability.ts — the testable core of the `reachy` capability.
//
// Decoupled from pi's real ExtensionAPI, the real UNIX socket and the real Flair
// client so it is unit-testable with fakes. `index.ts` is the thin factory.
//
// Round 2 (Gauge): (1) inbound lines are DECODED here by wire.ts (one shape,
// schema-checked); a malformed line is an OrgEvent `reachy.malformed`, never a
// throw. (2) the OrgEvent trail is PERSISTED through the same store the memory
// goes through, and ORDERED — the event is written FIRST with a correlation id,
// then the memory carrying that id; if the event write fails, the memory is NOT
// written. (3) the tools go through the SAME admit path as proposals.
//
// S3 registers tools and consumes events; it injects NO turns (that is S1).

import { randomUUID } from "node:crypto";
import { type TSchema, Type } from "typebox";
import {
  admitAction,
  decideTranscript,
  type OrgEvent,
  type PolicyState,
  type ProposalAction,
  type Transcript,
} from "./policy.js";
import { type DecodedLine, decodeLine } from "./wire.js";

export interface PiLike {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

/** The sidecar command channel (real: a UNIX socket; test: a recorder). */
export interface ReachyCommands {
  send(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** The DURABLE OrgEvent store (real: the flair client; test: a fake, persistent). */
export interface OrgEventStore {
  write(event: OrgEvent): Promise<{ id: string }>;
  readByCorrelation(correlationId: string): Promise<OrgEvent | null>;
}

/** The memory write seam (real: the flair client; test: a fake). */
export interface MemoryWriter {
  writePrivate(write: {
    content: string;
    visibility: "private";
    authorId: string;
    metadata: { speakerId: string; correlationId: string };
  }): Promise<{ id: string }>;
}

export interface WireOptions {
  pi: PiLike;
  commands: ReachyCommands;
  memory: MemoryWriter;
  store: OrgEventStore;
  state: PolicyState;
  log?: (msg: string) => void;
}

export type DecisionSummary =
  | { kind: "drop" }
  | { kind: "none" }
  | { kind: "malformed"; reason: string }
  | { kind: "memory"; memoryId: string }
  | { kind: "ephemeral"; acknowledged: boolean }
  | { kind: "admitted"; action: string }
  | { kind: "refused"; action: string; reason: string };

export interface WiredReachy {
  handleLine(raw: unknown): Promise<DecisionSummary>;
  lastTranscript: () => Transcript | null;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function wireReachyCapability(opts: WireOptions): WiredReachy {
  const { pi, commands, memory, store, state } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));
  let lastTranscript: Transcript | null = null;

  /** Write the audit event; true iff it was persisted. */
  async function audit(event: OrgEvent): Promise<boolean> {
    try {
      await store.write(event);
      return true;
    } catch (err) {
      log(
        `reachy: could not persist OrgEvent ${event.id} (${err instanceof Error ? err.message : err})`,
      );
      return false;
    }
  }

  /** Admit ONE action (proposal or tool) — one OrgEvent per admitted command. */
  async function admitAndRun(
    action: ProposalAction,
    args: Record<string, unknown>,
    confidence: number,
    inputs: string[],
  ): Promise<DecisionSummary> {
    const decision = admitAction(action, args, confidence, inputs, state, lastTranscript);
    if (decision.kind === "drop") return { kind: "drop" };
    if (decision.kind === "none") return { kind: "none" };
    if (decision.kind === "refused")
      return { kind: "refused", action: decision.action, reason: decision.reason };
    // ORDER: persist the audit BEFORE acting; a lost audit means the command is not sent.
    if (!(await audit(decision.orgEvent)))
      return { kind: "refused", action: decision.action, reason: "audit write failed" };
    const cmd =
      decision.action === "look"
        ? "look_at"
        : decision.action === "acknowledge"
          ? "acknowledge"
          : "say";
    await commands.send(cmd, args);
    return { kind: "admitted", action: decision.action };
  }

  // --- the four tools (spec §3.1). look / say / frame are ACTING commands and go
  // through admitAndRun; state is a plain health READ and is not an action. ---
  pi.registerTool({
    name: "reachy_look",
    label: "Reachy Look",
    description:
      "Turn the Reachy Mini's head to a yaw/pitch (degrees). Goes through the policy gate.",
    parameters: Type.Object({ yaw: Type.Number(), pitch: Type.Number() }),
    async execute(_id, params) {
      const r = await admitAndRun("look", { yaw: params.yaw, pitch: params.pitch }, 1, []);
      return ok(
        r.kind === "admitted"
          ? `look_at yaw=${params.yaw} pitch=${params.pitch}`
          : `refused: ${"reason" in r ? r.reason : r.kind}`,
      );
    },
  });
  pi.registerTool({
    name: "reachy_say",
    label: "Reachy Say",
    description:
      "Speak a line through the Reachy Mini's speaker. Memory-backed speech is off in v1.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1 }),
      // Any memory-derived content is refused in v1 (fail closed).
      memoryId: Type.Optional(
        Type.String({ description: "A memory id this line would speak — refused in v1." }),
      ),
    }),
    async execute(_id, params) {
      const inputs = params.memoryId ? [String(params.memoryId)] : [];
      const r = await admitAndRun("say", { text: params.text }, 1, inputs);
      return ok(
        r.kind === "admitted"
          ? `say: ${params.text}`
          : `refused: ${"reason" in r ? r.reason : r.kind}`,
      );
    },
  });
  pi.registerTool({
    name: "reachy_state",
    label: "Reachy State",
    description: "Read the sidecar's health/state (a read; not an action).",
    parameters: Type.Object({}),
    async execute() {
      const st = await commands.send("state");
      return ok(JSON.stringify(st ?? {}));
    },
  });
  pi.registerTool({
    name: "reachy_frame",
    label: "Reachy Frame",
    description: "Capture one JPEG frame (on demand only). Goes through the policy gate.",
    parameters: Type.Object({}),
    async execute() {
      const r = await admitAndRun("acknowledge", {}, 1, []); // frame is a physical capture, gated like an acknowledge
      return ok(
        r.kind === "admitted" ? "frame requested" : `refused: ${"reason" in r ? r.reason : r.kind}`,
      );
    },
  });

  async function handleLine(raw: unknown): Promise<DecisionSummary> {
    const decoded: DecodedLine = decodeLine(raw);
    if (state.mute) return { kind: "drop" };

    if (decoded.kind === "malformed") {
      // A malformed line does NOTHING to policy; it is recorded as an audit event.
      await audit({
        id: `evt_reachy.malformed_${Date.now()}_${randomUUID().slice(0, 8)}`,
        kind: "reachy.malformed",
        authorId: "jarvis",
        summary: `dropped a malformed sidecar line: ${decoded.reason}`,
        metadata: {},
        tsMs: Date.now(),
      });
      return { kind: "malformed", reason: decoded.reason };
    }
    if (decoded.kind === "health" || decoded.kind === "presence") return { kind: "none" };

    if (decoded.kind === "transcript") {
      lastTranscript = decoded.transcript;
      const decision = decideTranscript(decoded.transcript, state);
      if (decision.kind === "drop") return { kind: "drop" };
      if (decision.kind === "none") return { kind: "none" };
      if (decision.kind === "memory") {
        // ORDER: event first (with the correlation id), then the memory carrying it.
        const correlationId = `corr_${randomUUID()}`;
        const persisted = await audit({
          ...decision.orgEvent,
          metadata: {
            ...decision.orgEvent.metadata,
            speakerId: decoded.transcript.speakerId,
            correlationId,
          },
        });
        if (!persisted)
          return {
            kind: "refused",
            action: "memory",
            reason: "audit write failed — memory NOT written",
          };
        const { id } = await memory.writePrivate({
          ...decision.write,
          metadata: { speakerId: decoded.transcript.speakerId as string, correlationId },
        });
        return { kind: "memory", memoryId: id };
      }
      if (decision.orgEvent) {
        if (
          !(await audit({ ...decision.orgEvent, refId: decoded.transcript.speakerId ?? undefined }))
        )
          return { kind: "refused", action: "acknowledge", reason: "audit write failed" };
        state.lastAcknowledgeAtMs = state.nowMs();
        return { kind: "ephemeral", acknowledged: true };
      }
      return { kind: "ephemeral", acknowledged: false };
    }

    if (decoded.kind === "proposal") {
      return admitAndRun(
        decoded.proposal.action,
        decoded.proposal.args,
        decoded.proposal.confidence,
        decoded.proposal.inputs,
      );
    }
    return { kind: "none" };
  }

  log("reachy capability: registered reachy_look / reachy_say / reachy_state / reachy_frame");
  return { handleLine, lastTranscript: () => lastTranscript };
}
