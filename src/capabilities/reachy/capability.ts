// reachy/capability.ts — the testable core of the `reachy` capability.
//
// Round 3 (Gauge): the audit event IS the observatory record shape; the OrgEvent
// store reads back by EXACT id; `reachy_say` accepts no memory reference at all;
// `reachy_frame` sends a `frame` command with its own audit event.
//
// bob#356 V1 ("mouth first"):
//   * The tools registered are exactly the bob-owned profile's row
//     (config.PROFILE_TOOLS): `voice` has no body tools at all.
//   * Every connection starts with the `reachy-voice/1` handshake (wire.ts):
//     bob sends `configure`, the sidecar's health must match it exactly, and
//     until it does the link is control/status only. A mismatch, a legacy
//     health line or any other line first disconnects and attempts ONE alarm
//     per reason in each failure episode (see linkRefused: latched only once
//     recorded in that episode; retried under a stable record id).
//   * Effective mute = bob mute OR the sidecar-reported mute OR no ready link
//     (unknown/disconnected is muted). No action is sent while muted. The V1
//     sidecar does not read the hardware switch: it reports what its operator
//     configured (`--device-mute`; unknown reports muted).
//   * Speech is split by caller (policy.ts `speechCallerRefusal`), and every
//     action is re-checked after its audit write: a link that reconnected or a
//     mute that flipped during the await refuses the queued command (stale).

import { createHash, randomUUID } from "node:crypto";
import { type TSchema, Type } from "typebox";
import type { TurnOrigin } from "../../shell/turn-origin.js";
import { PROFILE_TOOLS } from "./config.js";
import {
  ACTION_ARG_SCHEMAS,
  admitAction,
  type Caller,
  decideTranscript,
  isValidActionArgs,
  type OrgEvent,
  type PolicyState,
  type ProposalAction,
  type Transcript,
} from "./policy.js";
import {
  checkHealth,
  configureArgs,
  type DecodedLine,
  decodeLine,
  type HandshakeExpectation,
  type SidecarHealth,
} from "./wire.js";

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
  /** Drop the current connection (a failed handshake). The real client closes
   *  its socket; its reconnect starts a fresh handshake. */
  disconnect?(): void;
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
  /** bob#356: the exact sidecar version `health.version` must equal. */
  sidecarVersion: string;
  /** bob#356: the origin a tool call is BOUND to (shell/turn-admission.ts
   *  `boundOrigin`): the admitted turn it runs inside, or the origin the
   *  runtime declared for the session (an operator's one-shot run) — or
   *  undefined, which refuses speech. Absent: nothing is bound, everything
   *  refuses. Never read from the tool's arguments, never defaulted. */
  readOrigin?: () => TurnOrigin | undefined;
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

/** The link to the sidecar as bob sees it (bob#356). Bob's own facts, apart
 *  from the sidecar's assertions (`health`). */
export interface LinkState {
  // configuring: the `configure` write has not completed; handshaking: it
  // has, and bob awaits the matching health line; ready: that line matched.
  phase: "disconnected" | "configuring" | "handshaking" | "ready";
  /** The configuration generation bob pushed on the current connection. */
  generation: number;
  /** The mute the sidecar last reported (V1: operator-configured, not read
   *  from the hardware); undefined = unknown. */
  deviceMuted: boolean | undefined;
  /** bob mute OR sidecar-reported mute OR no ready link. */
  effectiveMuted: boolean;
  /** The last accepted health line — a sidecar ASSERTION, never authority. */
  health: SidecarHealth | null;
}

export interface WiredReachy {
  handleLine(raw: unknown): Promise<DecisionSummary>;
  lastTranscript: () => Transcript | null;
  /** A new connection is open: push `configure` and await the health line. */
  connected(): Promise<void>;
  /** The connection is gone: muted until a fresh handshake. */
  disconnected(): void;
  link(): LinkState;
  /** The tool names registered for the configured profile. */
  tools: readonly string[];
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
  // The last transcript: read ONLY by the body's rate limit and the memory path,
  // never by speech, and cleared whenever the link or the mute changes.
  let lastTranscript: Transcript | null = null;

