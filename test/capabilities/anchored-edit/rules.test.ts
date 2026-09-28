// Rules tests: paths (containment, symlinks), the rewrite tripwire, write_file
// creation, fingerprints and the structured signals (bob#185 slice 1).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintOf } from "../../../src/capabilities/anchored-edit/core.js";
import { type Harness, makeHarness } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

const write = (name: string, content: string): string => {
  writeFileSync(join(h.root, name), content);
  return name;
};
const read = (name: string): string => readFileSync(join(h.root, name), "utf8");
const fp = (name: string): string => `F#${fingerprintOf(readFileSync(join(h.root, name)))}`;
const edit = (name: string, from: number, to: number, newText: string) =>
  h.call("edit_lines", {
    path: name,
    from: h.anchor(name, from),
    to: h.anchor(name, to),
    new_text: newText,
    fingerprint: fp(name),
  });

describe("anchored-edit — paths", () => {
  it("refuses an absolute path", async () => {
    const out = await h.call("read_lines", { path: "/etc/hostname" });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toMatch(/absolute/);
    expect(out.details.refused).toBe(true);
  });

  it('refuses a ".." segment', async () => {
    const out = await h.call("read_lines", { path: "../secret" });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toMatch(/\.\./);
  });

  it("refuses a symlink that leads outside the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "bob-outside-"));
    const outsideFile = join(outside, "target.txt");
    writeFileSync(outsideFile, "secret\n");
    symlinkSync(outsideFile, join(h.root, "out-link"));
    try {
      const out = await h.call("read_lines", { path: "out-link" });
      expect(out.text).toMatch(/REFUSED/);
      expect(out.text).toMatch(/outside|symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a symlink inside the root and preserves its directory entry", async () => {
    write("real.txt", "hello\nworld\n");
    symlinkSync("real.txt", join(h.root, "in-link"));
    const out = await h.call("read_lines", { path: "in-link" });
    expect(out.text).toContain("hello");
    await h.call("edit_lines", {
      path: "in-link",
      from: h.anchor("real.txt", 2),
      to: h.anchor("real.txt", 2),
      new_text: "WORLD",
      fingerprint: fp("real.txt"),
    });
    expect(read("real.txt")).toBe("hello\nWORLD\n");
    expect(lstatSync(join(h.root, "in-link")).isSymbolicLink()).toBe(true);
  });
});

describe("anchored-edit — write_file (create only)", () => {
  it("creates a new file", async () => {
    const out = await h.call("write_file", { path: "new.txt", content: "hi\n" });
    expect(out.text).toMatch(/created/);
    expect(read("new.txt")).toBe("hi\n");
  });

  it("refuses to overwrite an existing file", async () => {
    write("exists.txt", "old\n");
    const out = await h.call("write_file", { path: "exists.txt", content: "new\n" });
    expect(out.text).toMatch(/REFUSED/);
    expect(read("exists.txt")).toBe("old\n");
  });

  it("refuses when a directory occupies the path", async () => {
    mkdirSync(join(h.root, "adir"));
    const out = await h.call("write_file", { path: "adir", content: "x" });
    expect(out.text).toMatch(/REFUSED/);
  });

  it("treats a dangling symlink as occupied", async () => {
    symlinkSync("nonexistent-target", join(h.root, "dangling"));
    const out = await h.call("write_file", { path: "dangling", content: "x" });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toMatch(/exists/);
  });

  it("refuses NUL content BEFORE opening, leaving NO file behind", async () => {
    const out = await h.call("write_file", { path: "nul.txt", content: "a\u0000b" });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toMatch(/NUL/);
    expect(existsSync(join(h.root, "nul.txt"))).toBe(false); // never opened
  });
});

describe("anchored-edit — fingerprints and signals", () => {
  it("refuses a stale fingerprint and names expected/observed anchors", async () => {
    write("a.txt", "one\ntwo\n");
    const out = await h.call("edit_lines", {
      path: "a.txt",
      from: h.anchor("a.txt", 1),
      to: h.anchor("a.txt", 1),
      new_text: "ONE",
      fingerprint: "F#0000000000000000",
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toContain("0000000000000000");
    expect(out.text).toContain(fingerprintOf(readFileSync(join(h.root, "a.txt"))));
    expect(out.text).toMatch(/window around line 1/); // the bounded re-read window
    expect(out.details.signals).toContain("stale_anchor");
    expect(read("a.txt")).toBe("one\ntwo\n");
  });

  it("records edit_without_read when a mutating call had no prior read", async () => {
    write("b.txt", "one\ntwo\n");
    const out = await edit("b.txt", 1, 1, "ONE");
    expect(out.details.signals).toContain("edit_without_read");
    expect(read("b.txt")).toBe("ONE\ntwo\n");
  });

  it("records stale_anchor for a mismatched insert anchor", async () => {
    write("c.txt", "one\ntwo\n");
    await h.call("read_lines", { path: "c.txt" });
    const out = await h.call("insert_after", {
      path: "c.txt",
      anchor: "L2#deadbeef",
      text: "x",
      fingerprint: fp("c.txt"),
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.details.signals).toContain("stale_anchor");
    expect(out.text).toContain("L2#");
    expect(out.text).toMatch(/window around line 2/);
  });

  it("refuses a NUL or invalid-UTF-8 file on read", async () => {
    writeFileSync(join(h.root, "bin"), Buffer.from([0x00, 0x01, 0x02]));
    const out = await h.call("read_lines", { path: "bin" });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toMatch(/NUL/);
  });
});

describe("anchored-edit — the rewrite tripwire", () => {
  it("refuses a full replacement of a small existing file (budget_stop)", async () => {
    write("small.txt", "x\ny\nz\n"); // 6 bytes -> limit 3
    const out = await edit("small.txt", 1, 3, "a\nb\nc");
    expect(out.text).toMatch(/REFUSED/);
    expect(out.details.signals).toContain("budget_stop");
    expect(out.text).toMatch(/BLOCKED/);
    expect(read("small.txt")).toBe("x\ny\nz\n");
  });

  it("charges the ADJACENT separator when the final line is deleted", async () => {
    // "a\nb" is 3 bytes -> limit 1. Deleting line 2 removes "b" AND the "\n"
    // separator: 2 bytes, over the limit -> refused. (Charging 1 used to let it
    // through.)
    write("eof.txt", "a\nb");
    const out = await edit("eof.txt", 2, 2, "");
    expect(out.text).toMatch(/REFUSED/);
    expect(out.details.signals).toContain("budget_stop");
    expect(read("eof.txt")).toBe("a\nb"); // unchanged
  });

  it("refuses every further mutation once a file has tripped, BEFORE any other check", async () => {
    write("t.txt", "x\ny\nz\n"); // 6 bytes -> limit 3
    await edit("t.txt", 1, 3, "a\nb\nc"); // trips it
    // A later call with a WRONG fingerprint must answer budget_stop first, not
    // a stale-anchor refusal.
    const out = await h.call("edit_lines", {
      path: "t.txt",
      from: h.anchor("t.txt", 1),
      to: h.anchor("t.txt", 1),
      new_text: "Q",
      fingerprint: "F#0000000000000000",
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.details.signals).toContain("budget_stop");
  });

  it("is cumulative: many small edits cannot get under the limit", async () => {
    write("cum.txt", "a\nb\nc\nd\n"); // 8 bytes -> limit 4
    await edit("cum.txt", 1, 1, "A");
    await edit("cum.txt", 2, 2, "B");
    const out = await edit("cum.txt", 3, 3, "C");
    expect(out.text).toMatch(/REFUSED/);
    expect(out.details.signals).toContain("budget_stop");
  });

  it("does NOT count pure insertions", async () => {
    write("ins.txt", "a\nb\n"); // 4 bytes -> limit 2
    await h.call("read_lines", { path: "ins.txt" });
    const out = await h.call("insert_after", {
      path: "ins.txt",
      anchor: "L0",
      text: "x\ny\nz\nq\nr\ns\n",
      fingerprint: fp("ins.txt"),
    });
    expect(out.text).toMatch(/ok/);
    expect(out.details.signals).toEqual([]);
    expect(read("ins.txt")).toBe("x\ny\nz\nq\nr\ns\na\nb\n");
  });
});

describe("anchored-edit — a tripped budget answers first", () => {
  it("answers budget_stop even when the later read would fail", async () => {
    write("tb.txt", "x\ny\nz\n"); // 6 bytes -> limit 3
    await edit("tb.txt", 1, 3, "a\nb\nc"); // trips the budget
    rmSync(join(h.root, "tb.txt")); // a read would now fail
    const out = await h.call("edit_lines", {
      path: "tb.txt",
      from: "L1#00000000",
      to: "L1#00000000",
      new_text: "Q",
      fingerprint: "F#0000000000000000",
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.details.signals).toContain("budget_stop");
    expect(out.text).toMatch(/BLOCKED/);
  });
});

describe("anchored-edit — every refusal names the caller's path and the rule", () => {
  it("a binary (NUL) read refusal names the path and the rule", async () => {
    writeFileSync(join(h.root, "bin2"), Buffer.from([0x00, 0x01, 0x02]));
    const out = await h.call("read_lines", { path: "bin2" });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toContain("bin2");
    expect(out.text).toMatch(/binary/);
  });

  it("an invalid-UTF-8 read refusal names the path and the rule", async () => {
    writeFileSync(join(h.root, "bad8"), Buffer.from([0xff, 0xfe, 0x41]));
    const out = await h.call("read_lines", { path: "bad8" });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toContain("bad8");
    expect(out.text).toMatch(/UTF-8|binary/);
  });

  it("an out-of-range read refusal names the path and the rule", async () => {
    write("r.txt", "one\n");
    const out = await h.call("read_lines", { path: "r.txt", start: 99 });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toContain("r.txt");
    expect(out.text).toMatch(/out-of-range/);
  });

  it("a lone-CR refusal names the path and the rule", async () => {
    write("cr.txt", "a\nb\n");
    const out = await h.call("edit_lines", {
      path: "cr.txt",
      from: h.anchor("cr.txt", 1),
      to: h.anchor("cr.txt", 1),
      new_text: "x\ry",
      fingerprint: fp("cr.txt"),
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toContain("cr.txt");
    expect(out.text).toMatch(/lone CR/);
  });

  it("an overlong-line refusal names the path and the rule", async () => {
    const long = "x".repeat(2500);
    write("long.txt", `${long}\nshort\n`);
    const out = await h.call("edit_lines", {
      path: "long.txt",
      from: h.anchor("long.txt", 1),
      to: h.anchor("long.txt", 1),
      new_text: "y",
      fingerprint: fp("long.txt"),
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toContain("long.txt");
    expect(out.text).toMatch(/overlong/);
  });
});
