// The byte-exactness fixture matrix (bob#185 slice 1, acceptance gate).
//
// Every case writes a raw file, reads it, edits it, and asserts on the AFFECTED
// BYTE SPAN: the bytes outside the span are unchanged, and the span is exactly
// what the rule says. `edit_lines` names its range with BOTH end anchors
// (L<n>#<h>) plus the fingerprint, so each call computes the anchors from the
// file as it stands.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  anchorToken,
  fingerprintOf,
  splitRawLines,
} from "../../../src/capabilities/anchored-edit/core.js";
import { type Harness, makeHarness } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

const write = (name: string, bytes: Buffer | string): string => {
  writeFileSync(join(h.root, name), bytes);
  return name;
};
const read = (name: string): Buffer => readFileSync(join(h.root, name));
const fpOf = (name: string): string => `F#${fingerprintOf(read(name))}`;
// Edit lines `from`..`to` (1-based) with anchor tokens computed now.
const edit = (name: string, from: number, to: number, newText: string) =>
  h.call("edit_lines", {
    path: name,
    from: h.anchor(name, from),
    to: h.anchor(name, to),
    new_text: newText,
    fingerprint: fpOf(name),
  });

describe("anchored-edit — byte-exactness fixture matrix", () => {
  it("LF file: replaces one line, every other byte unchanged", async () => {
    const p = write("a.txt", "one\ntwo\nthree\n");
    const before = read(p);
    await edit(p, 2, 2, "TWO");
    expect(read(p).toString()).toBe("one\nTWO\nthree\n");
    expect(read(p).subarray(0, 4).equals(before.subarray(0, 4))).toBe(true);
    expect(read(p).subarray(8).equals(before.subarray(8))).toBe(true);
  });

  it("CRLF file: new separators use CRLF (dominant style)", async () => {
    const p = write("b.txt", "one\r\ntwo\r\nthree\r\n");
    await edit(p, 2, 2, "TWO");
    expect(read(p).toString()).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("mixed endings: dominant wins (more CRLF than LF -> CRLF)", async () => {
    const p = write("c.txt", "a\r\nb\r\nc\nd\r\n");
    const out = await h.call("read_lines", { path: p });
    expect(out.text.split("\n")[0]).toContain("eol=crlf");
    await edit(p, 4, 4, "D");
    // Only the affected span is rewritten: line 3 keeps its LF, the new line 4
    // uses the dominant (CRLF).
    expect(read(p).toString()).toBe("a\r\nb\r\nc\nD\r\n");
  });

  it("BOM is preserved across an edit", async () => {
    const p = write("d.txt", Buffer.from("\uFEFFa\nb\n", "utf8"));
    const before = read(p);
    expect(before[0]).toBe(0xef);
    await edit(p, 2, 2, "B");
    const after = read(p);
    expect(after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(after.subarray(3).toString()).toBe("a\nB\n");
    expect(after.subarray(0, 5).equals(before.subarray(0, 5))).toBe(true);
  });

  it("no final newline: the state is kept when the last line is edited", async () => {
    const p = write("e.txt", "a\nb"); // no trailing newline
    await edit(p, 2, 2, "B");
    expect(read(p).toString()).toBe("a\nB"); // still no final newline
  });

  it("removing the final line keeps the old final-newline state", async () => {
    const p = write("f.txt", "a\nb\n"); // has a final newline
    await edit(p, 2, 2, "");
    expect(read(p).toString()).toBe("a\n");
  });

  it("empty lines are addressable and preserved", async () => {
    const p = write("g.txt", "a\n\nb\n");
    const out = await h.call("read_lines", { path: p });
    const lines = out.text.split("\n").filter((l) => l.startsWith("L"));
    expect(lines.length).toBe(3);
    expect(lines[1]).toMatch(/^L2#[0-9a-f]{8} $/);
    await edit(p, 2, 2, "X");
    expect(read(p).toString()).toBe("a\nX\nb\n");
  });

  it("duplicate lines get distinct anchors (the line number is in the token)", async () => {
    const p = write("h.txt", "dup\ndup\n");
    const out = await h.call("read_lines", { path: p });
    const lines = out.text.split("\n").filter((l) => l.startsWith("L"));
    expect(lines[0]).not.toBe(lines[1]);
    expect(lines[0].split("#")[1].split(" ")[0]).toBe(lines[1].split("#")[1].split(" ")[0]);
  });

  it("multibyte UTF-8: the hash covers UTF-8 bytes and the edit preserves them", async () => {
    const p = write("i.txt", "héllo wörld\nsecond\n");
    const out = await h.call("read_lines", { path: p });
    const first = out.text.split("\n").find((l) => l.startsWith("L1#")) as string;
    const expected = anchorToken(1, splitRawLines(Buffer.from("héllo wörld\nsecond\n", "utf8"))[0]);
    expect(first.split(" ")[0]).toBe(expected);
    await edit(p, 2, 2, "zweite");
    expect(read(p).toString()).toBe("héllo wörld\nzweite\n");
  });

  it("over-cap line: shown truncated, hash covers the FULL line, edit refused", async () => {
    const long = "x".repeat(2500);
    const p = write("j.txt", `${long}\nshort\n`);
    const out = await h.call("read_lines", { path: p });
    const l1 = out.text.split("\n").find((l) => l.startsWith("L1#")) as string;
    expect(l1).toContain("truncated");
    const full = anchorToken(1, splitRawLines(Buffer.from(`${long}\nshort\n`, "utf8"))[0]);
    expect(l1.split(" ")[0]).toBe(full);
    const refused = await edit(p, 1, 1, "y");
    expect(refused.text).toMatch(/REFUSED/);
    expect(refused.text).toContain("2000");
    expect(read(p).toString()).toBe(`${long}\nshort\n`);
  });

  it("edit_lines BOTH ends are checked: a wrong 'to' anchor is refused", async () => {
    const p = write("k2.txt", "a\nb\nc\n");
    const res = await h.call("edit_lines", {
      path: p,
      from: h.anchor(p, 1),
      to: "L2#deadbeef", // wrong hash for line 2
      new_text: "X",
      fingerprint: fpOf(p),
    });
    expect(res.text).toMatch(/REFUSED/);
    expect(res.details.signals).toContain("stale_anchor");
    expect(read(p).toString()).toBe("a\nb\nc\n");
  });

  it("insert_after L0 inserts before line 1", async () => {
    const p = write("k.txt", "b\nc\n");
    await h.call("insert_after", { path: p, anchor: "L0", text: "a", fingerprint: fpOf(p) });
    expect(read(p).toString()).toBe("a\nb\nc\n");
  });

  it("insert_after the last line, no final newline: the adjacent separator belongs to the span", async () => {
    const p = write("l.txt", "a\nb"); // no final newline
    const out = await h.call("read_lines", { path: p });
    const anchor = (out.text.split("\n").find((l) => l.startsWith("L2#")) as string).split(" ")[0];
    await h.call("insert_after", { path: p, anchor, text: "c", fingerprint: fpOf(p) });
    expect(read(p).toString()).toBe("a\nb\nc"); // state kept: no final newline
  });

  it("insert_after(L0) on an EMPTY file keeps the absent final newline and anchors every line", async () => {
    const p = write("m.txt", ""); // empty
    const res = await h.call("insert_after", {
      path: p,
      anchor: "L0",
      text: "abc\ndef",
      fingerprint: fpOf(p),
    });
    expect(read(p).toString()).toBe("abc\ndef"); // no trailing newline
    expect((res.details.anchors as string[]).length).toBe(2); // an anchor for EVERY written line
  });
});

describe("anchored-edit — blank final line and EOF blank insert (unrepresentable cases)", () => {
  it("REFUSES a blank final line in a file that keeps no final newline", async () => {
    const p = write("n1.txt", "aaaa\nb"); // 2 lines, no final newline
    const before = read(p);
    const out = await edit(p, 2, 2, "\n"); // one blank line as the new final line
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toMatch(/blank final line/);
    expect(out.text).toContain("n1.txt");
    expect(read(p).equals(before)).toBe(true); // bytes unchanged
  });

  it("REFUSES a blank insert into an EMPTY file (unrepresentable)", async () => {
    const p = write("n2.txt", "");
    const out = await h.call("insert_after", {
      path: p,
      anchor: "L0",
      text: "\n",
      fingerprint: fpOf(p),
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toMatch(/blank final line/);
    expect(out.text).toContain("n2.txt");
    expect(read(p).length).toBe(0); // still empty (zero bytes)
  });

  it("REPRESENTS a blank final line when the file keeps a final newline (bytes, count, delta, anchors)", async () => {
    const p = write("n3.txt", "a\nb\n"); // has a final newline
    const res = await h.call("edit_lines", {
      path: p,
      from: h.anchor(p, 2),
      to: h.anchor(p, 2),
      new_text: "\n",
      fingerprint: fpOf(p),
    });
    expect(res.text).toMatch(/ok/);
    expect(read(p).toString()).toBe("a\n\n"); // blank line 2 represented, final newline kept
    expect(res.details.lineCount as number).toBe(2);
    expect(res.details.lineDelta as number).toBe(0);
    expect((res.details.anchors as string[]).length).toBe(1);
    const re = await h.call("read_lines", { path: p });
    expect(re.details.lineCount as number).toBe(2);
  });
});
