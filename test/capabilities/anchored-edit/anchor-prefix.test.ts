// bob#223: a model that copies read_lines output into new text keeps the
// `L<n>#<8 hex> ` prefixes. edit_lines / insert_after / write_file refuse text
// in which any line starts with that rendered shape, naming the first offending
// line; an explicit per-call flag turns the guard off for a file whose real
// content genuinely begins lines with the shape.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANCHOR_PREFIX_RE } from "../../../src/capabilities/anchored-edit/core.js";
import { type Harness, makeHarness } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

// The anchored line section of a read_lines result: exactly what a model copies
// back (each line rendered as `L<n>#<8 hex> <text>`). Derived from the renderer
// via the shared prefix regex, not a hand-typed copy.
function prefixedLines(readText: string): string {
  return readText
    .split("\n")
    .filter((l) => ANCHOR_PREFIX_RE.test(l))
    .join("\n");
}

// The same lines with the prefixes stripped — the corrected new text.
function strippedLines(readText: string): string {
  return prefixedLines(readText)
    .split("\n")
    .map((l) => l.replace(ANCHOR_PREFIX_RE, ""))
    .join("\n");
}

describe("anchored-edit — read_lines prefixes in new text are refused (bob#223)", () => {
  it("edit_lines refuses new_text copied from read_lines and writes NOTHING", async () => {
    writeFileSync(join(h.root, "a.txt"), "one\ntwo\nthree\n");
    const read = await h.call("read_lines", { path: "a.txt" });
    const fp = String(read.details.fingerprint).replace(/^F#/, "");
    const before = readFileSync(join(h.root, "a.txt"), "utf8");
    const out = await h.call("edit_lines", {
      path: "a.txt",
      from: h.anchor("a.txt", 1),
      to: h.anchor("a.txt", 1),
      new_text: prefixedLines(read.text),
      fingerprint: fp,
    });
    expect(out.details.refused).toBe(true);
    expect(out.text).toContain(
      'refusing edit_lines on "a.txt": line 1 of the new text starts with a read_lines anchor prefix',
    );
    expect(readFileSync(join(h.root, "a.txt"), "utf8")).toBe(before);
  });

  it("insert_after refuses text copied from read_lines and writes NOTHING", async () => {
    writeFileSync(join(h.root, "b.txt"), "alpha\nbeta\n");
    const read = await h.call("read_lines", { path: "b.txt" });
    const fp = String(read.details.fingerprint).replace(/^F#/, "");
    const before = readFileSync(join(h.root, "b.txt"), "utf8");
    const out = await h.call("insert_after", {
      path: "b.txt",
      anchor: h.anchor("b.txt", 2),
      text: prefixedLines(read.text),
      fingerprint: fp,
    });
    expect(out.details.refused).toBe(true);
    expect(out.text).toContain(
      'refusing insert_after on "b.txt": line 1 of the new text starts with a read_lines anchor prefix',
    );
    expect(readFileSync(join(h.root, "b.txt"), "utf8")).toBe(before);
  });

  it("write_file refuses content copied from read_lines and creates NOTHING", async () => {
    writeFileSync(join(h.root, "c.txt"), "x\ny\n");
    const read = await h.call("read_lines", { path: "c.txt" });
    const out = await h.call("write_file", { path: "new.txt", content: prefixedLines(read.text) });
    expect(out.details.refused).toBe(true);
    expect(out.text).toContain(
      'refusing write_file on "new.txt": line 1 of the new text starts with a read_lines anchor prefix',
    );
    expect(existsSync(join(h.root, "new.txt"))).toBe(false);
  });

  it("the SAME text with the prefixes stripped is written (all three tools)", async () => {
    writeFileSync(join(h.root, "d.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const read = await h.call("read_lines", { path: "d.txt" });
    const fp = String(read.details.fingerprint).replace(/^F#/, "");
    // Lines 1-2, prefixes stripped (small against the 5-line file, so the
    // rewrite tripwire is not in play).
    const clean = strippedLines(read.text).split("\n").slice(0, 2).join("\n");
    expect(clean).toBe("one\ntwo");

    await h.call("edit_lines", {
      path: "d.txt",
      from: h.anchor("d.txt", 1),
      to: h.anchor("d.txt", 2),
      new_text: clean,
      fingerprint: fp,
    });
    expect(readFileSync(join(h.root, "d.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\nfive\n");

    const fp2 = String((await h.call("read_lines", { path: "d.txt" })).details.fingerprint).replace(
      /^F#/,
      "",
    );
    await h.call("insert_after", {
      path: "d.txt",
      anchor: h.anchor("d.txt", 5),
      text: "six",
      fingerprint: fp2,
    });
    expect(readFileSync(join(h.root, "d.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\nfive\nsix\n");

    await h.call("write_file", { path: "clean.txt", content: clean });
    expect(readFileSync(join(h.root, "clean.txt"), "utf8")).toBe("one\ntwo");
  });

  it("allow_anchor_prefixes: true turns the guard off for the call", async () => {
    writeFileSync(join(h.root, "e.txt"), "one\ntwo\nthree\n");
    const read = await h.call("read_lines", { path: "e.txt" });
    const fp = String(read.details.fingerprint).replace(/^F#/, "");
    const prefixed = prefixedLines(read.text);
    await h.call("edit_lines", {
      path: "e.txt",
      from: h.anchor("e.txt", 1),
      to: h.anchor("e.txt", 1),
      new_text: prefixed,
      fingerprint: fp,
      allow_anchor_prefixes: true,
    });
    expect(readFileSync(join(h.root, "e.txt"), "utf8")).toBe(`${prefixed}\ntwo\nthree\n`);
  });

  it("names the FIRST offending line, not the last", async () => {
    writeFileSync(join(h.root, "f.txt"), "a\nb\nc\nd\ne\n");
    const read = await h.call("read_lines", { path: "f.txt" });
    const fp = String(read.details.fingerprint).replace(/^F#/, "");
    const lines = prefixedLines(read.text).split("\n");
    // Clean first line, a clean literal, then a prefixed third: name line 3.
    const mixed = [lines[0].replace(ANCHOR_PREFIX_RE, ""), "clean", lines[2]].join("\n");
    const out = await h.call("edit_lines", {
      path: "f.txt",
      from: h.anchor("f.txt", 1),
      to: h.anchor("f.txt", 1),
      new_text: mixed,
      fingerprint: fp,
    });
    expect(out.details.refused).toBe(true);
    expect(out.text).toContain("line 3 of the new text starts with a read_lines anchor prefix");
  });
});
