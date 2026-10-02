// tool-loop.test.ts — bob#143 item 3. The pure detector behind the loop breaker:
// consecutive identical calls only, reset by any different call, firing at the
// limit and not before; and the call key for arguments parsed from JSON, which
// ignores object-key order, keeps array order and counts a `__proto__` key.
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

  it("keeps an own __proto__ key: arguments parsed from JSON that differ only there differ", () => {
    // JSON.parse makes `__proto__` an OWN key, as pi's parsed tool arguments do.
    const one = JSON.parse('{"path":"f.ts","__proto__":{"x":1}}');
    const two = JSON.parse('{"path":"f.ts","__proto__":{"x":2}}');
    expect(Object.keys(one)).toEqual(["path", "__proto__"]);
    expect(toolCallKey("edit", one)).not.toBe(toolCallKey("edit", two));
    expect(toolCallKey("edit", one)).toBe(
      toolCallKey("edit", JSON.parse('{"__proto__":{"x":1},"path":"f.ts"}')),
    );
    // A scalar __proto__ value, and one nested inside another object.
    expect(toolCallKey("edit", JSON.parse('{"__proto__":1}'))).not.toBe(
      toolCallKey("edit", JSON.parse('{"__proto__":2}')),
    );
    expect(toolCallKey("edit", JSON.parse('{"o":{"__proto__":1}}'))).not.toBe(
      toolCallKey("edit", JSON.parse('{"o":{"__proto__":2}}')),
    );
    // Present versus absent.
    expect(toolCallKey("edit", JSON.parse('{"a":1,"__proto__":null}'))).not.toBe(
      toolCallKey("edit", JSON.parse('{"a":1}')),
    );
  });

  it("nested objects: key order is ignored at every depth, array order is not", () => {
    const a = JSON.parse(
      '{"edits":[{"oldText":"x","newText":"y"}],"opts":{"b":1,"a":{"d":2,"c":3}}}',
    );
    const b = JSON.parse(
      '{"opts":{"a":{"c":3,"d":2},"b":1},"edits":[{"newText":"y","oldText":"x"}]}',
    );
    expect(toolCallKey("edit", a)).toBe(toolCallKey("edit", b));
    const swapped = JSON.parse('{"edits":[{"oldText":"p"},{"oldText":"q"}]}');
    const original = JSON.parse('{"edits":[{"oldText":"q"},{"oldText":"p"}]}');
    expect(toolCallKey("edit", swapped)).not.toBe(toolCallKey("edit", original));
    expect(toolCallKey("edit", { o: { a: { b: 1 } } })).not.toBe(
      toolCallKey("edit", { o: { a: { b: 2 } } }),
    );
  });
});

describe("ToolLoopDetector — arguments parsed from JSON", () => {
  it("a different __proto__ value resets the count; the same value repeats", () => {
    const detector = new ToolLoopDetector(2);
    expect(detector.observe("edit", JSON.parse('{"__proto__":{"x":1}}')).count).toBe(1);
    const changed = detector.observe("edit", JSON.parse('{"__proto__":{"x":2}}'));
    expect(changed).toEqual({ count: 1, fire: false });
    const repeated = detector.observe("edit", JSON.parse('{"__proto__":{"x":2}}'));
    expect(repeated).toEqual({ count: 2, fire: true });
  });
});
