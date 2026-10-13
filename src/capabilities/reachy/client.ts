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
  type WiredReachy,
} from "./capability.js";
import type { OrgEvent } from "./policy.js";

/** The inbound line bound (64 KiB); a longer line is malformed, never buffered. */
export const MAX_LINE_BYTES = 64 * 1024;

export interface SidecarLine {
  type: "transcript" | "proposal" | "presence" | "health";
  [k: string]: unknown;
}

/** Reconnect backoff (bob#356): 1 s doubling to a 60 s cap, reset by a good
 *  handshake. A refused sidecar is retried, never spun on. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

/**
 * Keep the sidecar link up (bob#356 V1): connect, run the handshake, and on a
 * failed connect or a closed connection retry after a backoff that doubles to
 * a cap. Only a connection that reached a READY handshake resets the backoff,
 * so a sidecar that keeps failing the handshake is retried slowly, and every
 * retry is a fresh handshake (a new generation).
 */
export function superviseLink(deps: {
  client: { connect(): Promise<void>; onClose(listener: () => void): void };
  wired: Pick<WiredReachy, "connected" | "disconnected" | "link">;
  /** Timer seam (tests). Default: an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
  log?: (m: string) => void;
}): { start(): Promise<void>; stop(): void; nextDelayMs(): number } {
  const log = deps.log ?? ((m: string) => console.error(m));
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      // unref: a pending reconnect never keeps the process alive on its own.
      setTimeout(fn, ms).unref();
    });
  let delay = RECONNECT_MIN_MS;
  let stopped = false;
  const later = (): void => {
    if (stopped) return;
    const wait = delay;
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    schedule(() => void start(), wait);
  };
  deps.client.onClose(() => {
    const wasReady = deps.wired.link().phase === "ready";
    deps.wired.disconnected();
    if (wasReady) delay = RECONNECT_MIN_MS;
    later();
  });
  async function start(): Promise<void> {
    if (stopped) return;
    try {
      await deps.client.connect();
    } catch (err) {
      log(
        `reachy capability: sidecar connect failed (tools still registered; retrying): ${err instanceof Error ? err.message : err}`,
      );
      later();
      return;
    }
    // A refused handshake closes the socket; the close listener retries.
    await deps.wired.connected();
  }
  // The session is over: no further connect, no pending retry acts.
  const stop = (): void => {
    stopped = true;
  };
  return { start, stop, nextDelayMs: () => delay };
}

/**
 * A JSON-lines client for the sidecar's UNIX socket. `send` writes one command
 * object; inbound lines are delivered to `onLine` as the RAW parsed objects, for
 * wire.ts to decode. The peer is UNTRUSTED.
 */
export class UnixSocketReachyClient implements ReachyCommands {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private discarding = false;
  private listeners: Array<(line: unknown) => void> = [];
  private closeListeners: Array<() => void> = [];

  constructor(private readonly opts: { socket: string }) {}

  /** Open a NEW connection. bob#356: the raw buffer belongs to one connection
   *  only — it is cleared here and on close, and bytes from a socket that is no
   *  longer the current one are never ingested, so a partial line from a
   *  dropped connection cannot prefix the next connection's first line. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resetBuffer();
      const sock = createConnection(this.opts.socket);
      let opened = false;
      sock.once("connect", () => {
        opened = true;
        resolve();
      });
      sock.once("error", (err: Error) => {
        if (!opened) reject(err);
      });
      // A socket error AFTER connect must not become an unhandled 'error' event
      // (a failed connect is the caller's rejection, not a log line).
      sock.on("error", (err: Error) => {
        if (opened) console.error(`reachy: socket error: ${err.message}`);
      });
      // Feed RAW BYTES: the bound is counted in UTF-8 bytes, and a line is
      // decoded only once it is complete AND under the bound (round 5 item 1).
      sock.on("data", (chunk: Buffer) => {
        if (this.socket === sock) this.ingest(chunk);
      });
      sock.on("close", () => {
        if (this.socket !== sock) return;
        this.socket = null;
        this.resetBuffer();
        if (opened) for (const l of this.closeListeners) l();
      });
      this.socket = sock;
    });
  }

  private resetBuffer(): void {
    this.buffer = Buffer.alloc(0);
    this.discarding = false;
  }

  /** Called once per connection that opened and then closed (either side). */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** bob#356: drop the current connection (a failed handshake). The close
   *  listeners run, so a reconnect starts a fresh handshake. */
  disconnect(): void {
    this.socket?.destroy();
  }

  /** The bound applies PER COMPLETE LINE (round 4 item 2): an oversized line is
   *  discarded up to AND INCLUDING its newline (one `reachy.malformed`), so the
   *  next line parses normally and an oversized prefix cannot smuggle a payload
   *  on the same line; a chunk holding several short lines is fully retained. */
  ingest(chunk: Buffer | string): void {
    // The bound is UTF-8 BYTES, not characters (round 5 item 1): a transcript of
    // 80,058 bytes of multi-byte characters is over the bound even though its
    // JavaScript string length is under it. Bytes are buffered and counted as
    // they arrive; a line is DECODED only once it is complete and under the bound.
    this.buffer = Buffer.concat([
      this.buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
    ]);
    const NL = 0x0a;
    for (;;) {
      const nl = this.buffer.indexOf(NL);
      if (this.discarding) {
        // Inside a line already known to be oversized: consume through its
        // newline (or keep dropping bytes until one arrives).
        if (nl === -1) {
          if (this.buffer.length > MAX_LINE_BYTES) this.buffer = Buffer.alloc(0);
          return;
        }
        this.buffer = this.buffer.subarray(nl + 1);
        this.discarding = false;
        continue;
      }
      if (nl === -1) {
        // No complete line yet: only the PENDING line can be oversized here.
        if (this.buffer.length > MAX_LINE_BYTES) {
          this.buffer = Buffer.alloc(0);
          this.discarding = true;
          this.emitMalformed();
        }
        return;
      }
      const line = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);
      if (line.length > MAX_LINE_BYTES) {
        this.emitMalformed();
        continue;
      }
      const text = line.toString("utf8");
      if (text.trim()) {
        try {
          const parsed = JSON.parse(text);
          for (const l of this.listeners) l(parsed);
        } catch {
          // A line that is not JSON at all still reaches the decoder as a raw
          // string, so a malformed line is audited rather than dropped silently.
          for (const l of this.listeners) l(text);
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

  /** Write one command. Resolves only when the socket ACCEPTED the write; a
   *  write error REJECTS, and so does the socket closing before the write
   *  completed, so the caller's refusal path runs instead of a false "sent"
   *  (bob#356). The close case matters on its own: Node reports a destroyed
   *  socket's pending write to its callback (ECANCELED), but Bun never calls
   *  that callback at all — without it, the send would never settle. */
  async send(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const sock = this.socket;
    if (!sock || sock.destroyed) throw new Error("reachy: not connected to the sidecar socket");
    return new Promise((resolve, reject) => {
      let settled = false;
      const onClose = (): void => {
        if (settled) return;
        settled = true;
        reject(new Error("reachy: the sidecar socket closed before the write completed"));
      };
      sock.once("close", onClose);
      sock.write(`${JSON.stringify({ command, args: args ?? {} })}\n`, (err?: Error | null) => {
        sock.off("close", onClose);
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(null);
      });
    });
  }

  close(): void {
    const sock = this.socket;
    this.socket = null;
    this.resetBuffer();
    sock?.end();
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
        const parsed: unknown = JSON.parse(record.content);
        // The adapter contract (round 9 item 1): a parsed OrgEvent is accepted
        // ONLY when kind is a string, id is a string, AND targetIds is PRESENT
        // as an array of strings. A record with no targetIds is not an OrgEvent
        // (the membership sites read targetIds), so both callers see "no event".
        if (typeof parsed !== "object" || parsed === null) return null;
        const candidate = parsed as { kind?: unknown; id?: unknown; targetIds?: unknown };
        if (typeof candidate.kind !== "string") return null;
        if (typeof candidate.id !== "string") return null;
        if (!Array.isArray(candidate.targetIds)) return null;
        if (candidate.targetIds.some((t) => typeof t !== "string")) return null;
        return parsed as OrgEvent;
      } catch {
        return null;
      }
    },
  };
}
