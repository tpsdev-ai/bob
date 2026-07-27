// snapshot.ts — the snapshot/event BUILDER (pure, testable core).
//
// Turns each office agent's static identity (role/model from bob.yaml) + its
// live signals (a Beads in-progress summary, a heartbeat timestamp) into the
// wire shapes the observatory ingests:
//   * AgentStatus    — one per agent, → ObsAgentSnapshot upsert
//   * OrgEventRecord — events the agent caused (PR/review/mail/state) → ObsEventFeed
//
// HARD RULES enforced here (then re-enforced by sanitize() before POST):
//   * currentTask is the Beads in-progress task SUMMARY/title — NEVER the raw
//     prompt or the session transcript. The reader hands us a summary; we never
//     read a transcript.
//   * events carry SUMMARY/METADATA only — never mail/message BODIES.
//   * status is the enum active | idle | offline | stale, derived from the
//     heartbeat age vs. staleThresholdSeconds (Kern's schema addition):
//       - offline : the agent reports itself deliberately stopped (signal absent
//                   AND no heartbeat) → not crashed, just down.
//       - stale   : has a last heartbeat but it is older than the threshold
//                   (crashed / missed) — the renderer dots this red.
//       - active  : heartbeat fresh AND a currentTask is in progress.
//       - idle    : heartbeat fresh AND no currentTask.
//
// This module is PURE: it takes already-read signal values (the fs read lives in
// the reader seam in client.ts), so it is fully unit-testable with plain data.

import { webcrypto } from "node:crypto";

// --- wire shapes (mirror tps-observatory/resources/IngestEvents.ts) ---------

// AgentStatus is what IngestEvents upserts into ObsAgentSnapshot. NOTE: the
// current ingest endpoint's AgentStatus interface does not yet carry
// `currentTask`/`type` (it drops them on upsert) — see the package README/report.
// We emit them anyway so the producer is correct against the schema + ready when
// the endpoint adds them (a forward-compat, harmless-extra-field choice).
export interface AgentStatus {
  agentId: string;
  name?: string;
  role?: string;
  type?: "agent" | "human";
  model?: string;
  status: AgentLiveStatus;
  currentTask?: string;
  lastSeen?: string; // → ObsAgentSnapshot.lastActivity
  lastHeartbeat?: string;
}

export type AgentLiveStatus = "active" | "idle" | "offline" | "stale";

// OrgEventRecord is what IngestEvents inserts into ObsEventFeed. Each record also
// carries a `nonce` (uuid) + `tsMs` (unix ms) for per-record replay protection
// (Sherlock; the server dedup store lands by CP2). These are extra fields the
// current endpoint ignores but the signed batch already binds a batch-level
// ts/nonce in the Authorization header (see client.ts).
export interface OrgEventRecord {
  id: string;
  kind: string;
  authorId: string;
  summary: string;
  refId?: string;
  scope?: string;
  targetIds?: string[];
  createdAt: string;
  nonce: string;
  tsMs: number;
}

// --- builder inputs --------------------------------------------------------

// The live signal an agent emits, already READ from disk (the fs read is the
// reader seam in client.ts; this builder stays pure).
export interface AgentSignal {
  agentId: string;
  name?: string;
  role?: string;
  model?: string;
  type?: "agent" | "human";
  // The Beads in-progress task SUMMARY/title, or undefined when nothing is in
  // progress. NEVER the raw prompt / transcript.
  currentTaskSummary?: string;
  // Unix ms of the agent's last heartbeat, or undefined when there is no
  // heartbeat signal at all (→ offline).
  lastHeartbeatMs?: number;
  // Unix ms of last observed activity (defaults to lastHeartbeatMs).
  lastActivityMs?: number;
  // Events this agent caused since the last tick — summary/metadata only.
  events?: AgentEventInput[];
}

// One event an agent caused, as the reader hands it in (summary/metadata only).
export interface AgentEventInput {
  // PR opened/merged, review posted, mail sent, state transition, …
  kind: string;
  // A one-line SUMMARY. NEVER a mail/message body or a transcript.
  summary: string;
  // Optional reference (PR url/number, mail id, bead id) — metadata, not body.
  refId?: string;
  // Optional scope (repo, channel, …).
  scope?: string;
  // Optional recipients/targets (ids only).
  targetIds?: string[];
  // Unix ms the event occurred (defaults to the tick time).
  occurredAtMs?: number;
}

