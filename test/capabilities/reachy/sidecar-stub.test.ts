// reachy S3 — the REAL stub sidecar over a UNIX socket (bob#356: through the
// reachy-voice/1 handshake).
//
// Round 4: completion is the stub's EXPLICIT end-of-replay marker, and the
// expected event count + outcomes are PINNED CONSTANTS in this test — never a
// count derived from the fixture, so a truncated replay cannot satisfy them.
//
// bob#356 V1: bob's REAL socket client is the command channel, so the handshake
// runs over the socket — `configure` out, the stub's health line back — before
// the stub replays anything. The key-read proof that lived here moved to
// isolation.test.ts with the rest of the isolation proofs.
import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MemoryWriter,
  type OrgEventStore,
  orgEventRecordId,
  type PiLike,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";

// PINNED expectations, independent of any fixture file (round 4 item 4). If the
// replay is truncated, these are NOT met and the proof FAILS — it does not
// measure whatever file the caller handed it.
const HANDSHAKE_REPLIES = 1; // the stub's health answer to bob's `configure`
const EVENTS_EXPECTED = 5; // the 5 event lines in the fixture, before the end marker
const EXPECTED_MEMORY_WRITES = 1; // one private memory, for the verified speaker
const EXPECTED_VISITOR_MEMORIES = 0;
const EXPECTED_MALFORMED = 0;
// The same replay under the VOICE profile (bob#356): the presence line is a
// content-free malformed audit and the look proposal a refusal.
const VOICE_EXPECTED_MALFORMED = 1;
const VOICE_EXPECTED_BODY_REFUSALS = 1;
const STUB_VERSION = "reachy-stub-1";

const REPO = join(import.meta.dirname, "..", "..", "..");
const STUB = join(REPO, "test", "fixtures", "reachy-stub", "sidecar.py");
const EVENTS = join(REPO, "test", "fixtures", "reachy-stub", "events.jsonl");

class FakePi implements PiLike {
  registerTool(): void {}
}
class FakeMemory implements MemoryWriter {
  readonly writes: Array<{
    content: string;
    visibility: string;
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
  }> = [];
  private n = 0;
  async writePrivate(w: {
    content: string;
    visibility: "private";
    authorId: string;
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
  }): Promise<{ id: string }> {
    this.writes.push(w);
    return { id: `mem_${++this.n}` };
  }
}
class FakeStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  private readonly byId = new Map<string, OrgEvent>();
  async write(event: OrgEvent): Promise<{ id: string }> {
    const id = orgEventRecordId(event);
    this.byId.set(id, event);
    this.all.push(event);
    return { id };
  }
  async getById(id: string): Promise<OrgEvent | null> {
    return this.byId.get(id) ?? null;
  }
}

