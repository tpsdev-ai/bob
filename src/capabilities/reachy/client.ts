// reachy/client.ts — the real UNIX-socket command channel + the durable OrgEvent
// store and memory writer over the flair capability client (spec §3.2/§3.4).
// Kept thin; the policy lives in policy.ts and the wiring in capability.ts, so
// tests drive a fake and never open a socket or touch a real Flair.

import { createConnection, type Socket } from "node:net";
import type { MemoryWriter, OrgEventStore, ReachyCommands } from "./capability.js";
import type { OrgEvent } from "./policy.js";

export interface SidecarLine {
  type: "transcript" | "proposal" | "presence" | "health";
  [k: string]: unknown;
}

/**
 * A JSON-lines client for the sidecar's UNIX socket. `send` writes one command
 * object; inbound lines are delivered to `onLine` as the RAW parsed objects, for
 * wire.ts to decode. The peer is UNTRUSTED.
 */
export class UnixSocketReachyClient implements ReachyCommands {
  private socket: Socket | null = null;
  private buffer = "";
  private listeners: Array<(line: unknown) => void> = [];

  constructor(private readonly opts: { socket: string }) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.opts.socket);
      sock.once("connect", () => resolve());
      sock.once("error", reject);
      // A socket error AFTER connect must not become an unhandled 'error' event.
      sock.on("error", (err: Error) => console.error(`reachy: socket error: ${err.message}`));
      sock.on("data", (chunk: Buffer) => this.ingest(chunk.toString("utf8")));
      this.socket = sock;
    });
  }

  private ingest(text: string): void {
    this.buffer += text;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          for (const l of this.listeners) l(parsed);
        } catch {
          // A line that is not JSON at all still reaches the decoder as a raw
          // string, so a malformed line is audited rather than dropped silently.
          for (const l of this.listeners) l(line);
        }
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  onLine(listener: (line: unknown) => void): void {
    this.listeners.push(listener);
  }

  async send(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.socket) throw new Error("reachy: not connected to the sidecar socket");
    return new Promise((resolve) => {
      this.socket?.write(`${JSON.stringify({ command, args: args ?? {} })}\n`, () => resolve(null));
    });
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}

/**
 * The memory-writer seam over the flair capability client. A memory jarvis writes
 * is ALWAYS `private`, authored by `jarvis`, with the speakerId AND the audit
 * correlation id in metadata (spec §3.4).
 */
export function flairMemoryWriter(client: {
  write(
    content: string,
    opts?: {
      durability?: string;
      visibility?: string;
      authorId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string }>;
}): MemoryWriter {
  return {
    writePrivate(write) {
      return client.write(write.content, {
        durability: "standard",
        visibility: "private",
        authorId: write.authorId,
        metadata: write.metadata,
      });
    },
  };
}

/**
 * The DURABLE OrgEvent store over the SAME flair client the memory goes through
 * (round 2 item 2): each event is persisted as a private record and read back by
 * its correlation id. No new event store is invented.
 */
export function flairOrgEventStore(client: {
  write(
    content: string,
    opts?: {
      durability?: string;
      visibility?: string;
      authorId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string }>;
  search(query: string, limit?: number): Promise<Array<{ id: string; content: string }>>;
}): OrgEventStore {
  return {
    async write(event) {
      const correlationId = String(event.metadata.correlationId ?? "");
      const { id } = await client.write(JSON.stringify(event), {
        durability: "persistent",
        visibility: "private",
        authorId: "jarvis",
        metadata: { kind: event.kind, correlationId },
      });
      return { id };
    },
    async readByCorrelation(correlationId) {
      const hits = await client.search(correlationId, 5);
      for (const h of hits) {
        try {
          const ev = JSON.parse(h.content) as OrgEvent;
          if (
            (ev?.metadata as Record<string, unknown> | undefined)?.correlationId === correlationId
          )
            return ev;
        } catch {
          /* not our record */
        }
      }
      return null;
    },
  };
}
