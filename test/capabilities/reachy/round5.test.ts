// reachy S3 — round 5: the byte-accurate line bound, the acknowledge race, the
// attested memory write, and full-UUID event ids (bob#180).
import { describe, expect, it } from "bun:test";
import {
  type MemoryWriter,
  type OrgEventStore,
  type PiLike,
  type ReachyCommands,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { MAX_LINE_BYTES, UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";
import { decodeLine } from "../../../src/capabilities/reachy/wire.js";

class NoPi implements PiLike {
  registerTool(): void {}
}
class NoCommands implements ReachyCommands {
  async send(): Promise<unknown> {
    return null;
  }
}

/** A store whose write can be DELAYED, to expose a race between two handlers. */
class SlowStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  delayMs = 0;
  async write(event: OrgEvent): Promise<{ id: string }> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    this.all.push(event);
    return { id: event.id };
  }
  async getById(): Promise<OrgEvent | null> {
    return null;
  }
}

class RecordingMemory implements MemoryWriter {
  readonly writes: Array<{ content: string; metadata: { orgEventId: string } }> = [];
  fail = false;
  async writePrivate(w: {
    content: string;
    metadata: { orgEventId: string };
  }): Promise<{ id: string }> {
    if (this.fail) {
      const e = new Error("flair is down");
      e.name = "FlairUnavailableError";
      throw e;
    }
    this.writes.push(w);
    return { id: "mem-written-1" };
  }
}

function harness(opts: {
  memory?: MemoryWriter;
  store?: OrgEventStore;
  uuid?: () => string;
  nowMs?: () => number;
  enrolment?: Record<string, string>;
  logs?: string[];
}) {
  const memory = opts.memory ?? new RecordingMemory();
  const store = opts.store ?? new SlowStore();
  const state: PolicyState = {
    wakeName: "jarvis",
    enrolment: opts.enrolment ?? { "spk-1": "member-1" },
    mute: false,
    nowMs: opts.nowMs ?? (() => 1),
    lastAcknowledgeAtMs: undefined,
  };
  const wired = wireReachyCapability({
    pi: new NoPi(),
    commands: new NoCommands(),
    memory,
    store,
    state,
    log: (m) => opts.logs?.push(m),
    ...(opts.uuid ? { uuid: opts.uuid } : {}),
  });
  return { wired, memory, store, state };
}

// ── item 1: the line bound is BYTES ───────────────────────────────────────────
describe("reachy round 5 item 1: the line bound counts UTF-8 BYTES, not characters", () => {
  function collect(chunks: Array<Buffer | string>) {
    const client = new UnixSocketReachyClient({ socket: "/unused" });
    const lines: unknown[] = [];
    client.onLine((l) => lines.push(l));
    for (const c of chunks) client.ingest(c);
    return lines;
  }
  const transcript = (text: string) =>
    JSON.stringify({ type: "transcript", text, ts: "t", wakeHeard: true, speakerId: "spk-1" });

  it("a valid transcript OVER the bound in bytes (under it in characters) is malformed", () => {
    const text = "é".repeat(40_000); // 40,000 chars, 80,000 UTF-8 bytes
    const line = `${transcript(text)}\n`;
    expect(line.length).toBeLessThan(MAX_LINE_BYTES); // under in CHARACTERS
    expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(MAX_LINE_BYTES); // over in BYTES
    const lines = collect([Buffer.from(line, "utf8")]);
    expect(lines.length).toBe(1);
    expect(decodeLine(lines[0])).toMatchObject({ kind: "malformed" });
    expect(lines.some((l) => decodeLine(l).kind === "transcript")).toBe(false);
  });

  it("the SAME shape UNDER the bound in bytes is admitted (control)", () => {
    const line = `${transcript("é".repeat(1_000))}\n`; // 2,000 bytes
    const lines = collect([Buffer.from(line, "utf8")]);
    expect(lines.length).toBe(1);
    expect(decodeLine(lines[0])).toMatchObject({ kind: "transcript" });
  });

  it("bytes are counted as chunks ARRIVE: a multi-byte line split across chunks is still bounded", () => {
    const text = "😀".repeat(20_000); // 4 bytes each → 80,000 bytes, 20,000 chars
    const buf = Buffer.from(`${transcript(text)}\n`, "utf8");
    expect(buf.length).toBeGreaterThan(MAX_LINE_BYTES);
    // Split mid-character, as the socket would.
    const cut = Math.floor(buf.length / 3);
    const lines = collect([buf.subarray(0, cut), buf.subarray(cut)]);
    expect(lines.length).toBe(1);
    expect(decodeLine(lines[0])).toMatchObject({ kind: "malformed" });
  });
});

// ── item 2: the acknowledge rate slot is reserved synchronously ───────────────
describe("reachy round 5 item 2: two concurrent visitor lines cannot both acknowledge", () => {
  const visitorLine = JSON.stringify({
    type: "transcript",
    text: "jarvis, hello",
    ts: "t",
    wakeHeard: true,
    speakerId: "visitor-9",
  });

  it("with a DELAYED store, at most one acknowledgement is emitted", async () => {
    const store = new SlowStore();
    store.delayMs = 30; // the audit write is slow enough to interleave
    // An empty enrolment makes the speaker UNVERIFIED → the ephemeral/acknowledge path.
    const h = harness({ store, enrolment: {} }); // no visitor enrolment
    const [a, b] = await Promise.all([
      h.wired.handleLine(visitorLine),
      h.wired.handleLine(visitorLine),
    ]);
    const acks = [a, b].filter((r) => r.kind === "ephemeral" && r.acknowledged);
    expect(acks.length).toBe(1);
    expect(store.all.filter((e) => e.kind === "reachy.acknowledge").length).toBe(1);
  });
});

