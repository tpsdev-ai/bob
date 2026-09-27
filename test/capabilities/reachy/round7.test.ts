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
import { flairOrgEventStore } from "../../../src/capabilities/reachy/client.js";
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
    // Buggy shaped readback: targetIds is a string that CONTAINS the event's
    // REAL target ids — so a bare `.includes(id)` substring match would wrongly
    // succeed, and ONLY the Array.isArray guard rejects it (round 9 item 2:
    // built from the id the store saw, so removing the guard turns (b) RED).
    const real = Array.isArray(e.targetIds) ? e.targetIds.join(" ") : "";
    return { ...e, targetIds: `mem-1-other ${real}` } as unknown as OrgEvent;
  }
}
/**
 * A store whose write PERSISTS the event and THEN THROWS — for the `written`
 * OUTCOME event only (round 9 item 3): the store holds it but the handler never
 * sees the success. Every OTHER event (the attempt, the linked `failed`) is
 * persisted normally, so the memory IS created and the refusal is the UNAUDITED
 * kind, not the "audit write failed — memory NOT written" kind.
 */
class PersistThenThrowStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  readonly byId = new Map<string, OrgEvent>();
  async write(event: OrgEvent): Promise<{ id: string }> {
    const id = orgEventRecordId(event);
    this.byId.set(id, event);
    this.all.push(event);
    if (event.kind === "reachy.memory.written") {
      throw new Error("boom after persisting the written outcome event");
    }
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

describe("reachy round 9 item 3c: a store whose write PERSISTS the written outcome then THROWS", () => {
  it("is the UNAUDITED refusal, and explainMemory on the SAME store still returns the persisted event", async () => {
    // ONE store: it persists EVERY event, then throws on the `written` outcome.
    const store = new PersistThenThrowStore();
    const h = harness(store);
    const r = await h.wired.handleLine(speakerLine);
    expect(r.kind).toBe("refused"); // assertion: the handler refuses
    expect("reason" in r && r.reason).toContain("unaudited"); // assertion: UNAUDITED, not "NOT written"
    // The memory WAS created (the attempt audit succeeded; only `written` threw).
    expect(h.memory.last).toBeDefined();
    const written = store.all.find((e) => e.kind === "reachy.memory.written");
    expect(written).toBeDefined(); // assertion: the written outcome IS persisted

    // The SAME store the handler used: explainMemory returns the persisted event
    // for the handler-created memory (id "mem-written-1").
    const why = await explainMemory("mem-written-1", {
      getMemory: () => Promise.resolve({ metadata: h.memory.last!.metadata }),
      store,
    });
    expect(why).not.toBeNull(); // assertion: the persisted event explains the memory
    expect(why!.orgEvent.kind).toBe("reachy.memory.written");
    expect(why!.orgEvent.targetIds).toContain("mem-written-1");
  });
});

describe("reachy round 9 item 1a2: the ADAPTER requires a present targetIds array", () => {
  /** A fake flair client: `get` returns the given JSON content, verbatim. */
  const fakeClient = (content: unknown) => ({
    async write(): Promise<{ id: string }> {
      return { id: "x" };
    },
    async get(): Promise<{ content?: string } | null> {
      return { content: JSON.stringify(content) };
    },
  });

  it("returns null from the ADAPTER when the readback has NO targetIds", async () => {
    // Drive the adapter's parse (flairOrgEventStore), NOT a fake store: a well
    // formed record apart from a MISSING targetIds must read back as null.
    const store = flairOrgEventStore(
      fakeClient({
        id: "evt_a2",
        kind: "reachy.memory.written",
        authorId: "jarvis",
        summary: "",
        createdAt: new Date(1).toISOString(),
        nonce: "n",
        tsMs: 1,
      }),
    );
    expect(await store.getById(orgEventRecordId(ev({ id: "evt_a2", kind: "x" })))).toBeNull();
  });

  it("returns null from the ADAPTER when a targetIds element is not a string", async () => {
    const store = flairOrgEventStore(
      fakeClient(
        ev({
          id: "evt_a2b",
          kind: "reachy.memory.written",
          targetIds: ["ok", 7 as unknown as string],
        }),
      ),
    );
    expect(await store.getById(orgEventRecordId(ev({ id: "evt_a2b", kind: "x" })))).toBeNull();
  });

  it("CONTROL: returns the event from the ADAPTER when targetIds IS an array of strings", async () => {
    const store = flairOrgEventStore(
      fakeClient(ev({ id: "evt_a2c", kind: "reachy.memory.written", targetIds: ["mem-1"] })),
    );
    const got = await store.getById(orgEventRecordId(ev({ id: "evt_a2c", kind: "x" })));
    expect(got).not.toBeNull();
    expect(got!.targetIds).toEqual(["mem-1"]);
  });
});
