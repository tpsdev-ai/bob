// reachy S3 — memory semantics + OrgEvent audit on a stub sidecar (bob#180 §5 S3).
//
// Every assertion here is RED before the reachy capability exists: there was no
// policy, no write gate, no OrgEvent trail. Each test states what it proves.
import { describe, expect, it } from "bun:test";
import {
  type MemoryWriter,
  type PiLike,
  type ReachyCommands,
  type WiredReachy,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import {
  addressed,
  decideProposal,
  isValidProposal,
  type MemoryWrite,
  type OrgEvent,
  type PolicyState,
  speakerVerified,
} from "../../../src/capabilities/reachy/policy.js";
import { explainMemory } from "../../../src/capabilities/reachy/query.js";

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
  readonly writes: MemoryWrite[] = [];
  private n = 0;
  async writePrivate(w: MemoryWrite): Promise<{ id: string }> {
    this.writes.push(w);
    return { id: `mem_${++this.n}` };
  }
}

function harness(enrolment: Record<string, string>, mute = false) {
  const pi = new FakePi();
  const commands = new FakeCommands();
  const memory = new FakeMemory();
  const events: OrgEvent[] = [];
  const state: PolicyState = {
    wakeName: "jarvis",
    enrolment,
    mute,
    nowMs: () => Date.now(),
    lastAcknowledgeAtMs: undefined,
  };
  const wired: WiredReachy = wireReachyCapability({
    pi,
    commands,
    memory,
    emit: (e) => {
      events.push(e);
    },
    state,
    log: () => {},
  });
  return { pi, commands, memory, events, wired, state };
}

describe("reachy S3 policy (bob#180 §3.3/§4)", () => {
  it("(a) addressed + speakerVerified => ONE private memory with speakerId, and the OrgEvent answers why", async () => {
    const h = harness({ "spk-1": "member-1" });
    const r = await h.wired.handleEvent(
      {
        transcript: {
          text: "jarvis, remember the fire drill is Tuesday",
          ts: "t",
          wakeHeard: true,
          speakerId: "spk-1",
        },
      },
      "transcript",
    );
    expect(r).toEqual({ kind: "memory", memoryId: "mem_1" });
    expect(h.memory.writes.length).toBe(1);
    expect(h.memory.writes[0]!.visibility).toBe("private");
    expect(h.memory.writes[0]!.authorId).toBe("jarvis");
    expect(h.memory.writes[0]!.metadata.speakerId).toBe("spk-1");
    // "why do you know this": the OrgEvent that created it.
    const why = explainMemory("mem_1", h.events);
    expect(why).not.toBeNull();
    expect(why!.authorId).toBe("jarvis");
    expect(why!.speakerId).toBe("spk-1");
  });

  it("(b) addressed but NOT verified => no write, nothing recallable, at most one acknowledge per minute", async () => {
    const h = harness({}); // v1 enrolment is EMPTY by default
    const t = {
      transcript: {
        text: "jarvis look at the door",
        ts: "t",
        wakeHeard: true,
        speakerId: "spk-visitor",
      },
    };
    const first = await h.wired.handleEvent(t, "transcript");
    const second = await h.wired.handleEvent(t, "transcript");
    expect(first).toEqual({ kind: "ephemeral", acknowledged: true });
    expect(second).toEqual({ kind: "ephemeral", acknowledged: false }); // rate-limited
    expect(h.memory.writes.length).toBe(0); // nothing durable
    expect(h.events.filter((e) => e.kind === "reachy.acknowledge").length).toBe(1);
  });

  it("(c) not addressed => nothing at all", async () => {
    const h = harness({ "spk-1": "member-1" });
    const r = await h.wired.handleEvent(
      {
        transcript: { text: "what time is standup", ts: "t", wakeHeard: false, speakerId: "spk-1" },
      },
      "transcript",
    );
    expect(r).toEqual({ kind: "none" });
    expect(h.memory.writes.length).toBe(0);
    expect(h.events.length).toBe(0);
  });

  it("(d) egress: EVERY memory jarvis wrote in the test is private", async () => {
    const h = harness({ "spk-1": "member-1", "spk-2": "member-2" });
    await h.wired.handleEvent(
      { transcript: { text: "jarvis, note A", ts: "t", wakeHeard: true, speakerId: "spk-1" } },
      "transcript",
    );
    await h.wired.handleEvent(
      { transcript: { text: "jarvis, note B", ts: "t", wakeHeard: true, speakerId: "spk-2" } },
      "transcript",
    );
    expect(h.memory.writes.length).toBe(2);
    expect(h.memory.writes.every((w) => w.visibility === "private")).toBe(true);
  });

  it("(e) proposal{answer} is NOT executed while answer is off; a prose-only proposal is rejected by the schema", async () => {
    const h = harness({ "spk-1": "member-1" });
    const answer = await h.wired.handleEvent(
      {
        proposal: {
          action: "answer",
          args: { text: "the answer" },
          confidence: 0.95,
          inputs: ["mem_9"],
        },
      },
      "proposal",
    );
    expect(answer.kind).toBe("refused"); // fail closed
    expect(h.commands.sent.length).toBe(0); // nothing executed
    expect(h.events.length).toBe(0); // no OrgEvent for a refused answer
    // prose-only (no typed action) fails the schema
    expect(isValidProposal({ text: "jarvis, here is my prose answer" })).toBe(false);
    expect(isValidProposal({ action: "look", args: {}, confidence: 0.5, inputs: [] })).toBe(true);
  });

  it("(f) mute: true => events dropped, no OrgEvents", async () => {
    const h = harness({ "spk-1": "member-1" }, true);
    const r = await h.wired.handleEvent(
      {
        transcript: { text: "jarvis, remember this", ts: "t", wakeHeard: true, speakerId: "spk-1" },
      },
      "transcript",
    );
    expect(r).toEqual({ kind: "drop" });
    expect(h.memory.writes.length).toBe(0);
    expect(h.events.length).toBe(0);
  });
});