  // --- the sidecar link (bob#356) ---
  const link: {
    phase: LinkState["phase"];
    generation: number;
    // Bumped on every connect and disconnect: a command admitted on one
    // connection is never sent on another.
    epoch: number;
    deviceMuted: boolean | undefined;
    health: SidecarHealth | null;
    // The alarm reasons RECORDED in the current failure episode: each reason
    // is alarmed at most once per episode once its write is recorded (a fixed,
    // finite set of labels and health-field names, so it stays small).
    alarmed: Set<string>;
    // The current FAILURE EPISODE: the link generations since the last good
    // handshake. A good handshake starts a new episode (new id). An alarm
    // write latches only for the episode it was raised in, and its record id
    // is stable within the episode, so a retried or uncertain write overwrites
    // the same record instead of adding one.
    episodeId: string;
    // A line that arrived before the `configure` write completed: held, and
    // judged only once that write succeeded (never accepted before it).
    held: { raw: unknown } | undefined;
  } = {
    phase: "disconnected",
    generation: 0,
    epoch: 0,
    deviceMuted: undefined,
    health: null,
    alarmed: new Set(),
    episodeId: uuid(),
    held: undefined,
  };
  const effectiveMuted = (): boolean =>
    state.mute || link.phase !== "ready" || link.deviceMuted !== false;
  const expectation = (): HandshakeExpectation => ({
    version: opts.sidecarVersion,
    profile: state.profile,
    wakeName: state.wakeName,
    generation: link.generation,
  });
  const callerOrigin = (): TurnOrigin | undefined => opts.readOrigin?.();

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

  /** Attempt a `reachy.refused` audit, FULL UUID id, optionally
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

  /** Attempt a `reachy.malformed` audit; return malformed even if it fails. */
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

