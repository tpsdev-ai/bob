// reader.ts — the filesystem SEAM between config (snapshot sources) and the pure
// builder (snapshot.ts). It reads each agent's local signal files and produces an
// AgentSignal of already-resolved values (heartbeat ms, currentTask summary,
// events) — so snapshot.ts stays pure and fully unit-testable with plain data.
//
// HARD RULE: we only ever read SUMMARIES / metadata here:
//   * beadsFile  → the in-progress task's `summary`/`title` field ONLY (never a
//                  prompt or transcript field).
//   * heartbeatFile → mtime (and optionally a JSON {events:[…summary…]} block).
// Whatever we read is re-scrubbed by sanitize() before it leaves the process, so
// a path/secret that lands in a summary is still stripped.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { ObservatoryCapabilityConfig, SnapshotSource } from "./config.js";
import type { AgentEventInput, AgentSignal } from "./snapshot.js";

// fs seams (tests inject fakes; production uses node:fs).
export interface ReaderDeps {
  readFile?: (path: string) => string;
  statMtimeMs?: (path: string) => number;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}

// Pull the in-progress Beads task SUMMARY/title from a Beads JSON signal. Accepts
// either a single object or { tasks: [...] } and returns the first in_progress
// task's summary/title. Returns undefined on any miss (no throw) — a missing
// signal is just "no current task", not an error.
export function extractBeadsSummary(raw: string): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const tasks: unknown[] = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as { tasks?: unknown[] })?.tasks)
      ? (doc as { tasks: unknown[] }).tasks
      : [doc];
  for (const t of tasks) {
    const task = t as Record<string, unknown>;
    if (!task || typeof task !== "object") continue;
    const status = typeof task.status === "string" ? task.status : "";
    if (status && status !== "in_progress") continue;
    // SUMMARY/title ONLY — explicitly never `prompt`, `body`, `transcript`.
    const summary = task.summary ?? task.title;
    if (typeof summary === "string" && summary.trim() !== "") return summary.trim();
  }
  return undefined;
}

// Pull caused-events (summary/metadata only) from a heartbeat JSON signal, if it
// carries an `events` array. Each entry must already be a SUMMARY (the agent
// writes summaries to its signal; we never synthesize a body).
export function extractEvents(raw: string): AgentEventInput[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const evs = (doc as { events?: unknown[] })?.events;
  if (!Array.isArray(evs)) return [];
  const out: AgentEventInput[] = [];
  for (const e of evs) {
    const ev = e as Record<string, unknown>;
    if (!ev || typeof ev.kind !== "string" || typeof ev.summary !== "string") continue;
    const item: AgentEventInput = { kind: ev.kind, summary: ev.summary };
    if (typeof ev.refId === "string") item.refId = ev.refId;
    if (typeof ev.scope === "string") item.scope = ev.scope;
    if (Array.isArray(ev.targetIds))
      item.targetIds = ev.targetIds.filter((x): x is string => typeof x === "string");
    if (typeof ev.occurredAtMs === "number") item.occurredAtMs = ev.occurredAtMs;
    out.push(item);
  }
  return out;
}

// readSignal — one configured source → one AgentSignal. Never throws on a
// missing/unreadable file: a missing heartbeat → offline, a missing beads file
// → no current task. (Liveness failure must degrade gracefully, not crash the
// whole tick — "office dark" is a known failure mode, per Kern.)
export function readSignal(src: SnapshotSource, deps: ReaderDeps = {}): AgentSignal {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const statMtimeMs = deps.statMtimeMs ?? ((p) => statSync(p).mtimeMs);

  let currentTaskSummary: string | undefined;
  let events: AgentEventInput[] = [];
  let lastHeartbeatMs: number | undefined;

  if (src.beadsFile) {
    try {
      currentTaskSummary = extractBeadsSummary(readFile(expandHome(src.beadsFile)));
    } catch {
      currentTaskSummary = undefined;
    }
  }

  if (src.heartbeatFile) {
    const hb = expandHome(src.heartbeatFile);
    try {
      lastHeartbeatMs = statMtimeMs(hb);
    } catch {
      lastHeartbeatMs = undefined; // no heartbeat → offline
    }
    try {
      events = extractEvents(readFile(hb));
    } catch {
      events = [];
    }
  }

  return {
    agentId: src.agentId,
    name: src.name,
    role: src.role,
    model: src.model,
    type: src.type,
    currentTaskSummary,
    lastHeartbeatMs,
    lastActivityMs: lastHeartbeatMs,
    events,
  };
}

// readSignals — the whole office's configured sources → AgentSignal[].
export function readSignals(
  config: Pick<ObservatoryCapabilityConfig, "agents">,
  deps: ReaderDeps = {},
): AgentSignal[] {
  return config.agents.map((src) => readSignal(src, deps));
}
