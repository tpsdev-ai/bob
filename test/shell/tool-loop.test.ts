// tool-loop.test.ts — bob#143 item 3. The pure detector behind the loop breaker:
// consecutive identical calls only, reset by any different call, firing at the
// limit and not before.
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_TOOL_LOOP_LIMIT,
  ToolLoopDetector,
  toolCallKey,
} from "../../src/shell/tool-loop.js";

describe("ToolLoopDetector", () => {
  it("defaults to 4 consecutive calls", () => {
    expect(DEFAULT_TOOL_LOOP_LIMIT).toBe(4);
    const detector = new ToolLoopDetector();
    const seen = [1, 2, 3, 4].map(() => detector.observe("edit", { path: "a", edits: [] }));
    expect(seen.map((o) => o.count)).toEqual([1, 2, 3, 4]);
    expect(seen.map((o) => o.fire)).toEqual([false, false, false, true]);
  });

  it("fires at N and not at N-1", () => {
    const detector = new ToolLoopDetector(3);
    expect(detector.observe("edit", { a: 1 }).fire).toBe(false); // 1
    expect(detector.observe("edit", { a: 1 }).fire).toBe(false); // 2
    expect(detector.observe("edit", { a: 1 }).fire).toBe(true); // 3
  });

  it("a different call resets the run", () => {
    const detector = new ToolLoopDetector(3);
    detector.observe("edit", { a: 1 });
    detector.observe("edit", { a: 1 });
    expect(detector.observe("read", { a: 1 }).fire).toBe(false);
    expect(detector.observe("edit", { a: 1 }).count).toBe(1);
    expect(detector.observe("edit", { a: 1 }).fire).toBe(false);
  });

  it("different arguments are a different call", () => {
    const detector = new ToolLoopDetector(2);
    detector.observe("edit", { a: 1 });
    expect(detector.observe("edit", { a: 2 }).fire).toBe(false);
    expect(detector.observe("edit", { a: 2 }).fire).toBe(true);
  });

  it("treats argument key order as the same call", () => {
    const detector = new ToolLoopDetector(2);
    detector.observe("edit", { a: 1, b: 2 });
    expect(detector.observe("edit", { b: 2, a: 1 }).fire).toBe(true);
  });

  it("reset() clears the run", () => {
    const detector = new ToolLoopDetector(2);
    detector.observe("edit", { a: 1 });
    detector.reset();
    expect(detector.observe("edit", { a: 1 }).count).toBe(1);
  });

  it("refuses a non-positive limit", () => {
    expect(() => new ToolLoopDetector(0)).toThrow(/positive whole number/);
    expect(() => new ToolLoopDetector(-1)).toThrow(/positive whole number/);
  });
});

describe("toolCallKey", () => {
  it("is independent of object-key order, not of array order", () => {
    expect(toolCallKey("edit", { a: 1, b: 2 })).toBe(toolCallKey("edit", { b: 2, a: 1 }));
    expect(toolCallKey("edit", { a: [1, 2] })).not.toBe(toolCallKey("edit", { a: [2, 1] }));
    expect(toolCallKey("edit", { a: 1 })).not.toBe(toolCallKey("edit", { a: 2 }));
    expect(toolCallKey("edit", { a: 1 })).not.toBe(toolCallKey("read", { a: 1 }));
  });
});