export interface BuildOptions {
  // Threshold (seconds) past which a heartbeat is "stale". Default 600.
  staleThresholdSeconds?: number;
  // Tick time (unix ms) — seam for tests. Defaults to Date.now().
  now?: () => number;
  // uuid seam for nonces — defaults to webcrypto.randomUUID.
  uuid?: () => string;
}

const DEFAULT_STALE_THRESHOLD_SECONDS = 600;

// deriveStatus — the enum logic, isolated so the test pins each branch.
export function deriveStatus(
  signal: Pick<AgentSignal, "lastHeartbeatMs" | "currentTaskSummary">,
  nowMs: number,
  staleThresholdSeconds: number,
): AgentLiveStatus {
  // No heartbeat at all → deliberately down / never started.
  if (signal.lastHeartbeatMs === undefined) return "offline";
  const ageMs = nowMs - signal.lastHeartbeatMs;
  if (ageMs > staleThresholdSeconds * 1000) return "stale";
  // Fresh heartbeat: active iff a task is in progress, else idle.
  return signal.currentTaskSummary ? "active" : "idle";
}

// buildAgentStatus — one signal → one AgentStatus (snapshot). Pure.
export function buildAgentStatus(signal: AgentSignal, opts: BuildOptions = {}): AgentStatus {
  const nowMs = (opts.now ?? (() => Date.now()))();
  const staleThreshold = opts.staleThresholdSeconds ?? DEFAULT_STALE_THRESHOLD_SECONDS;
  const status = deriveStatus(signal, nowMs, staleThreshold);
  const lastActivityMs = signal.lastActivityMs ?? signal.lastHeartbeatMs;
  return {
    agentId: signal.agentId,
    name: signal.name ?? signal.agentId,
    role: signal.role,
    type: signal.type ?? "agent",
    model: signal.model,
    status,
    // currentTask is the Beads SUMMARY only (may be undefined when idle/offline).
    currentTask: signal.currentTaskSummary,
    lastSeen: lastActivityMs !== undefined ? new Date(lastActivityMs).toISOString() : undefined,
    lastHeartbeat:
      signal.lastHeartbeatMs !== undefined
        ? new Date(signal.lastHeartbeatMs).toISOString()
        : undefined,
  };
}

// buildEvents — an agent's event inputs → OrgEventRecords (with nonce + tsMs).
// The record id is deterministic per (authorId, kind, occurredAt, refId) so a
// re-report of the same event dedups server-side (IngestEvents skips an existing
// feedId) instead of duplicating the feed.
export function buildEvents(signal: AgentSignal, opts: BuildOptions = {}): OrgEventRecord[] {
  const nowMs = (opts.now ?? (() => Date.now()))();
  const uuid = opts.uuid ?? (() => webcrypto.randomUUID());
  const inputs = signal.events ?? [];
  return inputs.map((ev) => {
    const occurredAtMs = ev.occurredAtMs ?? nowMs;
    const createdAt = new Date(occurredAtMs).toISOString();
    // Deterministic, replay-safe id: author + kind + time + ref. Stable across
    // re-reports of the same underlying event → server dedup, not duplication.
    const id = `${signal.agentId}:${ev.kind}:${occurredAtMs}:${ev.refId ?? ""}`;
    const rec: OrgEventRecord = {
      id,
      kind: ev.kind,
      authorId: signal.agentId,
      summary: ev.summary,
      createdAt,
      nonce: uuid(),
      tsMs: nowMs,
    };
    if (ev.refId !== undefined) rec.refId = ev.refId;
    if (ev.scope !== undefined) rec.scope = ev.scope;
    if (ev.targetIds !== undefined) rec.targetIds = ev.targetIds;
    return rec;
  });
}

// buildBatch — the whole office's signals → one batched { agents, events }.
// This is what the producer sanitize()s and POSTs as a single call per tick
// (Kern: /IngestEvents rate-limits 1 call/10s per office and accepts arrays).
export function buildBatch(
  signals: AgentSignal[],
  opts: BuildOptions = {},
): { agents: AgentStatus[]; events: OrgEventRecord[] } {
  const agents = signals.map((s) => buildAgentStatus(s, opts));
  const events = signals.flatMap((s) => buildEvents(s, opts));
  return { agents, events };
}
