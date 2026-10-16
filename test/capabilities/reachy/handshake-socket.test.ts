// bob#356 round 1 — the handshake races on a REAL local UNIX socket, with bob's
// real socket client:
//   1. a matching health line that arrives while the `configure` write is
//      still pending is held, and the link is ready only once that write
//      succeeded;
//   2. a `configure` write that FAILS refuses the link, even though a matching
//      health line arrived — and a failed write always rejects `send` (it never
//      resolves as "sent"): on a socket destroyed under it (Bun reports that only
//      by closing), and through the write callback's error (Node's path, driven
//      with a socket double because Bun never takes it).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OrgEventStore,
  orgEventRecordId,
  type PiLike,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { superviseLink, UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";
import { VOICE_PROTOCOL } from "../../../src/capabilities/reachy/wire.js";
import { must, TEST_SIDECAR_VERSION } from "./handshake.js";

const scratch: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const health = (generation: number) =>
  `${JSON.stringify({
    type: "health",
    protocol: VOICE_PROTOCOL,
    version: TEST_SIDECAR_VERSION,
    profile: "voice",
    generation,
    wakeName: "jarvis",
    mode: "off",
    trainedPhrase: null,
    modelHash: null,
    muted: false,
    ok: true,
  })}\n`;

/** A local sidecar double on a real UNIX socket. `eager`: it writes a matching
 *  health line for generation 1 the moment a client connects. `read`: whether
 *  it reads (a server that never reads lets a large write stay pending). */
async function socketServer(opts: { eager: boolean; read: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "rvh-"));
  scratch.push(dir);
  const path = join(dir, "s.sock");
  const conns: Socket[] = [];
  const server = createServer((c) => {
    conns.push(c);
    if (!opts.read) c.pause();
    if (opts.eager) c.write(health(1));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  return { path, conns };
}

class NoPi implements PiLike {
  readonly tools = new Map<string, Parameters<PiLike["registerTool"]>[0]>();
  registerTool(tool: Parameters<PiLike["registerTool"]>[0]): void {
    this.tools.set(tool.name, tool);
  }
}
class Store implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  async write(e: OrgEvent): Promise<{ id: string }> {
    this.all.push(e);
    return { id: orgEventRecordId(e) };
  }
  async getById(): Promise<OrgEvent | null> {
    return null;
  }
}

function core(client: UnixSocketReachyClient) {
  const store = new Store();
  const state: PolicyState = {
    profile: "voice",
    wakeName: "jarvis",
    enrolment: {},
    mute: false,
    nowMs: () => Date.now(),
    roomSpeechOrigins: [],
  };
  const pi = new NoPi();
  const wired = wireReachyCapability({
    pi,
    commands: client,
    memory: { writePrivate: async () => ({ id: "m" }) },
    store,
    state,
    sidecarVersion: TEST_SIDECAR_VERSION,
    log: () => {},
  });
  const seen: unknown[] = [];
  client.onLine((l) => {
    seen.push(l);
    void wired.handleLine(l);
  });
  return { wired, store, seen, pi };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("bob#356 round 1 — send failures and the handshake races (a real UNIX socket; one test drives Node's callback path)", () => {
  it("a write the socket cannot complete rejects `send` (callback error on Node, the close on Bun), never a silent sent", async () => {
    const srv = await socketServer({ eager: false, read: false });
    const client = new UnixSocketReachyClient({ socket: srv.path });
    await client.connect();
    // 16 MiB to a peer that does not read: the write stays pending...
    const pending = client.send("configure", { blob: "x".repeat(16 * 1024 * 1024) });
    client.disconnect(); // ...and the socket is destroyed under it
    await expect(pending).rejects.toThrow();
  });

  it("a write whose CALLBACK reports an error rejects `send` (Node's path for a failed or destroyed socket)", async () => {
    // Bun never calls a destroyed socket's pending-write callback (it only
    // closes the socket — the test above), so this drives the callback branch
    // with a socket whose write reports EPIPE, as Node's does.
    const client = new UnixSocketReachyClient({ socket: "/unused" });
    const listeners = new Map<string, () => void>();
    const failing = {
      destroyed: false,
      once: (event: string, l: () => void) => listeners.set(event, l),
      off: (event: string) => listeners.delete(event),
      write: (_line: string, cb: (err?: Error | null) => void) => {
        queueMicrotask(() => cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
        return false;
      },
    };
    Object.assign(client, {
      socket: failing,
      configured: {
        socket: failing,
        wait: Promise.resolve(),
        complete: () => {},
        fail: () => {},
        started: false,
      },
    });
    await expect(client.send("configure", {})).rejects.toThrow("EPIPE");
    expect(listeners.has("close")).toBe(false); // the close listener was released
  });

  it("reachy_state during reconnect cannot precede configure on the wire", async () => {
    const srv = await socketServer({ eager: false, read: true });
    const client = new UnixSocketReachyClient({ socket: srv.path });
    const { wired, pi } = core(client);
    let retry!: () => void;
    const supervisor = superviseLink({
      client,
      wired,
      schedule: (fn) => {
        retry = fn;
      },
    });
    try {
      await supervisor.start();
      await until(() => srv.conns.length === 1, "the first connection");
      srv.conns[0]?.destroy();
      await until(() => !!retry, "the reconnect timer");
      const realConnect = client.connect.bind(client);
      let stateDuringConnect!: Promise<unknown>;
      let queuedState!: Promise<unknown>;
      let resume!: () => void;
      const held = new Promise<void>((r) => {
        resume = r;
      });
      const wire: string[] = [];
      client.connect = async () => {
        const connecting = realConnect();
        stateDuringConnect = must(pi.tools.get("reachy_state"), "reachy_state").execute(
          "state",
          {},
        );
        await connecting;
        await until(() => srv.conns.length === 2, "the second connection");
        let buffer = "";
        srv.conns[1]?.on("data", (chunk) => {
          buffer += chunk.toString();
          for (;;) {
            const nl = buffer.indexOf("\n");
            if (nl < 0) break;
            wire.push(JSON.parse(buffer.slice(0, nl)).command);
            buffer = buffer.slice(nl + 1);
          }
        });
        queuedState = must(pi.tools.get("reachy_state"), "reachy_state").execute("state", {});
        await held;
      };
      retry();
      await until(() => !!queuedState, "a state call on the reconnected socket");
      expect(JSON.stringify(await stateDuringConnect)).toContain("state unavailable");
      await Bun.sleep(20);
      expect(wire).toEqual([]);
      resume();
      await queuedState;
      await until(() => wire.length === 2, "configure and queued state");
      expect(wire).toEqual(["configure", "state"]);
    } finally {
      supervisor.stop();
      client.disconnect();
    }
  });

  it("RACE 1: health arriving while `configure` is pending is held; ready only after the write succeeded", async () => {
    const srv = await socketServer({ eager: true, read: true });
    const client = new UnixSocketReachyClient({ socket: srv.path });
    const { wired, seen } = core(client);
    await client.connect();
    // Hold the configure write's completion until the eager health line has
    // been DELIVERED over the socket — the window the race lives in.
    const realSend = client.send.bind(client);
    let gate!: () => void;
    const opened = new Promise<void>((r) => {
      gate = r;
    });
    client.send = async (command, args) => {
      const result = await realSend(command, args);
      if (command === "configure") await opened;
      return result;
    };
    const connecting = wired.connected();
    await until(() => seen.length === 1, "the eager health line");
    expect(wired.link().phase).toBe("configuring"); // held, not judged
    gate();
    await connecting;
    expect(wired.link().phase).toBe("ready");
    client.close();
  });

  it("RACE 2: a `configure` write that FAILS on the socket refuses the link although a matching health line arrived", async () => {
    const srv = await socketServer({ eager: true, read: false });
    const client = new UnixSocketReachyClient({ socket: srv.path });
    const { wired, store, seen } = core(client);
    await client.connect();
    const realSend = client.send.bind(client);
    client.send = (command, args) =>
      realSend(command, { ...args, blob: "x".repeat(16 * 1024 * 1024) });
    const connecting = wired.connected();
    await until(() => seen.length === 1, "the eager health line");
    expect(wired.link().phase).toBe("configuring");
    client.disconnect();
    await connecting;
    expect(wired.link().phase).toBe("disconnected");
    expect(store.all.find((e) => e.kind === "reachy.link.refused")?.summary).toContain(
      "configure send",
    );
  });
});
