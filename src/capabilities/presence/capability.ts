// The testable core of the presence capability, decoupled from pi's real
// ExtensionAPI so it can be unit-tested with fakes (no live Flair, no real key,
// no network). index.ts is the thin factory that builds the real
// FlairHttpClient (the same signing client the flair capability uses) and calls
// this — one signed client per agent, one liveness system.
//
// WHAT THIS WIRE
//
// The presence capability is one liveness system replacing the old "heartbeat"
// catalog placeholder. It reports a named, runtime-authored presence to the
// Flair roster and writes a metadata-only turn summary at turn end. It wires
// FOUR subscriptions to pi and ONE beacon interval:
//
//   1. before_agent_start  — read the turn's origin from the out-of-band registry (takePendingOrigin)
//                             and stamp the turn start time. The origin is the
//                             single source of truth for the busy-beat label and
//                             the turn summary's origin field.
//   2. agent_start         — BEAT busy: { activity: busyActivity,
//                             currentTask: originLabel(origin) }. This stamps the
//                             server's lastHeartbeatAt so the 10-min offline TTL
//                             starts from the turn, and marks the agent busy.
//   3. agent_settled       — BEAT idle: { activity: "idle", currentTask: null }.
//                             Settled (not agent_end) because settled means no
//                             retry/compaction/queued continuation will run — so
//                             idle does not flap busy→idle→busy between queued
//                             mails. The beacon (4) keeps lastHeartbeatAt fresh
//                             during the turn so a 20-minute turn never reads as
//                             "offline".
//   4. agent_end           — TURN SUMMARY (fire-and-forget): a metadata-only
//                             record written to Flair Memory via the same signed
//                             PUT the flair capability uses (flair.write).
//
//   beacon (setInterval)    — liveness-only beat: presenceBeat({}) — an empty
//                             body. The server PRESERVES the prior activity
//                             stamp on an empty beat (natural presence), so the
//                             beacon cannot erase a busy stamp. A crashed
//                             process stops emitting beats and the roster decays
//                             to offline in 10 minutes (the TTL) — no explicit
//                             "dead" write needed.
//
// CONTENT DECISION — METADATA ONLY, BY CONSTRUCTION (the secrets-property test):
//
//   * origin labels are runtime-authored, capped, and carry NO prompt text,
//     model text, or tool output (only a kind + a short id).
//   * a turn summary carries ONLY counts, labels, timestamps, and lengths — the
//     final assistant text's char COUNT (not the text), tool call NAMES (not
//     their output), and the origin label. There is no code path that reads
//     prompt / model / tool *content* into the recorded object.
//   * the currentTask label is capped at config.currentTaskMaxChars (default
//     120), tighter than the server's 200-cap, so a long origin id cannot
//     inflate it.
//
// FAILURE MODES (never throw into pi, never block a turn):
//   * All beats are fire-and-forget: presenceBeat is called, its promise is
//     .catch-ed by a collapsed-failure logger (one log line per distinct
//     failure, not 60s of spam), and .finally clears the in-flight flag.
//   * In-flight cap: at most ONE presence beat is in flight at a time; extra
//     beats are dropped (this is a beacon, not a queue).
//   * Turn summaries retry up to SUMMARY_MAX_RETRIES (2) then drop + log once.
//     A summary write never blocks the turn (fire-and-forget) and never throws
//     into pi.

import { originLabel, type TurnOrigin } from "../../shell/turn-origin.js";
import { takePendingOrigin } from "../../shell/turn-origin-registry.js";
import type { Durability } from "../flair/client.js";
import type { PresenceActivity, PresenceCapabilityConfig } from "./config.js";

// The single in-flight cap + the beacon cadence share a small seam surface so
// tests can drive them deterministically.

// A single presence beat's body: an optional activity label and an optional
// (currently-tasked) label. presenceBeat turns this into a POST /Presence body
// that includes a field only when it is present — so an empty object is a
// liveness-only beat, and { activity: "idle", currentTask: null } is an idle
// beat (the server preserves the prior activity stamp on the empty body).
export interface PresenceBeatOpts {
  activity?: PresenceActivity;
  currentTask?: string | null;
}