  /** bob#356: the handshake failed (or the link broke protocol). Disconnect,
   *  forget everything the connection said, and attempt a bounded alarm: the
   *  summary carries only fixed reason labels or the names of mismatched health
   *  fields, never the sidecar's values. Within a failure episode (until a good
   *  handshake) a reason whose alarm write was RECORDED in that episode repeats
   *  only in the log — whatever other reasons came between (A, B, A writes two
   *  alarms). A failed write is logged and retried on the next failure with
   *  that reason, under the SAME record id (so an uncertain write that did
   *  persist is overwritten, not duplicated). A write that completes after a
   *  good handshake is recorded but latches nothing in the new episode. */
  async function linkRefused(fields: string[]): Promise<DecisionSummary> {
    link.phase = "disconnected";
    link.held = undefined;
    link.epoch++;
    link.deviceMuted = undefined;
    link.health = null;
    lastTranscript = null;
    try {
      commands.disconnect?.();
    } catch (err) {
      log(`reachy: disconnect failed: ${err instanceof Error ? err.message : err}`);
    }
    const key = fields.join(", ");
    log(`reachy: sidecar handshake refused (${key}); disconnected`);
    if (!link.alarmed.has(key)) {
      const tsMs = state.nowMs();
      const episode = link.episodeId;
      const recorded = await audit({
        // Stable per episode and reason: retries upsert one record.
        id: `evt_reachy.link.refused_${episode}_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
        kind: "reachy.link.refused",
        authorId: "jarvis",
        summary: `refused the sidecar link: ${key} did not match the reachy-voice/1 handshake; disconnected`,
        targetIds: [],
        createdAt: new Date(tsMs).toISOString(),
        nonce: uuid(),
        tsMs,
      });
      // Latch only a RECORDED alarm, and only for the episode it belongs to:
      // a lost one is retried, never assumed; a late one latches nothing.
      if (!recorded) {
        log(`reachy: the link alarm (${key}) was not recorded; it is retried on the next failure`);
      } else if (link.episodeId !== episode) {
        log(
          `reachy: the link alarm (${key}) was recorded after the link recovered; it latches nothing`,
        );
      } else {
        link.alarmed.add(key);
      }
    }
    return { kind: "refused", action: "handshake", reason: `handshake failed: ${key}` };
  }

  /** Admit ONE action (proposal or tool) — one OrgEvent per admitted command. */
  async function admitAndRun(
    action: ProposalAction,
    args: Record<string, unknown>,
    confidence: number,
    inputs: string[],
    caller: Caller,
  ): Promise<DecisionSummary> {
    // The args are untrusted: validate them BY ACTION before the policy runs, so
    // a string yaw / extra field / prose-shaped arg is `reachy.malformed` and is
    // NEVER sent (round 6 item 2). `ask` is one of the speech actions.
    if (!isValidActionArgs(action, args)) {
      return malformed(`proposal action '${action}' failed its argument schema`);
    }
    // bob#356: no action leaves bob without a ready, unmuted link (bob mute,
    // the sidecar-reported mute, or an unknown/disconnected link — all muted).
    if (effectiveMuted()) return { kind: "drop" };
    const epoch = link.epoch;
    const decision = admitAction(action, args, confidence, inputs, state, caller);
    if (decision.kind === "drop") return { kind: "drop" };
    if (decision.kind === "none") return { kind: "none" };
    if (decision.kind === "refused") return refuse(decision.action, decision.reason);
    // Speech carries a bob-issued playback id; the audit event names it, so the
    // record and the sidecar's playback correlate without the spoken text.
    const isSpeech = decision.action === "say" || decision.action === "ask";
    const playbackId = isSpeech ? `play_${uuid()}` : undefined;
    if (playbackId !== undefined) {
      decision.orgEvent.targetIds = [...(decision.orgEvent.targetIds ?? []), playbackId];
    }
    if (!(await audit(decision.orgEvent)))
      return { kind: "refused", action: decision.action, reason: "audit write failed" };
    // bob#356: the audit was awaited. If the link reconnected or the mute
    // flipped meanwhile, this command belongs to a state that is gone: refuse
    // it (linked to the admitted event) rather than send it into the new one.
    if (link.epoch !== epoch || effectiveMuted()) {
      return refuse(
        decision.action,
        "stale: the sidecar link or the mute changed during admission",
        orgEventRecordId(decision.orgEvent),
      );
    }
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
      await commands.send(cmd, playbackId !== undefined ? { ...args, playbackId } : args);
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

  // --- tools (bob#356: exactly the profile's row, registered synchronously) ---
  const toolText = (r: DecisionSummary, admitted: string): string =>
    r.kind === "admitted"
      ? admitted
      : r.kind === "drop"
        ? "refused: muted (bob mute, sidecar-reported mute, or no ready reachy-voice/1 sidecar link)"
        : `refused: ${"reason" in r ? r.reason : r.kind}`;
  const tools = PROFILE_TOOLS[state.profile];
  const register: Record<string, () => void> = {
    reachy_look: () =>
      pi.registerTool({
        name: "reachy_look",
        label: "Reachy Look",
        description: "Request `look_at` with yaw/pitch in degrees through the policy gate.",
        // SAME definition as the runtime: the tool parameter schema IS
        // ACTION_ARG_SCHEMAS.look (round 10), so pi advertises the exact bounds
        // admitAndRun enforces (yaw [-180,180], pitch [-90,90]) and never presents
        // an input the runtime rejects as malformed.
        parameters: ACTION_ARG_SCHEMAS.look,
        async execute(_id, params) {
          const r = await admitAndRun("look", { yaw: params.yaw, pitch: params.pitch }, 1, [], {
            path: "tool",
            origin: callerOrigin(),
          });
          return ok(toolText(r, `look_at yaw=${params.yaw} pitch=${params.pitch}`));
        },
      }),
    reachy_say: () =>
      pi.registerTool({
        name: "reachy_say",
        label: "Reachy Say",
        description:
          "Speak one short line in the room through the speaker. Only from a turn the operator granted room speech; no memory reference.",
        // NO memoryId field: any extra property is rejected by the SCHEMA
        // (`additionalProperties: false`), which pi validates BEFORE execute — so in
        // a live pi call an extra argument never reaches execute at all. The check
        // below is belt-and-braces for a DIRECT caller of execute (a test, or any
        // code that invokes the tool without pi's validation).
        //
        // Round 10: the schema IS ACTION_ARG_SCHEMAS.say — the SAME definition the
        // runtime validates against — so the advertised bounds (one line, ≤500 chars)
        // match what admitAndRun accepts, and `additionalProperties: false` still
        // rejects a memory reference.
        parameters: ACTION_ARG_SCHEMAS.say,
        async execute(_id, params) {
          const extra = Object.keys(params).filter((k) => k !== "text");
          if (extra.length > 0) {
            const r = await refuse("say", `unexpected parameter(s): ${extra.join(", ")}`);
            return ok(`refused: ${"reason" in r ? r.reason : r.kind}`);
          }
          // bob#356: the TOOL path. The caller is the admitted turn this call
          // runs inside (runtime metadata), never anything the room said.
          const r = await admitAndRun("say", { text: params.text }, 1, [], {
            path: "tool",
            origin: callerOrigin(),
          });
          return ok(toolText(r, `say: ${params.text}`));
        },
      }),
    reachy_state: () =>
      pi.registerTool({
        name: "reachy_state",
        label: "Reachy State",
        description:
          "PLACEHOLDER: the command channel has no request/response correlation yet, so this returns no sidecar state. Declared as a placeholder in the manifest and README.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          // A failed send is a sentence, not a thrown tool call: the tool stays
          // registered even when the sidecar is down (round 5 review). `state` is
          // status traffic; the client waits for the configure write.
          try {
            const st = await commands.send("state");
            return ok(JSON.stringify(st ?? {}));
          } catch (err) {
            return ok(`state unavailable: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      }),
    reachy_frame: () =>
      pi.registerTool({
        name: "reachy_frame",
        label: "Reachy Frame",
        description: "Request `frame` through the policy gate.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          const r = await admitAndRun("frame", {}, 1, [], { path: "tool", origin: callerOrigin() });
          return ok(toolText(r, "frame requested"));
        },
      }),
  };
  for (const name of tools) {
    const reg = register[name];
    if (!reg) throw new Error(`reachy: no registration for the ${state.profile} tool ${name}`);
    reg();
  }