describe("reachy S3 helpers", () => {
  it("addressed is a bob-side string compare (the sidecar's wakeHeard is ignored for authority)", () => {
    expect(addressed("jarvis, look", "jarvis")).toBe(true);
    expect(addressed("hey you", "jarvis")).toBe(false);
  });
  it("speakerVerified requires a bob-owned enrolment mapping (empty in v1)", () => {
    expect(speakerVerified("spk-1", {})).toBe(false);
    expect(speakerVerified(undefined, { "spk-1": "m" })).toBe(false);
    expect(speakerVerified("spk-1", { "spk-1": "m" })).toBe(true);
  });
  it("the four tools are registered and reachy_look sends look_at", async () => {
    const h = harness({});
    expect([...h.pi.tools.keys()].sort()).toEqual([
      "reachy_frame",
      "reachy_look",
      "reachy_say",
      "reachy_state",
    ]);
    await h.pi.call("reachy_look", { yaw: 10, pitch: -5 });
    expect(h.commands.sent[0]).toEqual({ command: "look_at", args: { yaw: 10, pitch: -5 } });
  });
  it("an admitted look emits an OrgEvent carrying confidence + inputs", async () => {
    const h = harness({ "spk-1": "m" });
    await h.wired.handleEvent(
      {
        transcript: {
          text: "jarvis, look at the door",
          ts: "t",
          wakeHeard: true,
          speakerId: "spk-1",
        },
      },
      "transcript",
    );
    const r = await h.wired.handleEvent(
      {
        proposal: {
          action: "look",
          args: { yaw: 0, pitch: 0 },
          confidence: 0.8,
          inputs: ["cam-1"],
        },
      },
      "proposal",
    );
    expect(r).toEqual({ kind: "admitted", action: "look" });
    const ev = h.events.find((e) => e.kind === "reachy.look");
    expect(ev).toBeDefined();
    expect(ev!.metadata.confidence).toBe(0.8);
    expect(ev!.metadata.inputs).toEqual(["cam-1"]);
    expect(h.commands.sent.some((c) => c.command === "look_at")).toBe(true);
  });
});
