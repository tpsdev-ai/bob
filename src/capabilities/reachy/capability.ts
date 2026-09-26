// reachy/capability.ts — the testable core of the `reachy` capability.
//
// Round 3 (Gauge): the audit event IS the observatory record shape; the OrgEvent
// store reads back by EXACT id; `reachy_say` accepts no memory reference at all;
// `reachy_frame` sends a `frame` command with its own audit event.

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

/** The DURABLE OrgEvent store (real: the flair client; test: a fake, id-keyed). */
export interface OrgEventStore {
  write(event: OrgEvent): Promise<{ id: string }>;
  /** EXACT read by the record id (never a semantic search). */
  getById(id: string): Promise<OrgEvent | null>;
}

/** The memory write seam (real: the flair client; test: a fake). */
export interface MemoryWriter {
  writePrivate(write: {
    content: string;
    visibility: "private";
    authorId: string;
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
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

/** The record id a reachy OrgEvent is stored under (exact-fetchable). */
export function orgEventRecordId(event: OrgEvent): string {
  return `orgevent-${event.id}`;
}

export function wireReachyCapability(opts: WireOptions): WiredReachy {
  const { pi, commands, memory, store, state } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));
  let lastTranscript: Transcript | null = null;

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

  /** A refusal is itself audited as `reachy.refused`. */
  async function refuse(action: string, reason: string): Promise<DecisionSummary> {
    const tsMs = state.nowMs();
    await audit({
      id: `evt_reachy.refused_${tsMs}_${randomUUID().slice(0, 8)}`,
      kind: "reachy.refused",
      authorId: "jarvis",
      summary: `refused ${action}: ${reason}`,
      targetIds: [],
      createdAt: new Date(tsMs).toISOString(),
      nonce: randomUUID(),
      tsMs,
    });
    return { kind: "refused", action, reason };
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
    if (decision.kind === "refused") return refuse(decision.action, decision.reason);
    if (!(await audit(decision.orgEvent)))
      return { kind: "refused", action: decision.action, reason: "audit write failed" };
    const cmd =
      decision.action === "look"
        ? "look_at"
        : decision.action === "acknowledge"
          ? "acknowledge"
          : decision.action === "frame"
            ? "frame"
            : "say";
    await commands.send(cmd, args);
    return { kind: "admitted", action: decision.action };
  }

  // --- tools ---
  pi.registerTool({
    name: "reachy_look",
    label: "Reachy Look",
    description:
      "Turn the Reachy Mini's head to a yaw/pitch (degrees). Goes through the policy gate.",
    parameters: Type.Object(
      { yaw: Type.Number(), pitch: Type.Number() },
      { additionalProperties: false },
    ),
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
      "Speak a line through the speaker. v1: NO memory reference — a memory id makes it a refusal.",
    // NO memoryId field: any extra property is rejected by the schema and refused.
    parameters: Type.Object(
      { text: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      const extra = Object.keys(params).filter((k) => k !== "text");
      if (extra.length > 0) {
        const r = await refuse("say", `unexpected parameter(s): ${extra.join(", ")}`);
        return ok(`refused: ${"reason" in r ? r.reason : r.kind}`);
      }
      const r = await admitAndRun("say", { text: params.text }, 1, []);
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
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const st = await commands.send("state");
      return ok(JSON.stringify(st ?? {}));
    },
  });
  pi.registerTool({
    name: "reachy_frame",
    label: "Reachy Frame",
    description:
      "Capture one JPEG frame (on demand only). Sends a `frame` command; goes through the gate.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const r = await admitAndRun("frame", {}, 1, []);
      return ok(
        r.kind === "admitted" ? "frame requested" : `refused: ${"reason" in r ? r.reason : r.kind}`,
      );
    },
  });

  async function handleLine(raw: unknown): Promise<DecisionSummary> {
    const decoded: DecodedLine = decodeLine(raw);
    if (state.mute) return { kind: "drop" };

    if (decoded.kind === "malformed") {
      const tsMs = state.nowMs();
      await audit({
        id: `evt_reachy.malformed_${tsMs}_${randomUUID().slice(0, 8)}`,
        kind: "reachy.malformed",
        authorId: "jarvis",
        summary: `dropped a malformed sidecar line: ${decoded.reason}`,
        targetIds: [],
        createdAt: new Date(tsMs).toISOString(),
        nonce: randomUUID(),
        tsMs,
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
        // ORDER: event first (exact id), then the memory carrying that id.
        const persisted = await audit(decision.orgEvent);
        if (!persisted) return refuse("memory", "audit write failed — memory NOT written");
        const { id } = await memory.writePrivate({
          ...decision.write,
          metadata: {
            speakerId: decoded.transcript.speakerId as string,
            correlationId: `corr_${randomUUID()}`,
            orgEventId: orgEventRecordId(decision.orgEvent),
          },
        });
        return { kind: "memory", memoryId: id };
      }
      if (decision.orgEvent) {
        if (!(await audit(decision.orgEvent))) return refuse("acknowledge", "audit write failed");
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
