// reachy/query.ts — "why do you know this" (spec §3.4). For a memory jarvis wrote,
// return the PERSISTED OrgEvent that created it — durable across a restart, read
// by the memory's correlation id. A library function with a test; S3 adds no tool.

import type { OrgEventStore } from "./capability.js";
import type { OrgEvent } from "./policy.js";

export interface ExplainDeps {
  /** Exact read of a memory by id (the orgEventId lives in its metadata). */
  getMemory: (id: string) => Promise<{ metadata?: Record<string, unknown> } | null>;
  /** The same durable store the audit was written to (a binary exact-id read). */
  store: OrgEventStore;
}

export interface MemoryExplanation {
  memoryId: string;
  orgEvent: OrgEvent;
  authorId: string;
  createdAtMs: number;
  speakerId?: string;
}

/** The persisted OrgEvent that created `memoryId`, or null. */
export async function explainMemory(
  memoryId: string,
  deps: ExplainDeps,
): Promise<MemoryExplanation | null> {
  const mem = await deps.getMemory(memoryId);
  const orgEventId = mem?.metadata?.orgEventId;
  if (typeof orgEventId !== "string") return null;
  const event = await deps.store.getById(orgEventId);
  if (!event) return null;
  return {
    memoryId,
    orgEvent: event,
    authorId: event.authorId,
    createdAtMs: event.tsMs,
    // The reachy events carry the speakerId in targetIds.
    speakerId: event.targetIds?.[0],
  };
}
