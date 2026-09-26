// reachy/client.ts — the real UNIX-socket command channel + the durable OrgEvent
// store and memory writer over the flair capability client (spec §3.2/§3.4).
// Kept thin; the policy lives in policy.ts and the wiring in capability.ts, so
// tests drive a fake and never open a socket or touch a real Flair.

import { createConnection, type Socket } from "node:net";
import {
  type MemoryWriter,
  type OrgEventStore,
  orgEventRecordId,
  type ReachyCommands,
} from "./capability.js";
import type { OrgEvent } from "./policy.js";

/** The inbound line bound (64 KiB); a longer line is malformed, never buffered. */
export const MAX_LINE_BYTES = 64 * 1024;

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
  private discarding = false;
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

  /** The bound applies PER COMPLETE LINE (round 4 item 2): an oversized line is
   *  discarded up to AND INCLUDING its newline (one `reachy.malformed`), so the
   *  next line parses normally and an oversized prefix cannot smuggle a payload
   *  on the same line; a chunk holding several short lines is fully retained. */
  ingest(text: string): void {
    this.buffer += text;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (this.discarding) {
        // We are inside a line already known to be oversized: consume through
        // its newline (or wait, dropping bytes, until one arrives).
        if (nl === -1) {
          if (this.buffer.length > MAX_LINE_BYTES) this.buffer = "";
          return;
        }
        this.buffer = this.buffer.slice(nl + 1);
        this.discarding = false;
        continue;
      }
      if (nl === -1) {
        // No complete line yet. Only the PENDING line can be oversized here.
        if (this.buffer.length > MAX_LINE_BYTES) {
          this.buffer = "";
          this.discarding = true;
          this.emitMalformed();
        }
        return;
      }
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > MAX_LINE_BYTES) {
        this.emitMalformed();
        continue;
      }
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
    }
  }

  /** Hand the decoder the oversized marker, so it audits one `reachy.malformed`. */
  private emitMalformed(): void {
    for (const l of this.listeners) l({ type: "__oversized__" });
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
      id?: string;
      durability?: string;
      visibility?: string;
      authorId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ id: string }>;
  /** The exact-id read: GET /Memory/<id> (bob's FlairHttpClient.get). */
  get(id: string): Promise<{ content?: string } | null>;
}): OrgEventStore {
  return {
    async write(event) {
      const recordId = orgEventRecordId(event);
      const { id } = await client.write(JSON.stringify(event), {
        id: recordId,
        durability: "persistent",
        visibility: "private",
        authorId: "jarvis",
        metadata: { kind: event.kind, orgEventId: recordId },
      });
      return { id };
    },
    async getById(id) {
      const record = await client.get(id);
      if (!record || typeof record.content !== "string") return null;
      try {
        return JSON.parse(record.content) as OrgEvent;
      } catch {
        return null;
      }
    },
  };
}
