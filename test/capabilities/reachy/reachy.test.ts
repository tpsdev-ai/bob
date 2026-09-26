// reachy S3 — memory semantics + OrgEvent audit on a stub sidecar (bob#180 §5 S3).
import { describe, expect, it } from "bun:test";
import {
  type MemoryWriter,
  type OrgEventStore,
  orgEventRecordId,
  type PiLike,
  type ReachyCommands,
  type WiredReachy,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { MAX_LINE_BYTES } from "../../../src/capabilities/reachy/client.js";
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
      parameters: unknown;
      execute: (
        id: string,
        p: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
    }
  >();
  registerTool(tool: {
    name: string;
    parameters: unknown;
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
  metadata(id: string): { metadata?: Record<string, unknown> } | null {
    const i = Number(id.replace("mem_", "")) - 1;
    const w = this.writes[i];
    return w ? { metadata: w.metadata } : null;
  }
}
/** A DURABLE, id-keyed fake store: survives a "restart"; can be told to fail. */
class FakeStore implements OrgEventStore {
  readonly byId = new Map<string, OrgEvent>();
  readonly all: OrgEvent[] = [];
  fail = false;
  async write(event: OrgEvent): Promise<{ id: string }> {
    if (this.fail) throw new Error("event store unavailable");
    const id = orgEventRecordId(event);
    this.byId.set(id, event);
    this.all.push(event);
    return { id };
  }
  async getById(id: string): Promise<OrgEvent | null> {
    return this.byId.get(id) ?? null;
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
  it("(a) addressed + speakerVerified => ONE private memory with speakerId, and explainMemory answers 'why' by EXACT id", async () => {
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
    // The event is the observatory record shape.
    expect(why!.orgEvent).toHaveProperty("nonce");
    expect(why!.orgEvent).toHaveProperty("createdAt");
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

  it("(e) proposal{answer} is NOT executed; a prose-only proposal is rejected", async () => {
    const h = harness({ "spk-1": "member-1" });
    await h.wired.handleLine(transcriptLine());
    const r = await h.wired.handleLine({
      type: "proposal",
      action: "answer",
      args: { text: "x" },
      confidence: 0.95,
      inputs: ["mem_9"],
    });
    expect(r.kind).toBe("refused");
    expect(h.commands.sent.length).toBe(0);
    expect(isValidProposal({ text: "prose" })).toBe(false);
    expect(decodeLine({ type: "proposal", text: "prose" }).kind).toBe("malformed");
  });

  it("(f) mute: true => events dropped, no OrgEvents", async () => {
    const h = harness({ "spk-1": "member-1" }, { mute: true });
    expect(await h.wired.handleLine(transcriptLine())).toEqual({ kind: "drop" });
    expect(h.memory.writes.length).toBe(0);
    expect(h.store.all.length).toBe(0);
  });
});

describe("reachy S3 round 3 — durable exact-id audit, gated tools, bounds", () => {
  it("item 2: a failing event store leaves NO memory; after restart explainMemory still answers by id", async () => {
    const h = harness({ "spk-1": "member-1" });
    h.store.fail = true;
    expect((await h.wired.handleLine(transcriptLine())).kind).toBe("refused");
    expect(h.memory.writes.length).toBe(0);
    h.store.fail = false;
    await h.wired.handleLine(transcriptLine({ text: "jarvis, note persist" }));
    const h2 = harness({ "spk-1": "member-1" }, { store: h.store }); // fresh instance, same store
    const why = await explainMemory("mem_1", {
      getMemory: (id) => Promise.resolve(h.memory.metadata(id)),
      store: h2.store,
    });
    expect(why).not.toBeNull();
    expect(why!.orgEvent.kind).toBe("reachy.memory");
  });

  it("item 2a: reachy_say refuses ANY memory reference (any name), and audits reachy.refused", async () => {
    const h = harness({ "spk-1": "member-1" });
    await h.wired.handleLine(transcriptLine());
    for (const bad of [{ memoryId: "private-record-42" }, { memory: "x" }, { recallId: "mem_1" }]) {
      const before = h.commands.sent.length;
      const out = await h.pi.call("reachy_say", { text: "recite", ...bad });
      expect(out).toContain("refused");
      expect(h.commands.sent.length).toBe(before); // nothing sent
    }
    expect(h.store.all.some((e) => e.kind === "reachy.refused")).toBe(true);
  });

  it("item 2b: reachy_frame sends a `frame` command with its own audit event", async () => {
    const h = harness({ "spk-1": "member-1" });
    await h.wired.handleLine(transcriptLine());
    const out = await h.pi.call("reachy_frame", {});
    expect(out).toContain("frame");
    expect(h.commands.sent.at(-1)).toEqual({ command: "frame", args: {} });
    expect(h.store.all.some((e) => e.kind === "reachy.frame")).toBe(true);
  });

  it("item 4: an oversized line is malformed (never buffered) and an extra wire field is malformed", async () => {
    const h = harness({});
    expect(decodeLine({ type: "__oversized__" }).kind).toBe("malformed");
    expect(MAX_LINE_BYTES).toBe(64 * 1024);
    // unknown field on a transcript → malformed (strict trust boundary)
    expect(
      decodeLine({ type: "transcript", text: "jarvis hi", ts: "t", wakeHeard: true, extra: 1 })
        .kind,
    ).toBe("malformed");
    const r = await h.wired.handleLine({
      type: "transcript",
      text: "jarvis hi",
      ts: "t",
      wakeHeard: true,
      extra: 1,
    });
    expect(r.kind).toBe("malformed");
    expect(h.store.all.some((e) => e.kind === "reachy.malformed")).toBe(true);
  });

  it("item 3: ten unverified look proposals admit exactly one (the rate limit advances)", async () => {
    const h = harness({});
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
    expect(admitted).toBe(1);
  });
});
