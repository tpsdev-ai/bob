// reachy S3 — round 6: (1) a memory must resolve to a `written` OUTCOME event,
// never to the attempt; (2) proposal arguments are validated BY ACTION and the
// speech gate applies to `ask` (bob#180 §3.3/§3.4, items 1 & 2).
import { describe, expect, it } from "bun:test";
import {
  type MemoryWriter,
  type OrgEventStore,
  orgEventRecordId,
  type PiLike,
  type ReachyCommands,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";
import { explainMemory } from "../../../src/capabilities/reachy/query.js";

class NoPi implements PiLike {
  registerTool(): void {}
}

class RecordingCommands implements ReachyCommands {
  readonly sent: Array<{ command: string; args?: Record<string, unknown> }> = [];
  async send(command: string, args?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ command, args });
    return null;
  }
}

class RecordingMemory implements MemoryWriter {
  last?: {
    content: string;
    visibility: "private";
    authorId: string;
    id?: string;
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
  };
  async writePrivate(w: {
    content: string;
    visibility: "private";
    authorId: string;
    id?: string;
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
  }): Promise<{ id: string }> {
    this.last = w;
    return { id: "mem-written-1" };
  }
  getMetadata(): { metadata?: Record<string, unknown> } | null {
    return this.last ? { metadata: this.last.metadata } : null;
  }
}