// The narrow Flair surface the presence capability depends on. FlairHttpClient
// satisfies this: presenceBeat is a new method (POST /Presence) and write is
// the existing signed Memory PUT the flair capability already uses for
// narrative memory. Keep this narrow so a fake in tests implements two
// methods, not the whole client.
export interface PresenceFlairClient {
  presenceBeat(opts: PresenceBeatOpts): Promise<void>;
  write(
    content: string,
    opts?: { durability?: Durability; supersedes?: string },
  ): Promise<{ id: string }>;
}

// A pi assistant message, narrowed to what the turn-summary traversal reads.
// Declared structurally so both a test fake and pi's real AgentMessage satisfy
// it (mirrors the discord capability's AssistantMessageLike).
export interface PresenceMessage {
  role: string;
  content: unknown;
}

// The minimal slice of pi's ExtensionAPI this core needs. Structurally typed
// so a fake in tests and the real ExtensionAPI both satisfy it.
export interface PresencePiLike {
  on(event: "before_agent_start", handler: (e: { prompt: string }) => void | Promise<void>): void;
  on(event: "agent_start", handler: (e: Record<string, never>) => void | Promise<void>): void;
  on(event: "agent_settled", handler: (e: Record<string, never>) => void | Promise<void>): void;
  on(
    event: "agent_end",
    handler: (e: { messages: PresenceMessage[] }) => void | Promise<void>,
  ): void;
  // Returns the registered tool names. A model-supplied toolCall whose name is
  // NOT in this set is bucketed under "other" in the turn summary, so a crafted
  // tool name (e.g. "SECRET") can never surface verbatim.
  getAllTools(): Array<{ name: string }>;
}

// A beacon timer seam. The production default wraps setInterval (unref'd); a
// test fake records the fire fn so it can trigger ticks manually.
export interface BeaconHandle {
  // Fire one beacon tick (test-only; production uses the interval).
  tick(): void;
  // Stop the interval (idempotent).
  stop(): void;
}
export type BeaconScheduler = (intervalMs: number, fire: () => void) => BeaconHandle;

export interface WirePresenceOptions {
  pi: PresencePiLike;
  flair: PresenceFlairClient;
  config: PresenceCapabilityConfig;
  // Logger seam — defaults to console.error. NOTHING here ever logs the key
  // (it lives only inside the client).
  log?: (msg: string) => void;
  // Test seams (all optional, default to real node behavior).
  now?: () => number;
  scheduleBeacon?: BeaconScheduler;
  sleep?: (ms: number) => Promise<void>;
}

// What wirePresence returns so a caller (or a test) can stop the beacon.
export interface PresenceHandle {
  stop(): void;
}

// ─── Constants ─────────────────────────────────────────────────────────────

// Defaults for the cadence / caps.
export const DEFAULT_BEACON_INTERVAL_MS = 60_000;
export const DEFAULT_CURRENT_TASK_MAX = 120;
export const DEFAULT_SUMMARY_DURABILITY: Durability = "standard";
export const DEFAULT_SUMMARY_MAX_CHARS = 2048;

// Bounded retry for the turn-summary write. Forensic memory, not transactional.
export const SUMMARY_MAX_RETRIES = 2;
export const SUMMARY_RETRY_DELAY_MS = 250;

// ─── Turn-summary traversal helpers ────────────────────────────────────────
//
// All three helpers read from an array of pi AssistantMessage-shaped objects
// and return only counts, labels, or a char length. NONE of them read the
// *content* of a prompt / model output / tool output into the returned object.

// Read the text blocks of an assistant message. Mirrors the discord
// capability's finalAssistantText / assistantContentToText helpers.
function assistantContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") {
      out += block;
      continue;
    }
    const b = block as { type?: string; text?: string };
    if (b && b.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

// The final assistant text of a turn — the text of the LAST assistant message.
// Returns "" for a tool-only turn. This is the text whose *length* (not the
// text itself) goes into a turn summary.
function finalAssistantText(messages: PresenceMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    return assistantContentToText(msg.content).trim();
  }
  return "";
}

// Count assistant messages (one per model response turn).
function countAssistantMessages(messages: PresenceMessage[]): number {
  let n = 0;
  for (const m of messages) if (m && m.role === "assistant") n++;
  return n;
}

