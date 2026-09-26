// reachy/client.ts — the real UNIX-socket command channel + the memory-writer
// adapter over the flair capability client (spec §3.2/§3.4). Kept thin; the
// policy lives in policy.ts and the wiring in capability.ts, so tests drive a
// fake and never open a socket or touch a real Flair.

import { createConnection, type Socket } from "node:net";
import type { MemoryWriter, ReachyCommands } from "./capability.js";
import type { OrgEvent } from "./policy.js";

export interface SidecarLine {
  type: "transcript" | "proposal" | "presence" | "health";
  [k: string]: unknown;
}

/**
 * A JSON-lines client for the sidecar's UNIX socket. `send` writes one command
 * object; inbound lines are delivered to `onLine`. The peer is UNTRUSTED: the
 * caller applies policy to everything it delivers.
 */
export class UnixSocketReachyClient implements ReachyCommands {
  private socket: Socket | null = null;
  private buffer = "";
  private listeners: Array<(line: SidecarLine) => void> = [];

  constructor(private readonly opts: { socket: string }) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.opts.socket);
      sock.once("connect", () => resolve());
      sock.once("error", reject);
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
          const parsed = JSON.parse(line) as SidecarLine;
          for (const l of this.listeners) l(parsed);
        } catch {
          // A malformed line from the UNTRUSTED sidecar is dropped, never fatal.
        }
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  onLine(listener: (line: SidecarLine) => void): void {
    this.listeners.push(listener);
  }

  async send(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.socket) throw new Error("reachy: not connected to the sidecar socket");
    return new Promise((resolve) => {
      this.socket!.write(`${JSON.stringify({ command, args: args ?? {} })}\n`, () => resolve(null));
    });
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}

/**
 * The memory-writer seam over the flair capability client. a memory jarvis
 * writes is ALWAYS `private`, authored by `jarvis`, with the speakerId in
 * metadata (spec §3.4). S3 never writes non-private.
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

/** The OrgEvent sink seam — S3 records events; production routes to the observatory. */
export function collectingEmitter(sink: OrgEvent[]): (event: OrgEvent) => void {
  return (event) => {
    sink.push(event);
  };
}
