// reachy S3 — round 4: the line bound, strict wire envelopes, and claims that
// hold in the real runtime (bob#180 rounds 3-4).
import { describe, expect, it } from "bun:test";
import { Value } from "typebox/value";
import {
  type MemoryWriter,
  type OrgEventStore,
  type PiLike,
  PLACEHOLDER_TOOLS,
  type ReachyCommands,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { MAX_LINE_BYTES, UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import { reachyManifest } from "../../../src/capabilities/reachy/manifest.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";
import { decodeLine } from "../../../src/capabilities/reachy/wire.js";

class CapturingPi implements PiLike {
  readonly tools = new Map<
    string,
    {
      parameters: unknown;
      execute: (
        id: string,
        p: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
    }
  >();
  registerTool(tool: {
    name: string;
    parameters: unknown;
    execute: (
      id: string,
      p: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
  }): void {
    this.tools.set(tool.name, tool);
  }
}
class NoCommands implements ReachyCommands {
  readonly sent: Array<{ command: string; args?: Record<string, unknown> }> = [];
  async send(command: string, args?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ command, args });
    return null;
  }
}
class NoMemory implements MemoryWriter {
  readonly writes: unknown[] = [];
  async writePrivate(w: { content: string }): Promise<{ id: string }> {
    this.writes.push(w);
    return { id: "mem" };
  }
}
class NoStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  async write(e: OrgEvent): Promise<{ id: string }> {
    this.all.push(e);
    return { id: e.id };
  }
  async getById(): Promise<OrgEvent | null> {
    return null;
  }
}

function collect(chunks: string[]) {
  const client = new UnixSocketReachyClient({ socket: "/unused" });
  const lines: unknown[] = [];
  client.onLine((l) => lines.push(l));
  for (const c of chunks) client.ingest(c);
  return lines;
}

describe("reachy round 4 — the line bound discards through the newline", () => {
  const proposal = JSON.stringify({
    type: "proposal",
    action: "look",
    args: { yaw: 1, pitch: 2 },
    confidence: 0.9,
    inputs: [],
  });

  it("an oversized prefix + a proposal ON THE SAME LINE (split across writes) is never admitted", () => {
    // The prefix overflows with NO newline yet, then the rest of the SAME line —
    // a valid proposal — arrives in the next write. It must be swallowed with its
    // line, not parsed as a fresh one (round 4 item 2: discard THROUGH the newline).
    const prefix = "x".repeat(MAX_LINE_BYTES + 1);
    const lines = collect([prefix, proposal + "\n"]);
    expect(lines.length).toBe(1);
    expect(decodeLine(lines[0])).toMatchObject({ kind: "malformed" });
    expect(lines.some((l) => decodeLine(l).kind === "proposal")).toBe(false);
  });

  it("an oversized line delivered WHOLE is one malformed, and nothing else", () => {
    const lines = collect(["x".repeat(MAX_LINE_BYTES + 1) + proposal + "\n"]);
    expect(lines.length).toBe(1);
    expect(decodeLine(lines[0])).toMatchObject({ kind: "malformed" });
    expect(lines.some((l) => decodeLine(l).kind === "proposal")).toBe(false);
  });

  it("the line AFTER an oversized one parses normally", () => {
    const valid = JSON.stringify({
      type: "transcript",
      text: "jarvis hi",
      ts: "t",
      wakeHeard: true,
      speakerId: "spk-1",
    });
    const lines = collect(["x".repeat(MAX_LINE_BYTES + 1) + "\n", valid + "\n"]);
    const kinds = lines.map((l) => decodeLine(l).kind);
    expect(kinds).toContain("malformed");
    expect(kinds).toContain("transcript");
    expect(kinds.filter((k) => k === "malformed").length).toBe(1);
  });

  it("a large chunk of SHORT lines is fully retained (not dropped wholesale)", () => {
    const n = 4000; // ~23 bytes/line × 4000 ≈ 92 KiB, well over the 64 KiB bound
    const chunk =
      Array.from({ length: n }, () => JSON.stringify({ type: "health", ok: true })).join("\n") +
      "\n";
    expect(chunk.length).toBeGreaterThan(MAX_LINE_BYTES);
    const lines = collect([chunk]);
    expect(lines.length).toBe(n);
    expect(lines.every((l) => decodeLine(l).kind === "health")).toBe(true);
  });

  it("an oversized line split across chunks yields exactly ONE malformed", () => {
    const big = "y".repeat(MAX_LINE_BYTES + 10);
    const lines = collect([big.slice(0, MAX_LINE_BYTES + 5), big.slice(MAX_LINE_BYTES + 5) + "\n"]);
    expect(lines.length).toBe(1);
    expect(decodeLine(lines[0])).toMatchObject({ kind: "malformed" });
  });
});

describe("reachy round 4 — strict wire envelopes and the stub's health shape", () => {
  it("unknown OUTER fields on presence and proposal are malformed", () => {
    expect(decodeLine({ type: "presence", count: 1, known: ["a"], extra: 1 })).toMatchObject({
      kind: "malformed",
    });
    expect(
      decodeLine({
        type: "proposal",
        action: "look",
        args: { yaw: 1 },
        confidence: 0.9,
        inputs: [],
        extra: 1,
      }),
    ).toMatchObject({ kind: "malformed" });
  });

  it("the stub's REAL health line is valid (and an unknown health field is not)", () => {
    // Exactly what test/fixtures/reachy-stub/sidecar.py sends:
    expect(decodeLine({ type: "health", ok: true })).toMatchObject({ kind: "health" });
    expect(decodeLine({ type: "health", ok: true, replayEnd: true })).toMatchObject({
      kind: "health",
    });
    // The old `ack` reply the stub used to send is now malformed by the strict schema.
    expect(decodeLine({ type: "health", ok: true, ack: "state" })).toMatchObject({
      kind: "malformed",
    });
  });
});

describe("reachy round 4 — claims that hold in the real runtime", () => {
  function wire() {
    const pi = new CapturingPi();
    const commands = new NoCommands();
    const memory = new NoMemory();
    const store = new NoStore();
    const state: PolicyState = {
      wakeName: "jarvis",
      enrolment: {},
      mute: false,
      nowMs: () => 1,
      lastAcknowledgeAtMs: undefined,
    };
    wireReachyCapability({ pi, commands, memory, store, state, log: () => {} });
    return { pi, commands, store };
  }

  it("reachy_say: the SCHEMA rejects an extra argument (what pi validates before execute)", async () => {
    const { pi } = wire();
    const tool = pi.tools.get("reachy_say");
    expect(tool).toBeDefined();
    // The identical predicate pi's validateToolArguments runs against the tool's
    // parameters schema — an extra `memoryId` never validates, so an extra
    // argument never reaches `execute` in a live pi call.
    expect(Value.Check(tool!.parameters as never, { text: "hi", memoryId: "m1" })).toBe(false);
    expect(Value.Check(tool!.parameters as never, { text: "hi" })).toBe(true);
    // And a DIRECT caller still gets the audited refusal (belt-and-braces).
    const out = await tool!.execute("tc", { text: "hi", memoryId: "m1" });
    expect(out.content[0]!.text).toContain("refused");
  });

  it("reachy_state is LABELLED a placeholder in the manifest (no request/response correlation yet)", () => {
    expect(PLACEHOLDER_TOOLS).toContain("reachy_state");
    expect(reachyManifest.provides?.placeholderTools).toContain("reachy_state");
    expect(reachyManifest.provides?.tools).toContain("reachy_state");
  });

  it("reachy_state sends a `state` command and returns the (no-correlation) reply", async () => {
    const { pi, commands } = wire();
    const out = await pi.tools.get("reachy_state")!.execute("tc", {});
    expect(commands.sent.map((s) => s.command)).toContain("state");
    expect(out.content[0]!.text).toBe("{}"); // null today → {}; placeholder, documented
  });
});