// Count tool calls by tool *name*. `registeredTools` is REQUIRED (round-3
// item 3): only names in the registered set (from pi.getAllTools()) are counted
// by name; any other tool name — a model-supplied name outside the registered
// set (e.g. "SECRET") — is bucketed under the "other" key, so a crafted tool
// name can never surface verbatim in the summary. There is no raw-name fallback:
// an unregistered name is always "other". This never reads a tool-result (the
// *output*) message — only toolCall *names* are counted, so the counts carry no
// tool-output content.
function countToolCallsByTool(
  messages: PresenceMessage[],
  registeredTools: Set<string>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of messages) {
    if (m?.role !== "assistant") continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: string; name?: string };
      if (b.type === "toolCall" && typeof b.name === "string") {
        const name = b.name;
        // Count only registered tool names; an unknown, model-supplied name is
        // bucketed under "other" (round-3 item 3) so it cannot surface verbatim.
        const key = registeredTools.has(name) ? name : "other";
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  }
  return counts;
}

// ─── Turn summary ──────────────────────────────────────────────────────────
//
// Build a metadata-only turn summary: a JSON object describing a turn purely
// by counts / labels / timestamps / lengths. No prompt, model, or tool *content*
// is ever read into the object. See the header comments for the full
// content-decision rationale.

export interface BuildTurnSummaryArgs {
  agent: string;
  origin: TurnOrigin;
  startedAt: number; // epoch millis
  endedAt: number; // epoch millis
  messages: PresenceMessage[];
  maxChars: number;
  // Registered tool set (from pi.getAllTools()) — REQUIRED (round-3 item 3); a model-supplied tool name
  // outside this set is bucketed under "other" (round-3 item 3: no crafted tool name
  // can surface verbatim in the summary).
  registeredTools: Set<string>;
}

// Build the turn summary JSON string. The output is guaranteed to be at most
// `maxChars` characters: when the full record exceeds the cap, a compact
// "truncated" variant (kind + v + truncated + agent + origin) is emitted so
// the record is still self-identifying and parseable, then hard-sliced to
// maxChars as a final safety net.
export function buildTurnSummary(args: BuildTurnSummaryArgs): string {
  const { agent, origin, startedAt, endedAt, messages, maxChars, registeredTools } = args;
  const final = finalAssistantText(messages);
  const turns = countAssistantMessages(messages);
  const toolCalls = countToolCallsByTool(messages, registeredTools);
  const base = {
    kind: "turn-summary",
    v: 1,
    agent,
    origin,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: Math.max(0, endedAt - startedAt),
    turns,
    toolCalls,
    finalTextChars: final.length,
    truncated: false,
  };
  const json = JSON.stringify(base);
  if (json.length <= maxChars) return json;

  // Truncation (item 5): NEVER hard-slice serialized JSON (that can leave an
  // unparseable fragment like "{"). Instead emit a progressively smaller, self-
  // identifying record — each a complete, valid JSON object — dropping the
  // unbounded `origin` first, then `agent`, until one fits within maxChars. The
  // floor record {kind,v,truncated} is ~48 chars, which fits any maxChars >= the
  // 256 config floor, so the output is ALWAYS valid JSON with truncated:true.
  return truncateSummary(agent, origin, maxChars);
}

// Item 5 truncation helper: try progressively smaller self-identifying records,
// each a complete valid JSON object (never a sliced fragment), until one fits.
// Fields are dropped widest-first: `origin` (unbounded — a long agent/channel
// id), then `agent`, then the bare {kind,v,truncated}. Never a .slice().
function truncateSummary(agent: string, origin: TurnOrigin, maxChars: number): string {
  const tiers: Array<Record<string, unknown>> = [
    { kind: "turn-summary", v: 1, truncated: true, agent, origin },
    { kind: "turn-summary", v: 1, truncated: true, agent },
    { kind: "turn-summary", v: 1, truncated: true },
  ];
  for (const tier of tiers) {
    const s = JSON.stringify(tier);
    if (s.length <= maxChars) return s;
  }
  // Fallback (should not trigger with the 256 floor): the minimal record is
  // ~48 chars and always fits; return it anyway so the result is valid JSON.
  return JSON.stringify(tiers[tiers.length - 1]);
}

