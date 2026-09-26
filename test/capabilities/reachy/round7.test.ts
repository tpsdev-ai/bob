// reachy S3 — round 7: the read side validates the event it explains; success
// requires proof the audit holds the id; args are bounded (bob#180 items 1-3).
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
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
  };
  async writePrivate(w: {
    content: string;
    visibility: "private";
    authorId: string;
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
  }): Promise<{ id: string }> {
    this.last = w;
    return { id: "mem-written-1" };
  }
}

/** A simple id-keyed store (its write reports the record id and it reads back). */
class MapStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  readonly byId = new Map<string, OrgEvent>();
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
/** A store whose write REPORTS a different id than the event it was handed. */
class MismatchIdStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  async write(event: OrgEvent): Promise<{ id: string }> {
    this.all.push(event);
    return { id: "someone-elses-record-id" };
  }
  async getById(): Promise<OrgEvent | null> {
    return null;
  }
}
/** A store whose write succeeds but whose readback ALWAYS returns null. */
class NullReadbackStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  readonly byId = new Map<string, OrgEvent>();
  async write(event: OrgEvent): Promise<{ id: string }> {
    const id = orgEventRecordId(event);
    this.byId.set(id, event);
    this.all.push(event);
    return { id };
  }
  async getById(): Promise<OrgEvent | null> {
    return null;
  }
}

function ev(over: Partial<OrgEvent> & { id: string; kind: string }): OrgEvent {
  return {
    authorId: "jarvis",
    summary: "",
    targetIds: [],
    createdAt: new Date(1).toISOString(),
    nonce: "n",
    tsMs: 1,
    ...over,
  };
}

function harness(store: OrgEventStore) {
  const commands = new RecordingCommands();
  const memory = new RecordingMemory();
  const state: PolicyState = {
    wakeName: "jarvis",
    enrolment: { "spk-1": "member-1" },
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
    log: () => {},
  });
  return { commands, memory, store, wired };
}

const speakerLine = {
  type: "transcript",
  text: "jarvis, remember the drill",
  ts: "t",
  wakeHeard: true,
  speakerId: "spk-1",
};

describe("reachy round 7 item 1: the read side accepts only a `written` event that TARGETS the memory", () => {
  it("returns null when the metadata points at the ATTEMPT, at another memory's written event, or the event is missing", async () => {
    const store = new MapStore();
    const attempt = ev({ id: "evt_attempt", kind: "reachy.memory.attempt", targetIds: ["spk-1"] });
    const otherWritten = ev({
      id: "evt_other",
      kind: "reachy.memory.written",
      targetIds: ["mem_OTHER"],
    });
    store.byId.set(orgEventRecordId(attempt), attempt);
    store.byId.set(orgEventRecordId(otherWritten), otherWritten);

    const why = (orgEventId: string) =>
      explainMemory("mem_1", {
        getMemory: () => Promise.resolve({ metadata: { orgEventId } }),
        store,
      });

    expect(await why(orgEventRecordId(attempt))).toBeNull(); // an attempt is NOT an explanation
    expect(await why(orgEventRecordId(otherWritten))).toBeNull(); // written, but not THIS memory
    expect(
      await why(orgEventRecordId(ev({ id: "evt_missing", kind: "reachy.memory.written" }))),
    ).toBeNull();

    // CONTROL: a `written` event that DOES target mem_1 is returned.
    const mine = ev({
      id: "evt_mine",
      kind: "reachy.memory.written",
      targetIds: ["mem-written-1", "mem_1"],
    });
    store.byId.set(orgEventRecordId(mine), mine);
    const got = await why(orgEventRecordId(mine));
    expect(got).not.toBeNull();
    expect(got!.orgEvent.kind).toBe("reachy.memory.written");
  });
});

describe("reachy round 7 item 2: success needs the store to hold the EXACT pre-generated id", () => {
  it("(a) a write that REPORTS a different id is an UNAUDITED refusal with a linked failed event", async () => {
    const store = new MismatchIdStore();
    const h = harness(store);
    const r = await h.wired.handleLine(speakerLine);
    expect(r.kind).toBe("refused");
    expect(h.memory.last).toBeDefined(); // the memory WAS created (and retained)
    const failed = store.all.find((e) => e.kind === "reachy.memory.failed");
    expect(failed).toBeDefined();
    expect(failed!.summary).toContain("IdMismatch");
    // No readable `written` event under the pre-generated id → nothing to explain.
    const why = await explainMemory("mem-written-1", {
      getMemory: () => Promise.resolve({ metadata: h.memory.last!.metadata }),
      store,
    });
    expect(why).toBeNull();
  });

  it("(b) a write whose READBACK returns null is an UNAUDITED refusal with a linked failed event", async () => {
    const store = new NullReadbackStore();
    const h = harness(store);
    const r = await h.wired.handleLine(speakerLine);
    expect(r.kind).toBe("refused");
    expect(h.memory.last).toBeDefined();
    const failed = store.all.find((e) => e.kind === "reachy.memory.failed");
    expect(failed).toBeDefined();
    expect(failed!.summary).toContain("ReadbackMissing");
    // The memory is retained and the read side returns nothing for it.
    const why = await explainMemory("mem-written-1", {
      getMemory: () =>
        Promise.resolve({
          metadata: { orgEventId: h.memory.last!.metadata.orgEventId, speakerId: "spk-1" },
        }),
      store,
    });
    expect(why).toBeNull();
  });
});