// ── item 3: attempt → written/failed, never an unqualified "wrote" ────────────
describe("reachy round 5 item 3: a memory write is audited as intent then outcome", () => {
  const speakerLine = JSON.stringify({
    type: "transcript",
    text: "jarvis, remember the drill",
    ts: "t",
    wakeHeard: true,
    speakerId: "spk-1",
  });

  it("a SUCCESSFUL write leaves attempt + written (with the memory id), correlated", async () => {
    const memory = new RecordingMemory();
    const h = harness({ memory });
    const r = await h.wired.handleLine(speakerLine);
    expect(r).toEqual({ kind: "memory", memoryId: "mem-written-1" });
    const attempt = h.store.all.find((e) => e.kind === "reachy.memory.attempt");
    const written = h.store.all.find((e) => e.kind === "reachy.memory.written");
    expect(attempt).toBeDefined();
    expect(written).toBeDefined();
    expect(written!.refId).toBe(`orgevent-${attempt!.id}`); // correlated
    expect(written!.targetIds).toContain("mem-written-1");
    expect(h.store.all.some((e) => e.kind === "reachy.memory")).toBe(false); // no unqualified "wrote" kind
  });

  it("a FAILED write leaves attempt + a LINKED failed, no written, and is LOGGED", async () => {
    const memory = new RecordingMemory();
    memory.fail = true;
    const logs: string[] = [];
    const h = harness({ memory, logs });
    const r = await h.wired.handleLine(speakerLine);
    expect(r.kind).toBe("refused");
    const attempt = h.store.all.find((e) => e.kind === "reachy.memory.attempt");
    const failed = h.store.all.find((e) => e.kind === "reachy.memory.failed");
    expect(attempt).toBeDefined();
    expect(failed).toBeDefined();
    expect(failed!.refId).toBe(`orgevent-${attempt!.id}`); // linked to the attempt
    expect(failed!.summary).toContain("FlairUnavailableError"); // the error CLASS
    expect(h.store.all.some((e) => e.kind === "reachy.memory.written")).toBe(false);
    // The refusal is linked too, and the failure is logged — never swallowed.
    const refused = h.store.all.find((e) => e.kind === "reachy.refused");
    expect(refused!.refId).toBe(`orgevent-${attempt!.id}`);
    expect(logs.some((m) => m.includes("memory write failed"))).toBe(true);
  });
});

// ── round 5 review: a failed sidecar SEND after the audit is a refusal, not a reject ──
describe("reachy round 5 review: a failed commands.send is handled, never swallowed", () => {
  class FailingCommands implements ReachyCommands {
    async send(): Promise<unknown> {
      throw new Error("sidecar not connected");
    }
  }
  function wiredWithFailingSend() {
    const store = new SlowStore();
    const logs: string[] = [];
    const wired = wireReachyCapability({
      pi: new NoPi(),
      commands: new FailingCommands(),
      memory: new RecordingMemory(),
      store,
      state: {
        wakeName: "jarvis",
        enrolment: {},
        mute: false,
        nowMs: () => 1,
        lastAcknowledgeAtMs: undefined,
      },
      log: (m) => logs.push(m),
    });
    return { wired, store, logs };
  }

  it("an admitted command whose send fails returns a LINKED refusal and is logged", async () => {
    const { wired, store, logs } = wiredWithFailingSend();
    const r = await wired.handleLine(
      JSON.stringify({
        type: "proposal",
        action: "look",
        args: { yaw: 1, pitch: 2 },
        confidence: 0.9,
        inputs: [],
      }),
    );
    expect(r.kind).toBe("refused");
    const refused = store.all.find((e) => e.kind === "reachy.refused");
    expect(refused).toBeDefined();
    expect(refused!.summary).toContain("sidecar send failed");
    expect(logs.some((m) => m.includes("sidecar send failed"))).toBe(true);
  });
});

// ── item 4: full-UUID event ids ───────────────────────────────────────────────
describe("reachy round 5 item 4: event ids are full UUIDs, not a time + short suffix", () => {
  it("uuids sharing their first 8 characters still yield DISTINCT ids (fixed clock)", async () => {
    // Every injected uuid shares its FIRST EIGHT characters: a `slice(0, 8)`
    // suffix (the old shape) would make every id identical at a fixed clock.
    let n = 0;
    const uuid = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const h = harness({
      uuid,
      nowMs: () => 1,
      memory: { writePrivate: async () => ({ id: "m" }) } as MemoryWriter,
    });
    // Two refusals at the SAME fixed clock.
    await h.wired.handleLine(
      JSON.stringify({ type: "proposal", action: "say", args: {}, confidence: 0.5, inputs: [] }),
    );
    await h.wired.handleLine(
      JSON.stringify({ type: "proposal", action: "say", args: {}, confidence: 0.5, inputs: [] }),
    );
    const refused = h.store.all.filter((e) => e.kind === "reachy.refused").map((e) => e.id);
    expect(refused.length).toBe(2);
    expect(refused[0]).not.toBe(refused[1]);
    // And two malformed lines likewise, at the same fixed clock.
    const h3 = harness({ uuid, nowMs: () => 1 });
    await h3.wired.handleLine("not json");
    await h3.wired.handleLine("not json either");
    const malformed = h3.store.all.filter((e) => e.kind === "reachy.malformed").map((e) => e.id);
    expect(malformed.length).toBe(2);
    expect(malformed[0]).not.toBe(malformed[1]);
  });
});
