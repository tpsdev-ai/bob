// reachy S3 — memory semantics + OrgEvent audit on a stub sidecar (bob#180 §5 S3).
// Round 2: wire decoding, durable+ordered audit, tools through the gate.
import { describe, expect, it } from "bun:test";
import {
  type MemoryWriter,
  type OrgEventStore,
  type PiLike,
  type ReachyCommands,
  type WiredReachy,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import {
  isValidProposal,
  type OrgEvent,
  type PolicyState,
} from "../../../src/capabilities/reachy/policy.js";
import { explainMemory } from "../../../src/capabilities/reachy/query.js";
import { decodeLine } from "../../../src/capabilities/reachy/wire.js";

class FakePi implements PiLike {
  readonly tools = new Map<
    string,
    {
      name: string;
      execute: (
        id: string,
        p: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
    }
  >();
  registerTool(tool: {
    name: string;
    execute: (
      id: string,
      p: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void {
    this.tools.set(tool.name, tool);
  }
  async call(name: string, params: Record<string, unknown>): Promise<string> {
    const t = this.tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return (await t.execute("tc", params)).content.map((c) => c.text).join("");
  }
}

class FakeCommands implements ReachyCommands {
  readonly sent: Array<{ command: string; args?: Record<string, unknown> }> = [];
  async send(command: string, args?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ command, args });
    return null;
  }
}

class FakeMemory implements MemoryWriter {
  readonly writes: Array<{
    content: string;
    visibility: string;
    authorId: string;
    metadata: { speakerId: string; correlationId: string };
  }> = [];
  private n = 0;
  async writePrivate(w: {
    content: string;
    visibility: "private";
    authorId: string;
    metadata: { speakerId: string; correlationId: string };
  }): Promise<{ id: string }> {
    this.writes.push(w);
    return { id: `mem_${++this.n}` };
  }
  metadata(id: string): { metadata?: Record<string, unknown> } | null {
    const i = Number(id.replace("mem_", "")) - 1;
    const w = this.writes[i];
    return w ? { metadata: w.metadata } : null;
  }
}

/** A DURABLE fake event store: survives a "restart"; can be told to fail. */
class FakeStore implements OrgEventStore {
  readonly byCorr = new Map<string, OrgEvent>();
  readonly all: OrgEvent[] = [];
  fail = false;
  async write(event: OrgEvent): Promise<{ id: string }> {
    if (this.fail) throw new Error("event store unavailable");
    const corr = String(event.metadata.correlationId ?? "");
    if (corr) this.byCorr.set(corr, event);
    this.all.push(event);
    return { id: `evt_${this.all.length}` };
  }
  async readByCorrelation(correlationId: string): Promise<OrgEvent | null> {
    return this.byCorr.get(correlationId) ?? null;
  }
}

function harness(
  enrolment: Record<string, string>,
  opts: { mute?: boolean; store?: FakeStore } = {},
) {
  const pi = new FakePi();
  const commands = new FakeCommands();
  const memory = new FakeMemory();
  const store = opts.store ?? new FakeStore();
  const state: PolicyState = {
    wakeName: "jarvis",
    enrolment,
    mute: opts.mute ?? false,
    nowMs: () => Date.now(),
    lastAcknowledgeAtMs: undefined,
  };
  const wired: WiredReachy = wireReachyCapability({
    pi,
    commands,
    memory,
    store,
    state,
    log: () => {},
  });
  return { pi, commands, memory, store, wired, state };
}

const transcriptLine = (over: Record<string, unknown> = {}) => ({
  type: "transcript",
  text: "jarvis, remember the fire drill is Tuesday",
  ts: "t",
  wakeHeard: true,
  speakerId: "spk-1",
  ...over,
});

describe("reachy S3 policy (bob#180 §3.3/§4)", () => {
  it("(a) addressed + speakerVerified => ONE private memory with speakerId, and explainMemory answers 'why'", async () => {
    const h = harness({ "spk-1": "member-1" });
    const r = await h.wired.handleLine(transcriptLine());
    expect(r).toEqual({ kind: "memory", memoryId: "mem_1" });
    expect(h.memory.writes.length).toBe(1);
    expect(h.memory.writes[0]!.visibility).toBe("private");
    expect(h.memory.writes[0]!.metadata.speakerId).toBe("spk-1");
    const why = await explainMemory("mem_1", {
      getMemory: (id) => Promise.resolve(h.memory.metadata(id)),
      store: h.store,
    });
    expect(why).not.toBeNull();
    expect(why!.authorId).toBe("jarvis");
    expect(why!.speakerId).toBe("spk-1");
  });

  it("(b) addressed but NOT verified => no write, at most one acknowledge per minute", async () => {
    const h = harness({});
    const t = transcriptLine({ speakerId: "spk-visitor" });
    expect(await h.wired.handleLine(t)).toEqual({ kind: "ephemeral", acknowledged: true });
    expect(await h.wired.handleLine(t)).toEqual({ kind: "ephemeral", acknowledged: false });
    expect(h.memory.writes.length).toBe(0);
    expect(h.store.all.filter((e) => e.kind === "reachy.acknowledge").length).toBe(1);
  });

  it("(c) not addressed => nothing at all", async () => {
    const h = harness({ "spk-1": "member-1" });
    expect(await h.wired.handleLine(transcriptLine({ text: "what time is standup" }))).toEqual({
      kind: "none",
    });
    expect(h.memory.writes.length).toBe(0);
    expect(h.store.all.length).toBe(0);
  });

  it("(d) egress: EVERY memory jarvis wrote is private", async () => {
    const h = harness({ "spk-1": "member-1", "spk-2": "member-2" });
    await h.wired.handleLine(transcriptLine({ text: "jarvis, note A", speakerId: "spk-1" }));
    await h.wired.handleLine(transcriptLine({ text: "jarvis, note B", speakerId: "spk-2" }));
    expect(h.memory.writes.length).toBe(2);
    expect(h.memory.writes.every((w) => w.visibility === "private")).toBe(true);
  });

  it("(e) proposal{answer} is NOT executed; a prose-only proposal is rejected by the schema", async () => {
    const h = harness({ "spk-1": "member-1" });
    await h.wired.handleLine(transcriptLine());
    const r = await h.wired.handleLine({
      type: "proposal",
      action: "answer",
      args: { text: "the answer" },
      confidence: 0.95,
      inputs: ["mem_9"],
    });
    expect(r.kind).toBe("refused");
    expect(h.commands.sent.length).toBe(0);
    expect(isValidProposal({ text: "jarvis, here is my prose answer" })).toBe(false);
    expect(decodeLine({ type: "proposal", text: "prose" }).kind).toBe("malformed");
  });

  it("(f) mute: true => events dropped, no OrgEvents", async () => {
    const h = harness({ "spk-1": "member-1" }, { mute: true });
    expect(await h.wired.handleLine(transcriptLine())).toEqual({ kind: "drop" });
    expect(h.memory.writes.length).toBe(0);
    expect(h.store.all.length).toBe(0);
  });
});

describe("reachy S3 round 2 — durable+ordered audit, gated tools, wire", () => {
  it("item 2: an event write that FAILS leaves NO memory; after restart explainMemory still answers", async () => {
    const h = harness({ "spk-1": "member-1" });
    h.store.fail = true;
    const r = await h.wired.handleLine(transcriptLine());
    expect(r.kind).toBe("refused");
    expect(h.memory.writes.length).toBe(0); // no memory without its audit

    // A fresh capability instance over the SAME store ("restart").
    h.store.fail = false;
    await h.wired.handleLine(transcriptLine({ text: "jarvis, note persist" }));
    const h2 = harness({ "spk-1": "member-1" }, { store: h.store });
    const why = await explainMemory("mem_1", {
      getMemory: (id) => Promise.resolve(h.memory.metadata(id)),
      store: h2.store,
    });
    expect(why).not.toBeNull(); // durable across the instance boundary
    expect(why!.orgEvent.kind).toBe("reachy.memory");
  });

  it("item 3: a direct reachy_say emits exactly one OrgEvent; memory-backed say is refused", async () => {
    const h = harness({ "spk-1": "member-1" });
    await h.wired.handleLine(transcriptLine()); // establishes the addressed transcript
    const before = h.store.all.length;
    await h.pi.call("reachy_say", { text: "hello office" });
    const after = h.store.all.length;
    expect(after - before).toBe(1); // one OrgEvent per admitted command
    expect(h.store.all.at(-1)!.kind).toBe("reachy.say");
    expect(h.commands.sent.some((c) => c.command === "say")).toBe(true);

    const sentBefore = h.commands.sent.length;
    await h.pi.call("reachy_say", { text: "recite the private note", memoryId: "mem_9" });
    expect(h.commands.sent.length).toBe(sentBefore); // memory-derived say refused
  });

  it("item 3: ten unverified look proposals in a minute do NOT all pass — admitting advances the rate limit", async () => {
    const h = harness({}); // empty enrolment → nothing verified
    let admitted = 0;
    for (let i = 0; i < 10; i++) {
      const r = await h.wired.handleLine({
        type: "proposal",
        action: "look",
        args: { yaw: i, pitch: 0 },
        confidence: 0.5,
        inputs: [],
      });
      if (r.kind === "admitted") admitted++;
    }
    expect(admitted).toBe(1); // only the first; the rest are rate-limited
  });

  it("wire: a malformed line is dropped with a reachy.malformed OrgEvent, never thrown", async () => {
    const h = harness({});
    const r = await h.wired.handleLine('{"type":"proposal","text":"just prose"}');
    expect(r.kind).toBe("malformed");
    expect(h.store.all.some((e) => e.kind === "reachy.malformed")).toBe(true);
  });
});