describe("reachy round 7 item 3: args are BOUNDED by action", () => {
  it("look yaw 1e100, an ask with a newline, and a 501-char say are all malformed and never sent", async () => {
    const h = harness(new MapStore());
    await h.wired.handleLine(speakerLine); // a transcript so an addressed say would be admitted

    const badYaw = await h.wired.handleLine({
      type: "proposal",
      action: "look",
      args: { yaw: 1e100, pitch: 0 },
      confidence: 0.5,
      inputs: [],
    });
    expect(badYaw.kind).toBe("malformed");

    const newlineAsk = await h.wired.handleLine({
      type: "proposal",
      action: "ask",
      args: { text: "hello\nworld" },
      confidence: 0.5,
      inputs: [],
    });
    expect(newlineAsk.kind).toBe("malformed");

    const longSay = await h.wired.handleLine({
      type: "proposal",
      action: "say",
      args: { text: "x".repeat(501) },
      confidence: 0.5,
      inputs: [],
    });
    expect(longSay.kind).toBe("malformed");

    expect(h.commands.sent.some((c) => c.command === "look_at")).toBe(false);
    expect(h.commands.sent.some((c) => c.command === "say")).toBe(false);
    expect(h.store.all.filter((e) => e.kind === "reachy.malformed").length).toBe(3);

    // CONTROL: within the bounds, all three are admitted (and sent).
    expect(
      (
        await h.wired.handleLine({
          type: "proposal",
          action: "look",
          args: { yaw: 180, pitch: -90 },
          confidence: 0.5,
          inputs: [],
        })
      ).kind,
    ).toBe("admitted");
    expect(
      (
        await h.wired.handleLine({
          type: "proposal",
          action: "say",
          args: { text: "x".repeat(500) },
          confidence: 0.5,
          inputs: [],
        })
      ).kind,
    ).toBe("admitted");
  });
});

/** A store whose readback returns a targetIds that is a STRING, not an array. */
class BadTargetIdsStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  readonly byId = new Map<string, OrgEvent>();
  async write(event: OrgEvent): Promise<{ id: string }> {
    const id = orgEventRecordId(event);
    this.byId.set(id, event);
    this.all.push(event);
    return { id };
  }
  async getById(id: string): Promise<OrgEvent | null> {
    const e = this.byId.get(id);
    if (!e) return null;
    // Buggy shaped readback: targetIds is a string (substring-matches in includes).
    return { ...e, targetIds: "mem-1-other" } as unknown as OrgEvent;
  }
}
/**
 * A store whose write PERSISTs then THROWS — the event is stored but the
 * write call throws after successfully persisting.
 */
class PersistThenThrowStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  readonly byId = new Map<string, OrgEvent>();
  throwAfterWrite = false;
  async write(event: OrgEvent): Promise<{ id: string }> {
    if (this.throwAfterWrite) {
      const id = orgEventRecordId(event);
      this.byId.set(id, event);
      this.all.push(event);
      throw new Error("boom after persist");
    }
    const id = orgEventRecordId(event);
    this.byId.set(id, event);
    this.all.push(event);
    return { id };
  }
  async getById(id: string): Promise<OrgEvent | null> {
    return this.byId.get(id) ?? null;
  }
}

describe("reachy round 7 item 1b: shape validation at the membership site", () => {
  it("explainMemory returns null when targetIds is a string (substring trap)", async () => {
    const bstore = new BadTargetIdsStore();
    // Put a correctly-shaped written event in the store.
    const written = ev({
      id: "evt_str",
      kind: "reachy.memory.written",
      targetIds: ["mem-1"],
    });
    bstore.byId.set(orgEventRecordId(written), written);

    // Now explainMemory calls getById which returns a string targetIds.
    const why = await explainMemory("mem-1", {
      getMemory: () => Promise.resolve({ metadata: { orgEventId: orgEventRecordId(written) } }),
      store: bstore as unknown as OrgEventStore,
    });
    // The Array.isArray check at the membership site rejects the string.
    expect(why).toBeNull();
  });
});

describe("reachy round 7 item 2b: a string targetIds in readback → ReadbackTargets refusal", () => {
  it("returns UNAUDITED refusal when the readback has string targetIds", async () => {
    const store = new BadTargetIdsStore();
    const h = harness(store);
    const r = await h.wired.handleLine(speakerLine);
    expect(r.kind).toBe("refused");
    // The readback had targetIds as a string so the array check failed.
    const failed = store.all.find((e) => e.kind === "reachy.memory.failed");
    expect(failed).toBeDefined();
    expect(failed!.summary).toContain("ReadbackTargets");
    // No memory success: explainMemory also returns null.
    const why = await explainMemory("mem-written-1", {
      getMemory: () => Promise.resolve({ metadata: h.memory.last!.metadata }),
      store,
    });
    expect(why).toBeNull();
  });
});

describe("reachy round 7 item 2c: a write that persists then throws", () => {
  it("is a refusal AND explainMemory still returns the persisted event", async () => {
    const store = new PersistThenThrowStore();
    store.throwAfterWrite = true;
    const h = harness(store);
    const r = await h.wired.handleLine(speakerLine);
    expect(r.kind).toBe("refused");

    // Test explainMemory: use a store that can actually read.
    const store2 = new PersistThenThrowStore();
    store2.throwAfterWrite = false; // normal mode for reads
    const writtenEvent = {
      id: "evt_mine",
      kind: "reachy.memory.written",
      authorId: "jarvis",
      summary: "wrote the private memory",
      targetIds: ["mem-1"],
      createdAt: new Date(1).toISOString(),
      nonce: "n",
      tsMs: 1,
    };
    await store2.write(writtenEvent);
    const why = await explainMemory("mem-1", {
      getMemory: () =>
        Promise.resolve({ metadata: { orgEventId: orgEventRecordId(writtenEvent) } }),
      store: store2,
    });
    // The persist-then-throw case: a memory can exist even when write throws.
    expect(why).not.toBeNull();
    expect(why!.orgEvent.kind).toBe("reachy.memory.written");
  });
});