  /** The health line was accepted: update what bob knows. A flip of the device
   *  mute (either way) forgets the last transcript. */
  function acceptHealth(health: SidecarHealth): void {
    // Every mute TRANSITION (on or off) forgets the last transcript and
    // advances the epoch, so an admission pending across it — even one that
    // flips back before its audit returns — is refused as stale (bob#356).
    if (link.deviceMuted !== undefined && link.deviceMuted !== health.muted) {
      lastTranscript = null;
      link.epoch++;
    }
    link.deviceMuted = health.muted;
    link.health = health;
  }

  async function handleLine(raw: unknown): Promise<DecisionSummary> {
    const decoded: DecodedLine = decodeLine(raw);
    if (state.mute) return { kind: "drop" };
    // A line with no live connection behind it (it raced a disconnect) is
    // dropped: nothing it says is current, and dropping it bounds the audit.
    if (link.phase === "disconnected") return { kind: "drop" };

    // bob#356: the first line that arrives before the `configure` write
    // succeeded is HELD, for `connected()` to judge after the write; a second
    // such line is refused at once (it fails the link without waiting).
    if (link.phase === "configuring") {
      if (link.held !== undefined) return linkRefused(["lines before configure was written"]);
      link.held = { raw };
      return { kind: "none" };
    }

    // bob#356: before the handshake, the only acceptable line is the health
    // reply to this connection's `configure`. Anything else fails the link.
    if (link.phase === "handshaking") {
      if (decoded.kind !== "health") {
        return linkRefused([
          decoded.kind === "malformed"
            ? decoded.protocol
              ? "health"
              : "malformed line"
            : `${decoded.kind} before the handshake`,
        ]);
      }
      const bad = checkHealth(decoded.health, expectation());
      if (bad.length > 0) return linkRefused(bad);
      link.phase = "ready";
      link.alarmed = new Set();
      link.episodeId = uuid(); // a good handshake ends the failure episode
      acceptHealth(decoded.health);
      log(`reachy: sidecar link ready (reachy-voice/1, generation ${link.generation})`);
      return { kind: "none" };
    }

    // Ready. Every later health line must still match exactly; a mismatch, or a
    // health line that is not reachy-voice/1, fails the link and attempts an alarm,
    // retrying that reason after a failed write.
    if (decoded.kind === "health") {
      const bad = checkHealth(decoded.health, expectation());
      if (bad.length > 0) return linkRefused(bad);
      acceptHealth(decoded.health);
      return { kind: "none" };
    }
    if (decoded.kind === "malformed" && decoded.protocol) return linkRefused(["health"]);
    // With bob mute off on a ready voice link, attempt a content-free presence
    // audit and return malformed even if it fails, regardless of sidecar mute.
    if (decoded.kind === "presence" && state.profile !== "reachy") {
      return malformed("a presence line under the voice profile (no camera)");
    }
    // The sidecar-reported mute drops transcripts and proposals, like bob's own.
    if (effectiveMuted()) return { kind: "drop" };

    if (decoded.kind === "malformed") {
      return malformed(decoded.reason);
    }
    if (decoded.kind === "presence") return { kind: "none" }; // the body profile

    if (decoded.kind === "transcript") {
      // bob#361: the connection epoch this transcript was accepted on. The
      // memory-attempt audit is awaited below; a link that reconnects, or a
      // sidecar-reported mute transition (even on and back off), advances the
      // epoch and makes the accepted transcript stale; bob's own mute is read as
      // the effective mute at the recheck. Both are rechecked after the audit,
      // before the memory write.
      const epoch = link.epoch;
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
        // refusal. bob's flair client has no delete, so the memory stays, carrying
        // the pre-generated `written` id; `explainMemory` reads exactly that id, so
        // it explains the memory only if that event was persisted anyway (a store
        // that persists and then throws) and targets the memory.
        const attempt = decision.orgEvent;
        const attemptId = orgEventRecordId(attempt);
        const persisted = await audit(attempt);
        if (!persisted) return refuse("memory", "audit write failed — memory NOT written");
        // bob#361: the attempt audit was awaited. If the epoch advanced or the
        // link is effectively muted now, this transcript belongs to a state that
        // is gone: write no memory and attempt a refusal linked to the attempt
        // event (the same stale rule the action path applies after its audit);
        // `refused` is returned even if that refusal's audit write fails.
        if (link.epoch !== epoch || effectiveMuted()) {
          return refuse(
            "memory",
            "stale: the sidecar link or the mute changed during the memory attempt audit",
            attemptId,
          );
        }

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

        // SUCCESS only when the store holds THIS event under the EXACT
        // pre-generated id (round 7 item 2): the write must REPORT that id (when
        // it reports one at all) AND the event must READ BACK as the `written`
        // outcome that TARGETS this memory. Any mismatch, or a null readback, is
        // the SAME path as a failed `written` write — never a success.
        let persistError: { klass: string; detail: string } | null = null;
        try {
          const writtenResult = (await store.write(written)) as { id?: unknown } | undefined;
          if (
            writtenResult &&
            typeof writtenResult.id === "string" &&
            writtenResult.id !== writtenId
          ) {
            persistError = {
              klass: "IdMismatch",
              detail: `store persisted id ${JSON.stringify(writtenResult.id)}, not ${JSON.stringify(writtenId)}`,
            };
          } else {
            const readback = await store.getById(writtenId);
            if (!readback) {
              persistError = {
                klass: "ReadbackMissing",
                detail: `no event at ${writtenId} after the write`,
              };
            } else if (readback.kind !== "reachy.memory.written") {
              persistError = {
                klass: "ReadbackKind",
                detail: `event at ${writtenId} has kind ${JSON.stringify(readback.kind)}`,
              };
            } else if (!Array.isArray(readback.targetIds) || !readback.targetIds.includes(id)) {
              persistError = {
                klass: "ReadbackTargets",
                detail: `event at ${writtenId} does not target the memory ${id}`,
              };
            }
          }
        } catch (err) {
          persistError = {
            klass: err instanceof Error ? err.name : "Error",
            detail: err instanceof Error ? err.message : String(err),
          };
        }
        if (persistError) {
          await audit({
            id: `evt_reachy.memory.failed_${uuid()}`,
            kind: "reachy.memory.failed",
            authorId: "jarvis",
            summary: `memory ${id} written but its 'written' audit FAILED (${persistError.klass}): ${persistError.detail} — UNAUDITED`,
            refId: attemptId,
            targetIds: [id],
            createdAt: new Date(state.nowMs()).toISOString(),
            nonce: uuid(),
            tsMs: state.nowMs(),
          });
          log(
            `reachy: the 'written' audit for memory ${id} failed after the memory was created (${persistError.klass}): ${persistError.detail} — refusing (unaudited)`,
          );
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
        { path: "proposal", transcript: lastTranscript },
      );
    }
    return { kind: "none" };
  }