// ─── wirePresence ──────────────────────────────────────────────────────────

// The production beacon: a setInterval that fires a liveness-only beat every
// `intervalMs`. unref'd so the beacon never keeps the process alive on its own.
function defaultBeaconScheduler(intervalMs: number, fire: () => void): BeaconHandle {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = (): void => {
    if (timer !== undefined) return;
    timer = setInterval(fire, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  };
  start();
  return {
    tick(): void {
      fire();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}

export function wirePresence(opts: WirePresenceOptions): PresenceHandle {
  const { pi, flair, config } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // ── Resolve config defaults ────────────────────────────────────────
  const beaconIntervalMs = config.beaconIntervalMs ?? DEFAULT_BEACON_INTERVAL_MS;
  // Item 6 (defense in depth): clamp to at most 120 even if a caller builds
  // the config object directly (bypassing loadConfigFromEnv validation).
  const currentTaskMax = Math.min(config.currentTaskMaxChars ?? DEFAULT_CURRENT_TASK_MAX, 120);
  const busyActivity: PresenceActivity = config.busyActivity ?? "coding";
  const summaryEnabled = !(config.summary && config.summary.enabled === false);
  const summaryDurability: Durability = config.summary?.durability ?? DEFAULT_SUMMARY_DURABILITY;
  const summaryMaxChars = config.summary?.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS;

  // ── Turn state (set in before_agent_start, consumed in agent_end) ──
  // `currentOrigin` is the origin of the turn currently in flight. It is the
  // single source of truth for the busy-beat label AND the turn summary's
  // origin field, so a turn that was driven by mail/cron/discord is reported
  // as such in BOTH places.
  let currentOrigin: TurnOrigin = { kind: "run" };
  let turnStartedAt = now();

  // ── Beat in-flight cap + state-never-dropped (item 4) ─────────────
  // At most ONE presence beat is in flight at a time. Beacon (liveness-only)
  // beats are droppable when a beat is already in flight. But STATE transitions
  // (the busy and idle beats) are NEVER dropped: if a beat is in flight when a
  // state transition arrives, the latest desired state is held as pending (last
  // write wins) and sent when the in-flight beat finishes. This is why the
  // in-flight cap is only for the beacon, not for state transitions.
  let beatInFlight = false;
  // Pending desired state (last write wins): set by beatState while a beat is
  // in flight; drained by sendNow's finally.
  let pendingState: PresenceBeatOpts | null = null;
  // ── Collapsed-failure logging: one line per distinct failure ─────────
  // If a beat fails and the prior failure had the same signature, we do not
  // log again. The flag is reset on success, so a recovery + a *new* failure
  // logs once.
  let lastBeatFailureSig: string | null = null;

  const logBeatFailure = (err: unknown): void => {
    const sig = err instanceof Error ? err.message : String(err);
    if (sig === lastBeatFailureSig) return; // collapse identical consecutive failures
    lastBeatFailureSig = sig;
    const reason = err instanceof Error ? err.message : "presence beat failed";
    log(`presence: heartbeat failed: ${reason}`);
  };

  const onBeatSuccess = (): void => {
    // A successful beat resets the collapse flag so the NEXT distinct
    // failure logs again.
    lastBeatFailureSig = null;
  };

  // ── sendNow: occupy the in-flight lane, send one beat, drain pending state
  // Fire-and-forget: a beat must never throw into pi, never block. On settle
  // (success, failure, or timeout), if a state transition arrived while this beat
  // was in flight, send it now. Recursion is bounded: each sendNow can only
  // queue the single latest pending state (set by beatState); it terminates.
  const sendNow = (o: PresenceBeatOpts): void => {
    beatInFlight = true;
    void flair
      .presenceBeat(o)
      .then(onBeatSuccess)
      .catch((err: unknown) => logBeatFailure(err))
      .finally(() => {
        beatInFlight = false;
        // Drain any pending state transition (item 4): last write captured.
        if (pendingState !== null) {
          const next = pendingState;
          pendingState = null;
          sendNow(next);
        }
      });
  };

  // Liveness-only (beacon) beat: droppable. If a beat is already in flight,
  // drop it - a beacon is a liveness ping, not a transition that must land.
  const beatBeacon = (): void => {
    if (beatInFlight) return;
    sendNow({});
  };

  // State transition (busy / idle beat): NEVER dropped (item 4). If a beat is
  // in flight, hold this as pendingState (last write wins); when the in-flight
  // beat finishes, sendNow's finally drains it.
  const beatState = (o: PresenceBeatOpts): void => {
    if (beatInFlight) {
      pendingState = o; // last write wins
      return;
    }
    sendNow(o);
  };

  // ── before_agent_start: parse origin + stamp turn start ─────────────
  // The origin is the single source of truth for the busy-beat label and
  // the turn summary's origin field. `turnStartedAt` feeds durationMs.
  pi.on("before_agent_start", () => {
    currentOrigin = takePendingOrigin();
    turnStartedAt = now();
  });

  // ── agent_start: busy beat ──────────────────────────────────────────
  // Mark the agent busy + report a runtime-authored currentTask derived from
  // the origin (capped at currentTaskMax). This also stamps the server's
  // lastHeartbeatAt so the 10-min offline TTL starts from the turn.
  pi.on("agent_start", () => {
    beatState({
      activity: busyActivity,
      currentTask: originLabel(currentOrigin, currentTaskMax),
    });
  });

  // ── agent_settled: idle beat ────────────────────────────────────────
  // Mark the agent idle. Uses agent_settled (not agent_end) because settled
  // means no retry/compaction/queued continuation will run — so idle does not
  // flap busy→idle→busy between queued mails.
  pi.on("agent_settled", () => {
    beatState({ activity: "idle", currentTask: null });
  });

  // ── agent_end: turn summary (fire-and-forget) ────────────────────────
  // Build + write a metadata-only turn summary. Bounded retry ×2 then drop +
  // log once. Never blocks the turn, never throws into pi.
  pi.on("agent_end", (e) => {
    if (!summaryEnabled) return;
    const messages = e.messages;
    // Item 2: the registered tool set; a model-supplied toolCall whose name is
    // not in this set is bucketed under "other" so a crafted name cannot surface.
    const registeredTools = new Set(pi.getAllTools().map((t) => t.name));
    void (async (): Promise<void> => {
      let content: string;
      try {
        content = buildTurnSummary({
          agent: config.agentId,
          origin: currentOrigin,
          startedAt: turnStartedAt,
          endedAt: now(),
          messages,
          maxChars: summaryMaxChars,
          registeredTools,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : "build failed";
        log(`presence: turn summary build failed (dropped): ${reason}`);
        return;
      }
      for (let attempt = 0; attempt <= SUMMARY_MAX_RETRIES; attempt++) {
        try {
          await flair.write(content, { durability: summaryDurability });
          return;
        } catch (err) {
          if (attempt < SUMMARY_MAX_RETRIES) {
            await sleep(SUMMARY_RETRY_DELAY_MS);
            continue;
          }
          const reason = err instanceof Error ? err.message : "write failed";
          log(
            `presence: turn summary write failed after ${SUMMARY_MAX_RETRIES + 1} attempts (dropped): ${reason}`,
          );
          return;
        }
      }
    })().catch((err: unknown) => {
      // Last-resort guard: the inner async IIFE already catches its own
      // errors, so this only catches an unexpected throw from the IIFE
      // itself (e.g. a synchronous throw in the try block).
      const reason = err instanceof Error ? err.message : "unknown";
      log(`presence: turn summary failed: ${reason}`);
    });
  });

  // ── Beacon: liveness-only beat on an interval ─────────────────────────
  // Fires presenceBeat({}) — an empty body — so the server PRESERVES the
  // prior activity stamp (natural presence). The beacon runs during and
  // between turns, so a 20-minute turn never reads as "offline" (the 90s
  // idle threshold keys off lastHeartbeatAt, which the busy beat set once
  // at turn start and the beacon keeps fresh).
  const beacon = (opts.scheduleBeacon ?? defaultBeaconScheduler)(beaconIntervalMs, () => {
    beatBeacon();
  });

  return {
    stop(): void {
      beacon.stop();
    },
  };
}
