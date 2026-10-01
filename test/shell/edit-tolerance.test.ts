// edit-tolerance.test.ts — bob#143 item 1. The pure matcher behind the tolerant
// `edit`. The exact pass runs first: an oldText at one exact position is
// selected by the matcher (pi may still refuse it), and one at more than one
// exact position fails with that count. Only
// when it occurs nowhere exactly does the whitespace-run-normalised pass run,
// accepting only one normalised position. Counts include overlapping
// occurrences.
import { describe, expect, it } from "bun:test";
import {
  EditMatchError,
  locateTolerantEdits,
  refuseAmbiguousOldTextBeforePiMatch,
} from "../../src/shell/edit-tolerance.js";

const align = (n: number): string => " ".repeat(n);

describe("locateTolerantEdits — exact first", () => {
  it("keeps an oldText at one exact position as-is", () => {
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

  it("fails for an oldText at no exact position and two normalised positions, naming the count", () => {
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

  it("reports an exact duplicate's EXACT count, not the normalised one", () => {
    // Two exact matches, plus a third that matches only after normalising.
    const content = "x y\nx y\nx   y\n";
    try {
      locateTolerantEdits(content, [{ oldText: "x y", newText: "X Y" }], "f.ts");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(EditMatchError);
      expect((err as EditMatchError).count).toBe(2);
      expect((err as Error).message).toBe(
        "oldText matches 2 places exactly in f.ts (overlapping occurrences included). It must match at one place only; add surrounding context.",
      );
    }
    // With several edits, the message names the edit.
    expect(() =>
      locateTolerantEdits(
        content,
        [
          { oldText: "x   y", newText: "X Y" },
          { oldText: "x y", newText: "X Y" },
        ],
        "f.ts",
      ),
    ).toThrow(/^edits\[1\]\.oldText matches 2 places exactly in f\.ts \(overlapping/);
  });

  it("refuses an oldText at no exact position and two overlapping normalised positions", () => {
    // Canonically "a a a": "a a" occurs at positions 0 and 2, which overlap.
    try {
      locateTolerantEdits("a  a   a", [{ oldText: "a a", newText: "X" }], "f.ts");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(EditMatchError);
      expect((err as EditMatchError).count).toBe(2);
      expect((err as Error).message).toMatch(
        /^Found 2 occurrences of the text in f\.ts after normalising/,
      );
    }
  });

  it("refuses an exact oldText at two overlapping positions", () => {
    try {
      locateTolerantEdits("aaa", [{ oldText: "aa", newText: "X" }], "f.ts");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(EditMatchError);
      expect((err as EditMatchError).count).toBe(2);
      expect((err as Error).message).toMatch(
        /^oldText matches 2 places exactly in f\.ts \(overlapping/,
      );
    }
  });

  it("still accepts one exact position, or one normalised position when none is exact", () => {
    const exact = locateTolerantEdits("aab", [{ oldText: "ab", newText: "X" }], "f.ts");
    expect(exact.edits[0]).toMatchObject({ kind: "exact", index: 1, length: 2 });
    const normalised = locateTolerantEdits("a  b a", [{ oldText: "a b", newText: "X" }], "f.ts");
    expect(normalised.edits[0]).toMatchObject({ kind: "whitespace", oldText: "a  b", index: 0 });
  });

  it("exact-first rule: one exact position is selected though normalising would find two", () => {
    // "a a" occurs exactly once (line 1) and twice after normalising (lines 1
    // and 2). The exact pass runs first and wins; the normalised pass never runs.
    const content = "a a\na  a\n";
    const { edits, normalizedCount } = locateTolerantEdits(
      content,
      [{ oldText: "a a", newText: "X" }],
      "f.ts",
    );
    expect(normalizedCount).toBe(0);
    expect(edits).toEqual([
      { editIndex: 0, oldText: "a a", newText: "X", index: 0, length: 3, kind: "exact" },
    ]);
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

describe("refuseAmbiguousOldTextBeforePiMatch — the check before pi matches", () => {
  it("refuses an oldText at more than one exact position, overlaps included", () => {
    expect(() =>
      refuseAmbiguousOldTextBeforePiMatch("aaa", [{ oldText: "aa", newText: "x" }], "f.ts"),
    ).toThrow(/^oldText matches 2 places exactly in f\.ts \(overlapping/);
    expect(() =>
      refuseAmbiguousOldTextBeforePiMatch(
        "abab",
        [
          { oldText: "a", newText: "x" },
          { oldText: "b", newText: "y" },
        ],
        "f.ts",
      ),
    ).toThrow(/^edits\[0\]\.oldText matches 2 places exactly in f\.ts \(overlapping/);
  });

  it("matches in pi's text: a leading BOM dropped, CRLF and CR read as LF", () => {
    expect(() =>
      refuseAmbiguousOldTextBeforePiMatch(
        "\uFEFFx\r\nx\r",
        [{ oldText: "x\n", newText: "y" }],
        "f.ts",
      ),
    ).toThrow(/matches 2 places exactly/);
  });

  it("passes an oldText at one position, at none, or not a string", () => {
    expect(() =>
      refuseAmbiguousOldTextBeforePiMatch(
        "aab",
        [{ oldText: "ab", newText: "x" }, { oldText: "zz", newText: "y" }, { oldText: 3 }],
        "f.ts",
      ),
    ).not.toThrow();
    expect(() => refuseAmbiguousOldTextBeforePiMatch("aab", undefined, "f.ts")).not.toThrow();
  });
});