const scratch: string[] = [];
// Every stub this file starts, killed at the end even if a test was abandoned
// mid-way (a timed-out test does not run its `finally`).
const stubs: Array<{ kill: () => boolean }> = [];
afterAll(() => {
  for (const p of stubs) p.kill();
  for (const d of scratch) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Start the stub on a temp socket, connect bob's REAL client as the command
 *  channel, and run the handshake; returns a helper to await the end-of-replay
 *  MARKER (not a count from the fixture), with every handler promise awaited. */
async function startReplay(
  eventsPath: string,
  opts: { profile?: "voice" | "reachy"; sidecarVersion?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "reachy-sock-"));
  scratch.push(dir);
  const socketPath = join(dir, "reachy.sock");
  const proc = spawn("python3", [STUB, socketPath, eventsPath, STUB_VERSION], { stdio: "ignore" });
  stubs.push(proc);
  const deadline = Date.now() + 8000;
  while (!existsSync(socketPath)) {
    if (Date.now() > deadline) throw new Error("stub socket never appeared");
    await new Promise((r) => setTimeout(r, 10));
  }
  const memory = new FakeMemory();
  const store = new FakeStore();
  const state: PolicyState = {
    profile: opts.profile ?? "reachy",
    wakeName: "jarvis",
    enrolment: { "spk-1": "member-1" },
    mute: false,
    nowMs: () => Date.now(),
    lastAcknowledgeAtMs: undefined,
    roomSpeechOrigins: [],
  };
  const client = new UnixSocketReachyClient({ socket: socketPath });
  const wired = wireReachyCapability({
    pi: new FakePi(),
    commands: client,
    memory,
    store,
    state,
    sidecarVersion: opts.sidecarVersion ?? STUB_VERSION,
    log: () => {},
  });
  let received = 0;
  let ended = false;
  let closed = false;
  const pending: Array<Promise<unknown>> = [];
  client.onLine((line) => {
    const obj = line as { type?: string; replayEnd?: boolean };
    if (obj?.type === "health" && obj.replayEnd === true) {
      ended = true; // the stub's explicit end-of-replay marker
      return;
    }
    received++;
    pending.push(wired.handleLine(line)); // awaited below, never fire-and-forget
  });
  client.onClose(() => {
    closed = true;
    wired.disconnected();
  });
  await client.connect();
  await wired.connected(); // bob's `configure`, over the socket
  const waitFullReplay = async () => {
    const done = Date.now() + 8000;
    while (!ended) {
      if (Date.now() > done)
        throw new Error(`replay never ended: received ${received} event line(s)`);
      await new Promise((r) => setTimeout(r, 10));
    }
    await Promise.all(pending); // every handler has settled
  };
  const waitClosed = async () => {
    const done = Date.now() + 8000;
    while (!closed) {
      if (Date.now() > done) throw new Error("the link never closed");
      await new Promise((r) => setTimeout(r, 10));
    }
    await Promise.all(pending);
  };
  const stop = () => {
    client.close();
    proc.kill();
  };
  return { memory, store, wired, waitFullReplay, waitClosed, stop, received: () => received };
}

describe("reachy S3 — the real stub sidecar over a UNIX socket", () => {
  it("replays EVERY line after the handshake: the PINNED outcomes hold (one private memory for the speaker, none for the visitor)", async () => {
    const h = await startReplay(EVENTS);
    try {
      await h.waitFullReplay(); // waits for the end-of-replay marker, not the file
      expect(h.wired.link().phase).toBe("ready");
      // constants, NOT derived from the fixture
      expect(h.received()).toBe(HANDSHAKE_REPLIES + EVENTS_EXPECTED);
      expect(h.memory.writes.length).toBe(EXPECTED_MEMORY_WRITES);
      expect(h.memory.writes[0]?.visibility).toBe("private");
      expect(h.memory.writes[0]?.metadata.speakerId).toBe("spk-1");
      expect(h.memory.writes.filter((w) => w.metadata.speakerId === "visitor-9").length).toBe(
        EXPECTED_VISITOR_MEMORIES,
      );
      expect(h.store.all.filter((e) => e.kind === "reachy.malformed").length).toBe(
        EXPECTED_MALFORMED,
      );
    } finally {
      h.stop();
    }
  }, 30_000);

  it("the same replay under the VOICE profile: presence is a content-free malformed audit, the look a refusal", async () => {
    const h = await startReplay(EVENTS, { profile: "voice" });
    try {
      await h.waitFullReplay();
      expect(h.received()).toBe(HANDSHAKE_REPLIES + EVENTS_EXPECTED);
      const malformed = h.store.all.filter((e) => e.kind === "reachy.malformed");
      expect(malformed.length).toBe(VOICE_EXPECTED_MALFORMED);
      // content-free: neither the count nor the enrolled id is echoed
      expect(malformed[0]?.summary).not.toContain("spk-1");
      expect(malformed[0]?.summary).toContain("voice profile");
      const bodyRefusals = h.store.all.filter(
        (e) => e.kind === "reachy.refused" && e.summary.includes("body actions are absent"),
      );
      expect(bodyRefusals.length).toBe(VOICE_EXPECTED_BODY_REFUSALS);
      expect(h.memory.writes.length).toBe(EXPECTED_MEMORY_WRITES);
    } finally {
      h.stop();
    }
  }, 30_000);

  it("a version mismatch over the socket disconnects at the handshake: ONE alarm, nothing replayed is processed", async () => {
    const h = await startReplay(EVENTS, { sidecarVersion: "reachy-stub-2" });
    try {
      await h.waitClosed();
      expect(h.wired.link().phase).toBe("disconnected");
      const alarms = h.store.all.filter((e) => e.kind === "reachy.link.refused");
      expect(alarms.length).toBe(1);
      expect(alarms[0]?.summary).toContain("version");
      // bounded and content-free: the sidecar's own version string is not echoed
      expect(alarms[0]?.summary).not.toContain(STUB_VERSION);
      expect(h.memory.writes.length).toBe(0);
      expect(h.store.all.filter((e) => e.kind === "reachy.malformed").length).toBe(0);
    } finally {
      h.stop();
    }
  }, 30_000);

  it("the pinned proof CANNOT be satisfied by a truncated replay (drops the visitor line)", async () => {
    // The end-of-replay marker still arrives (the stub always appends it), so
    // waitFullReplay completes — but the PINNED event count is not met, because it
    // is a constant, not the fixture's own length. This is the weakness the
    // constants remove: with a fixture-derived count this case PASSED.
    const dir = mkdtempSync(join(tmpdir(), "reachy-trunc-"));
    scratch.push(dir);
    const truncated = join(dir, "events.jsonl");
    const all = readFileSync(EVENTS, "utf8").split("\n").filter(Boolean);
    writeFileSync(truncated, `${all.slice(0, 4).join("\n")}\n`); // drop the visitor line (line 5)
    const h = await startReplay(truncated);
    try {
      await h.waitFullReplay();
      // the proof FAILS, as it must
      expect(h.received()).toBeLessThan(HANDSHAKE_REPLIES + EVENTS_EXPECTED);
      expect(all.length).toBe(EVENTS_EXPECTED); // the fixture really has EVENTS_EXPECTED lines
    } finally {
      h.stop();
    }
  }, 30_000);

  it("an oversized line over the socket is malformed, never buffered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reachy-big-"));
    scratch.push(dir);
    const big = join(dir, "big.jsonl");
    writeFileSync(big, `${JSON.stringify({ type: "presence", blob: "x".repeat(70 * 1024) })}\n`);
    const h = await startReplay(big);
    try {
      await h.waitFullReplay();
      expect(h.memory.writes.length).toBe(0);
      expect(h.store.all.some((e) => e.kind === "reachy.malformed")).toBe(true);
    } finally {
      h.stop();
    }
  }, 30_000);

  it("an extra wire field over the socket is malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reachy-extra-"));
    scratch.push(dir);
    const f = join(dir, "extra.jsonl");
    writeFileSync(
      f,
      `${JSON.stringify({
        type: "transcript",
        text: "jarvis hi",
        ts: "t",
        wakeHeard: true,
        extra: 1,
      })}\n`,
    );
    const h = await startReplay(f);
    try {
      await h.waitFullReplay();
      expect(h.memory.writes.length).toBe(0);
      expect(h.store.all.some((e) => e.kind === "reachy.malformed")).toBe(true);
    } finally {
      h.stop();
    }
  }, 30_000);
});
