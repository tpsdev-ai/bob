// reachy/query.ts — "why do you know this" (spec §3.4). For a memory jarvis
// wrote, return the OrgEvent that created it (author, time, speakerId). Exposed
// as a library function with a test; S3 does not add a tool (the flair
// capability has no matching tool shape yet).

import type { OrgEvent } from "./policy.js";

export interface MemoryExplanation {
  memoryId: string;
  // The OrgEvent that created the memory (kind `reachy.memory`).
  orgEvent: OrgEvent;
  authorId: string;
  createdAtMs: number;
  speakerId?: string;
}

/** The OrgEvent that created `memoryId`, or null when it was not written by jarvis. */
export function explainMemory(memoryId: string, events: OrgEvent[]): MemoryExplanation | null {
  const e = events.find((ev) => ev.kind === "reachy.memory" && ev.refId === memoryId);
  if (!e) return null;
  return {
    memoryId,
    orgEvent: e,
    authorId: e.authorId,
    createdAtMs: e.tsMs,
    speakerId: (e.metadata.speakerId as string | undefined) ?? undefined,
  };
}