  async function connected(): Promise<void> {
    link.epoch++;
    link.generation++;
    link.phase = "configuring";
    link.held = undefined;
    link.deviceMuted = undefined;
    link.health = null;
    lastTranscript = null;
    const epoch = link.epoch;
    try {
      // Configure is the first command; its write must succeed before health
      // is judged. Status sends wait behind that write in the socket client.
      await commands.send("configure", configureArgs(expectation()));
    } catch (err) {
      if (link.epoch !== epoch) return;
      log(`reachy: configure send failed: ${err instanceof Error ? err.message : err}`);
      await linkRefused(["configure send"]);
      return;
    }
    if (link.epoch !== epoch) return;
    link.phase = "handshaking";
    // (handleLine may have set it during the awaited write.)
    const held = link.held as { raw: unknown } | undefined;
    link.held = undefined;
    if (held !== undefined) await handleLine(held.raw);
  }

  function disconnected(): void {
    link.phase = "disconnected";
    link.held = undefined;
    link.epoch++;
    link.deviceMuted = undefined;
    link.health = null;
    lastTranscript = null;
  }

  log(`reachy capability: profile ${state.profile}; registered ${tools.join(" / ")}`);
  return {
    handleLine,
    lastTranscript: () => lastTranscript,
    connected,
    disconnected,
    link: () => ({
      phase: link.phase,
      generation: link.generation,
      deviceMuted: link.deviceMuted,
      effectiveMuted: effectiveMuted(),
      health: link.health,
    }),
    tools,
  };
}
