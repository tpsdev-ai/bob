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
  isValidActionArgs,
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
    // Explicit record id (agent + randomUUID) so the memory is unique across
    // processes, not just within one (round 4).
    id?: string;
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
  /** Id seam (tests): every generated id and nonce comes from here. */
  uuid?: () => string;
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

/** Tools that are declared but not yet wired to a real sidecar reply (round 4):
 *  the command channel has no request/response correlation, so `reachy_state`
 *  returns no sidecar state. Named here so the manifest and README can label it. */
export const PLACEHOLDER_TOOLS = ["reachy_state"] as const;

/** The record id a reachy OrgEvent is stored under (exact-fetchable). */
export function orgEventRecordId(event: OrgEvent): string {
  return `orgevent-${event.id}`;
}

export function wireReachyCapability(opts: WireOptions): WiredReachy {
  const { pi, commands, memory, store, state } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));
  const uuid = opts.uuid ?? (() => randomUUID());
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

  /** A refusal is itself audited as `reachy.refused`, FULL UUID id, optionally
   *  LINKED to the event it refuses (`refId`). */
  async function refuse(action: string, reason: string, refId?: string): Promise<DecisionSummary> {
    const tsMs = state.nowMs();
    await audit({
      id: `evt_reachy.refused_${uuid()}`,
      kind: "reachy.refused",
      authorId: "jarvis",
      summary: `refused ${action}: ${reason}`,
      ...(refId !== undefined ? { refId } : {}),
      targetIds: [],
      createdAt: new Date(tsMs).toISOString(),
      nonce: uuid(),
      tsMs,
    });
    return { kind: "refused", action, reason };
  }

  /** A malformed line/proposal is itself audited as `reachy.malformed`, FULL
   *  UUID id, and NEVER sent (round 6 item 2). */
  async function malformed(reason: string): Promise<DecisionSummary> {
    const tsMs = state.nowMs();
    await audit({
      id: `evt_reachy.malformed_${uuid()}`,
      kind: "reachy.malformed",
      authorId: "jarvis",
      summary: `dropped a malformed sidecar line: ${reason}`,
      targetIds: [],
      createdAt: new Date(tsMs).toISOString(),
      nonce: uuid(),
      tsMs,
    });
    return { kind: "malformed", reason };
  }

  /** Admit ONE action (proposal or tool) — one OrgEvent per admitted command. */
  async function admitAndRun(
    action: ProposalAction,
    args: Record<string, unknown>,
    confidence: number,
    inputs: string[],
  ): Promise<DecisionSummary> {
    // The args are untrusted: validate them BY ACTION before the policy runs, so
    // a string yaw / extra field / prose-shaped arg is `reachy.malformed` and is
    // NEVER sent (round 6 item 2). `ask` is one of the speech actions.
    if (!isValidActionArgs(action, args)) {
      return malformed(`proposal action '${action}' failed its argument schema`);
    }
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
    // The audit said ADMITTED, so a send that then fails must not look like a
    // delivered command: catch it, log it, and return a LINKED refusal so the
    // caller gets a refusal rather than a rejected promise (round 5 review).
    try {
      await commands.send(cmd, args);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log(`reachy: command '${decision.action}' admitted but the sidecar send failed: ${detail}`);
      return refuse(
        decision.action,
        `sidecar send failed: ${detail}`,
        orgEventRecordId(decision.orgEvent),
      );
    }
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
    // NO memoryId field: any extra property is rejected by the SCHEMA
    // (`additionalProperties: false`), which pi validates BEFORE execute — so in
    // a live pi call an extra argument never reaches execute at all. The check
    // below is belt-and-braces for a DIRECT caller of execute (a test, or any
    // code that invokes the tool without pi's validation).
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
    description:
      "PLACEHOLDER: the command channel has no request/response correlation yet, so this returns no sidecar state. Declared as a placeholder in the manifest and README.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      // A failed send is a sentence, not a thrown tool call: the tool stays
      // registered even when the sidecar is down (round 5 review).
      try {
        const st = await commands.send("state");
        return ok(JSON.stringify(st ?? {}));
      } catch (err) {
        return ok(`state unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      return malformed(decoded.reason);
    }
    if (decoded.kind === "health" || decoded.kind === "presence") return { kind: "none" };

    if (decoded.kind === "transcript") {
      lastTranscript = decoded.transcript;
      const decision = decideTranscript(decoded.transcript, state);
      if (decision.kind === "drop") return { kind: "drop" };
      if (decision.kind === "none") return { kind: "none" };
      if (decision.kind === "memory") {
        // THREE correlated events (round 5 item 3 / round 6 item 1): the ATTEMPT
        // (intent) is written first with an exact id; the memory then carries the
        // id of the OUTCOME event — the `written` event, NEVER the attempt — and
        // that `written` event is persisted BEFORE any success is returned. If the
        // `written` write fails after the memory exists, there is NO success: a
        // linked `reachy.memory.failed` is logged and the result is an UNAUDITED
        // refusal. bob's flair client has no delete, so the memory stays (carrying
        // the now-missing `written` id) and `explainMemory` returns nothing.
        const attempt = decision.orgEvent;
        const attemptId = orgEventRecordId(attempt);
        const persisted = await audit(attempt);
        if (!persisted) return refuse("memory", "audit write failed — memory NOT written");

        // Pre-generate the OUTCOME event so the memory can carry ITS record id: a
        // memory must resolve to a `written` event, never the attempt.
        const tsMs = state.nowMs();
        const written: OrgEvent = {
          id: `evt_reachy.memory.written_${uuid()}`,
          kind: "reachy.memory.written",
          authorId: "jarvis",
          summary: "", // filled once the memory id is known
          refId: attemptId,
          targetIds: [],
          createdAt: new Date(tsMs).toISOString(),
          nonce: uuid(),
          tsMs,
        };
        const writtenId = orgEventRecordId(written);

        let id: string;
        try {
          ({ id } = await memory.writePrivate({
            ...decision.write,
            metadata: {
              speakerId: decoded.transcript.speakerId as string,
              correlationId: `corr_${uuid()}`,
              orgEventId: writtenId,
            },
          }));
        } catch (err) {
          const klass = err instanceof Error ? err.name : "Error";
          const detail = err instanceof Error ? err.message : String(err);
          await audit({
            id: `evt_reachy.memory.failed_${uuid()}`,
            kind: "reachy.memory.failed",
            authorId: "jarvis",
            summary: `memory write FAILED (${klass}): ${detail}`,
            refId: attemptId,
            targetIds: [],
            createdAt: new Date(state.nowMs()).toISOString(),
            nonce: uuid(),
            tsMs: state.nowMs(),
          });
          log(`reachy: memory write failed after attempt ${attemptId} (${klass}): ${detail}`);
          return refuse("memory", `memory write failed after attempt: ${detail}`, attemptId);
        }

        written.summary = `wrote the private memory ${id} for the verified speaker ${decoded.transcript.speakerId as string}`;
        written.targetIds = [id];

        // SUCCESS only after the `written` event is PERSISTED (round 6 item 1).
        // A memory without its `written` audit is UNAUDITED, never a success.
        let outcomePersisted = true;
        try {
          await store.write(written);
        } catch (err) {
          outcomePersisted = false;
          const klass = err instanceof Error ? err.name : "Error";
          const detail = err instanceof Error ? err.message : String(err);
          await audit({
            id: `evt_reachy.memory.failed_${uuid()}`,
            kind: "reachy.memory.failed",
            authorId: "jarvis",
            summary: `memory ${id} written but its 'written' audit FAILED (${klass}): ${detail} — UNAUDITED`,
            refId: attemptId,
            targetIds: [id],
            createdAt: new Date(state.nowMs()).toISOString(),
            nonce: uuid(),
            tsMs: state.nowMs(),
          });
          log(
            `reachy: the 'written' audit for memory ${id} failed after the memory was created (${klass}): ${detail} — refusing (unaudited)`,
          );
        }
        if (!outcomePersisted) {
          return refuse(
            "memory",
            "the memory exists but its written-event audit failed — unaudited",
            attemptId,
          );
        }
        return { kind: "memory", memoryId: id };
      }
      if (decision.orgEvent) {
        // RESERVE the rate slot SYNCHRONOUSLY, before the awaited audit (round 5
        // item 2): the socket path runs handlers concurrently, so advancing the
        // limit only after an await let two visitor lines BOTH acknowledge while
        // the store was slow. Roll the reservation back if the audit fails.
        const reservedAt = state.nowMs();
        const previous = state.lastAcknowledgeAtMs;
        state.lastAcknowledgeAtMs = reservedAt;
        if (!(await audit(decision.orgEvent))) {
          state.lastAcknowledgeAtMs = previous;
          return refuse("acknowledge", "audit write failed");
        }
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
