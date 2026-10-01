// edit-tolerance.test.ts — bob#143 item 1. The pure matcher behind the tolerant
// `edit`: exact match first, then a whitespace-run-normalised match accepted
// only when it is unique. Zero and two-plus normalised matches fail, naming the
// count.
import { describe, expect, it } from "bun:test";
import { EditMatchError, locateTolerantEdits } from "../../src/shell/edit-tolerance.js";

const align = (n: number): string => " ".repeat(n);

describe("locateTolerantEdits — exact first", () => {
  it("keeps an exact, unique match as-is", () => {
    const content = "alpha\nbeta\ngamma\n";
    const { edits, normalizedCount } = locateTolerantEdits(
      content,
      [{ oldText: "beta", newText: "BETA" }],
      "f.ts",
    );
    expect(normalizedCount).toBe(0);
    expect(edits[0].kind).toBe("exact");
    expect(edits[0].oldText).toBe("beta");
    expect(content.slice(edits[0].index, edits[0].index + edits[0].length)).toBe("beta");
  });
});

describe("locateTolerantEdits — whitespace-run normalisation", () => {
  it("matches oldText whose runs of spaces differ from the file", () => {
    // The file aligns the bullet with many spaces; the model wrote one.
    const content = `- one\n-${align(20)}two\n- three\n`;
    const oldText = "- two";
    const { edits, normalizedCount } = locateTolerantEdits(
      content,
      [{ oldText, newText: "- TWO" }],
      "f.md",
    );
    expect(normalizedCount).toBe(1);
    expect(edits[0].kind).toBe("whitespace");
    // The resolved oldText is the FILE's exact substring (the aligned run).
    expect(edits[0].oldText).toBe(`-${align(20)}two`);
    expect(content.slice(edits[0].index, edits[0].index + edits[0].length)).toBe(
      `-${align(20)}two`,
    );
  });

  it("ignores trailing whitespace on either side", () => {
    const content = "value = 1;\nother\n";
    // The oldText carries a trailing space the file does not have.
    const { edits, normalizedCount } = locateTolerantEdits(
      content,
      [{ oldText: "value = 1; ", newText: "value = 2;" }],
      "f.ts",
    );
    expect(normalizedCount).toBe(1);
    expect(edits[0].kind).toBe("whitespace");
    expect(content.slice(edits[0].index, edits[0].index + edits[0].length)).toBe("value = 1;");
  });

  it("resolves several edits, each against the original content", () => {
    const content = `a${align(3)}b\nc${align(3)}d\n`;
    const { edits, normalizedCount } = locateTolerantEdits(
      content,
      [
        { oldText: "a b", newText: "a b" },
        { oldText: "c d", newText: "c d" },
      ],
      "f.ts",
    );
    expect(normalizedCount).toBe(2);
    expect(edits.map((e) => e.oldText)).toEqual([`a${align(3)}b`, `c${align(3)}d`]);
  });
});

describe("locateTolerantEdits — refusals", () => {
  it("fails with count 0 when nothing matches, even normalised", () => {
    const content = "alpha\nbeta\n";
    try {
      locateTolerantEdits(content, [{ oldText: "gamma", newText: "x" }], "f.ts");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(EditMatchError);
      expect((err as EditMatchError).count).toBe(0);
      expect((err as Error).message).toContain("0 matches");
    }
  });

  it("fails when the normalised match is not unique, naming the count", () => {
    // Two lines collapse to the same canonical form.
    const content = `x${align(2)}y\nx${align(5)}y\n`;
    try {
      locateTolerantEdits(content, [{ oldText: "x y", newText: "X Y" }], "f.ts");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(EditMatchError);
      expect((err as EditMatchError).count).toBe(2);
      expect((err as Error).message).toContain("Found 2 occurrences");
    }
  });

  it("fails on an exact duplicate, as before", () => {
    const content = "dup\ndup\n";
    try {
      locateTolerantEdits(content, [{ oldText: "dup", newText: "x" }], "f.ts");
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as EditMatchError).count).toBe(2);
    }
  });

  it("fails on an empty oldText", () => {
    expect(() => locateTolerantEdits("abc", [{ oldText: "", newText: "x" }], "f.ts")).toThrow(
      /must not be empty/,
    );
  });

  it("fails on overlapping edits", () => {
    const content = "abcdef\n";
    expect(() =>
      locateTolerantEdits(
        content,
        [
          { oldText: "abc", newText: "x" },
          { oldText: "bcd", newText: "y" },
        ],
        "f.ts",
      ),
    ).toThrow(/overlap/);
  });
});
