// reachy S3 — round 10: the tool parameter schemas ARE the action schemas.
//
// pi advertises a tool's `parameters` to the model, so a tool schema that is
// LOOSER than what the runtime accepts makes the model propose inputs the
// runtime then rejects as malformed (a string/oversized yaw on `reachy_look`; a
// multi-line or 501-char text on `reachy_say`). The fix is one definition: the
// registered `parameters` object IS `ACTION_ARG_SCHEMAS.look` / `.say`, and the
// runtime validation (admitAndRun) is unchanged. These tests read the schema
// object the tool REGISTERS — not a copy — and validate against it with TypeBox's
// Value.Check, so a re-loosened registration turns them red.
import { describe, expect, it } from "bun:test";
import { Value } from "typebox/value";
import { type PiLike, wireReachyCapability } from "../../../src/capabilities/reachy/capability.js";
import { ACTION_ARG_SCHEMAS } from "../../../src/capabilities/reachy/policy.js";

type RegisteredTool = Parameters<PiLike["registerTool"]>[0];

/** A pi that records exactly what each tool registers (name + parameters). */
class ToolRecorder implements PiLike {
  readonly tools = new Map<string, RegisteredTool>();
  registerTool(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }
}

function wire() {
  const pi = new ToolRecorder();
  wireReachyCapability({
    pi,
    commands: { send: async () => null },
    memory: { writePrivate: async () => ({ id: "mem-1" }) },
    store: { write: async () => ({ id: "e" }), getById: async () => null },
    state: { wakeName: "jarvis", enrolment: {}, mute: false, nowMs: () => 1 },
    log: () => {},
  });
  return pi;
}

describe("reachy round 10: the registered tool schemas equal the action schemas", () => {
  it("reachy_look's parameters ARE ACTION_ARG_SCHEMAS.look and reject an unbounded yaw", () => {
    const pi = wire();
    const look = pi.tools.get("reachy_look")!;
    // The registered object is the SAME definition the runtime validates against.
    expect(look.parameters).toBe(ACTION_ARG_SCHEMAS.look); // assertion: one definition
    // The advertised bounds are the runtime bounds: yaw 1e100 is rejected.
    expect(Value.Check(look.parameters, { yaw: 1e100, pitch: 0 })).toBe(false); // assertion: bounded
    expect(Value.Check(look.parameters, { yaw: 180, pitch: -90 })).toBe(true); // assertion: in range ok
  });

  it("reachy_say's parameters ARE ACTION_ARG_SCHEMAS.say and reject a newline, a 501-char line, and an extra arg", () => {
    const pi = wire();
    const say = pi.tools.get("reachy_say")!;
    expect(say.parameters).toBe(ACTION_ARG_SCHEMAS.say); // assertion: one definition
    expect(Value.Check(say.parameters, { text: "hello\nworld" })).toBe(false); // assertion: one line
    expect(Value.Check(say.parameters, { text: "x".repeat(501) })).toBe(false); // assertion: <=500
    expect(Value.Check(say.parameters, { text: "x".repeat(500) })).toBe(true); // assertion: 500 ok
    // additionalProperties:false still rejects a memory reference.
    expect(Value.Check(say.parameters, { text: "hi", memoryId: "mem-1" })).toBe(false); // assertion: extra arg
  });
});
