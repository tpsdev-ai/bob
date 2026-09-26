// reachy/capability.ts — the testable core of the `reachy` capability.
//
// Decoupled from pi's real ExtensionAPI, the real UNIX socket and the real Flair
// client so it is unit-testable with fakes (spec §5 S3 builds on a STUB sidecar).
// `index.ts` is the thin factory that wires the real pieces.
//
// S3 scope: register the four tools and CONSUME events. There is NO turn
// injection in S3 (that is S1, behind bob#147) — a proposal is admitted (an
// OrgEvent) and, for a physical action, sent to the sidecar; nothing enters the
// pi turn stream here.

import { type TSchema, Type } from "typebox";
import {
  decideProposal,
  decideTranscript,
  type OrgEvent,
  type PolicyState,
  type Proposal,
  type Transcript,
} from "./policy.js";

// The minimal slice of pi's ExtensionAPI this core needs (declared structurally
// so a tiny fake and the real ExtensionAPI both satisfy it).
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

/** The memory write seam (real: the flair capability client; test: a fake). */
export interface MemoryWriter {
  writePrivate(write: {
    content: string;
    visibility: "private";
    authorId: string;
    metadata: { speakerId: string };
  }): Promise<{ id: string }>;
}

/** Event seam (real: the observatory/OrgEvent sink; test: a recorder). */
export type EmitOrgEvent = (event: OrgEvent) => Promise<void> | void;

export interface WireOptions {
  pi: PiLike;
  commands: ReachyCommands;
  memory: MemoryWriter;
  emit: EmitOrgEvent;
  state: PolicyState;
  log?: (msg: string) => void;
}

export interface ReachEvents {
  transcript?: Transcript;
  proposal?: Proposal;
  presence?: { count: number; known: string[] };
  health?: Record<string, unknown>;
}

function ok(text: string): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text }], details: {} };
}

export interface WiredReachy {
  handleEvent(
    event: ReachEvents,
    kind: "transcript" | "proposal" | "presence" | "health",
  ): Promise<DecisionSummary>;
  lastTranscript: Transcript | null;
}

export type DecisionSummary =
  | { kind: "drop" }
  | { kind: "none" }
  | { kind: "memory"; memoryId: string }
  | { kind: "ephemeral"; acknowledged: boolean }
  | { kind: "admitted"; action: string }
  | { kind: "refused"; action: string; reason: string };

export function wireReachyCapability(opts: WireOptions): WiredReachy {
  const { pi, commands, memory, emit, state } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));

  // --- the four tools (spec §3.1) ---------------------------------------
  pi.registerTool({
    name: "reachy_look",
    label: "Reachy Look",
    description: "Turn the Reachy Mini's head to a yaw/pitch (degrees).",
    parameters: Type.Object({
      yaw: Type.Number({ description: "Yaw in degrees." }),
      pitch: Type.Number({ description: "Pitch in degrees." }),
    }),
    async execute(_id, params) {
      await commands.send("look_at", { yaw: params.yaw, pitch: params.pitch });
      return ok(`look_at yaw=${params.yaw} pitch=${params.pitch}`);
    },
  });
  pi.registerTool({
    name: "reachy_say",
    label: "Reachy Say",
    description:
      "Speak a line through the Reachy Mini's speaker. Memory-backed speech is off in v1.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, description: "The line to speak." }),
    }),
    async execute(_id, params) {
      await commands.send("say", { text: params.text });
      return ok(`say: ${params.text}`);
    },
  });
  pi.registerTool({
    name: "reachy_state",
    label: "Reachy State",
    description: "Read the sidecar's health/state.",
    parameters: Type.Object({}),
    async execute() {
      const st = await commands.send("state");
      return ok(JSON.stringify(st ?? {}));
    },
  });
  pi.registerTool({
    name: "reachy_frame",
    label: "Reachy Frame",
    description: "Capture one JPEG frame from the Reachy Mini's camera (on demand only).",
    parameters: Type.Object({}),
    async execute() {
      const frame = await commands.send("frame");
      return ok(typeof frame === "string" ? frame : "frame requested");
    },
  });

  let lastTranscript: Transcript | null = null;

  async function handleEvent(
    event: ReachEvents,
    kind: "transcript" | "proposal" | "presence" | "health",
  ): Promise<DecisionSummary> {
    if (state.mute) return { kind: "drop" };

    if (kind === "health" || kind === "presence") {
      // Presence counts are ephemeral; neither drives a write or an action.
      return { kind: "none" };
    }

    if (kind === "transcript" && event.transcript) {
      lastTranscript = event.transcript;
      const decision = decideTranscript(event.transcript, state);
      if (decision.kind === "drop") return { kind: "drop" };
      if (decision.kind === "none") return { kind: "none" };
      if (decision.kind === "memory") {
        const { id } = await memory.writePrivate(decision.write);
        await emit({ ...decision.orgEvent, refId: id });
        return { kind: "memory", memoryId: id };
      }
      // ephemeral
      if (decision.orgEvent) {
        state.lastAcknowledgeAtMs = state.nowMs();
        await emit({ ...decision.orgEvent, refId: event.transcript.speakerId ?? undefined });
        return { kind: "ephemeral", acknowledged: true };
      }
      return { kind: "ephemeral", acknowledged: false };
    }

    if (kind === "proposal" && event.proposal) {
      const decision = decideProposal(event.proposal, state, lastTranscript);
      if (decision.kind === "drop") return { kind: "drop" };
      if (decision.kind === "none") return { kind: "none" };
      if (decision.kind === "refused")
        return { kind: "refused", action: decision.action, reason: decision.reason };
      // admitted: record the OrgEvent, then carry out the physical/ask line.
      await emit(decision.orgEvent);
      if (decision.action === "look" || decision.action === "acknowledge") {
        await commands.send(
          decision.action === "look" ? "look_at" : "acknowledge",
          event.proposal.args,
        );
      } else if (decision.action === "ask" || decision.action === "say") {
        await commands.send("say", { text: String(event.proposal.args.text ?? "") });
      }
      return { kind: "admitted", action: decision.action };
    }

    return { kind: "none" };
  }

  log("reachy capability: registered reachy_look / reachy_say / reachy_state / reachy_frame");
  return {
    handleEvent,
    get lastTranscript() {
      return lastTranscript;
    },
  } as WiredReachy;
}