/** A durable, id-keyed store that can reject ONE event kind (the `written` audit). */
class SelectiveStore implements OrgEventStore {
  readonly byId = new Map<string, OrgEvent>();
  readonly all: OrgEvent[] = [];
  failKind: string | null = null;
  async write(event: OrgEvent): Promise<{ id: string }> {
    if (this.failKind !== null && event.kind === this.failKind)
      throw new Error(`event store rejects ${event.kind}`);
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
  opts: { store?: SelectiveStore; logs?: string[] } = {},
) {
  const commands = new RecordingCommands();
  const memory = new RecordingMemory();
  const store = opts.store ?? new SelectiveStore();
  const state: PolicyState = {
    wakeName: "jarvis",
    enrolment,
    mute: false,
    nowMs: () => 1,
    lastAcknowledgeAtMs: undefined,
  };
  const wired = wireReachyCapability({
    pi: new NoPi(),
    commands,
    memory,
    store,
    state,
    log: (m) => opts.logs?.push(m),
  });
  return { commands, memory, store, state, wired };
}

const speakerLine = {
  type: "transcript",
  text: "jarvis, remember the drill",
  ts: "t",
  wakeHeard: true,
  speakerId: "spk-1",
};

describe("reachy round 6 item 1: a memory resolves to its `written` event, never the attempt", () => {
  it("a persisted memory carries the `written` event's id and explainMemory reads that event", async () => {
    const h = harness({ "spk-1": "member-1" });
    const r = await h.wired.handleLine(speakerLine);
    expect(r).toEqual({ kind: "memory", memoryId: "mem-written-1" });
    const attempt = h.store.all.find((e) => e.kind === "reachy.memory.attempt");
    const written = h.store.all.find((e) => e.kind === "reachy.memory.written");
    expect(attempt).toBeDefined();
    expect(written).toBeDefined();
    // The memory's metadata points at the WRITTEN event, NOT the attempt.
    expect(h.memory.last!.metadata.orgEventId).toBe(orgEventRecordId(written!));
    expect(h.memory.last!.metadata.orgEventId).not.toBe(orgEventRecordId(attempt!));
    // The written event is still correlated to the attempt and names the memory.
    expect(written!.refId).toBe(orgEventRecordId(attempt!));
    expect(written!.targetIds).toContain("mem-written-1");
    // "why do you know this" resolves to the written event.
    const why = await explainMemory("mem-written-1", {
      getMemory: () => Promise.resolve(h.memory.getMetadata()),
      store: h.store,
    });
    expect(why).not.toBeNull();
    expect(why!.orgEvent.kind).toBe("reachy.memory.written");
    expect(why!.authorId).toBe("jarvis");
    expect(why!.speakerId).toBe("spk-1");
  });

  it("if the `written` audit write fails after the memory exists, the result is a refusal — never success — and explainMemory returns nothing", async () => {
    const store = new SelectiveStore();
    store.failKind = "reachy.memory.written";
    const logs: string[] = [];
    const h = harness({ "spk-1": "member-1" }, { store, logs });
    const r = await h.wired.handleLine(speakerLine);
    // NOT a success: the memory exists but its `written` event does not.
    expect(r.kind).toBe("refused");
    expect(h.memory.last).toBeDefined(); // the memory WAS created
    const attempt = h.store.all.find((e) => e.kind === "reachy.memory.attempt");
    expect(attempt).toBeDefined();
    expect(h.store.all.some((e) => e.kind === "reachy.memory.written")).toBe(false);
    const failed = h.store.all.find((e) => e.kind === "reachy.memory.failed");
    expect(failed).toBeDefined();
    expect(failed!.refId).toBe(orgEventRecordId(attempt!)); // linked to the attempt
    expect(logs.some((m) => m.includes("written"))).toBe(true);
    // explainMemory reads the WRITTEN event, which is absent → nothing, never the attempt.
    const why = await explainMemory("mem-written-1", {
      getMemory: () => Promise.resolve(h.memory.getMetadata()),
      store: h.store,
    });
    expect(why).toBeNull();
    expect(h.memory.last!.metadata.orgEventId).not.toBe(orgEventRecordId(attempt!));
  });
});

describe("reachy round 6 item 2: args validated by action; the speech gate applies to `ask`", () => {
  it("an `ask` proposal carrying a memory input is refused by the speech gate — no `say` is sent", async () => {
    const h = harness({ "spk-1": "member-1" });
    await h.wired.handleLine(speakerLine); // a transcript exists
    const withMemory = await h.wired.handleLine({
      type: "proposal",
      action: "ask",
      args: { text: "what did you learn?" },
      confidence: 0.9,
      inputs: ["mem_9"],
    });
    expect(withMemory.kind).toBe("refused");
    expect(h.commands.sent.some((c) => c.command === "say")).toBe(false);
    // CONTROL: the same `ask` with NO memory input is admitted (sent as a `say`).
    const plain = await h.wired.handleLine({
      type: "proposal",
      action: "ask",
      args: { text: "what time is it?" },
      confidence: 0.9,
      inputs: [],
    });
    expect(plain.kind).toBe("admitted");
    expect(h.commands.sent.at(-1)?.command).toBe("say");
  });

  it("a `look` proposal with a string yaw or an extra field is malformed and sends no `look_at`", async () => {
    const h = harness({ "spk-1": "member-1" });
    await h.wired.handleLine(speakerLine);
    const stringYaw = await h.wired.handleLine({
      type: "proposal",
      action: "look",
      args: { yaw: "45", pitch: 0 },
      confidence: 0.5,
      inputs: [],
    });
    expect(stringYaw.kind).toBe("malformed");
    const extraField = await h.wired.handleLine({
      type: "proposal",
      action: "look",
      args: { yaw: 45, pitch: 0, extra: 1 },
      confidence: 0.5,
      inputs: [],
    });
    expect(extraField.kind).toBe("malformed");
    expect(h.commands.sent.some((c) => c.command === "look_at")).toBe(false);
    expect(h.store.all.filter((e) => e.kind === "reachy.malformed").length).toBe(2);
    // CONTROL: a well-formed look IS admitted and sent.
    const good = await h.wired.handleLine({
      type: "proposal",
      action: "look",
      args: { yaw: 45, pitch: 0 },
      confidence: 0.5,
      inputs: [],
    });
    expect(good.kind).toBe("admitted");
    expect(h.commands.sent.at(-1)).toEqual({ command: "look_at", args: { yaw: 45, pitch: 0 } });
  });
});
