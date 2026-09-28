// Rules tests: paths (containment, symlinks), the rewrite tripwire, write_file
// creation, fingerprints and the structured signals (bob#185 slice 1).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
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
      expect(out.text).toMatch(/symlink|outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a symlink inside the root and preserves its directory entry", async () => {
    write("real.txt", "hello\nworld\n");
    symlinkSync("real.txt", join(h.root, "in-link"));
    const out = await h.call("read_lines", { path: "in-link" });
    expect(out.text).toContain("hello");
    // Editing through the link writes to the target, and the link stays a link.
    await h.call("edit_lines", {
      path: "in-link",
      from: 2,
      to: 2,
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
});

describe("anchored-edit — fingerprints and signals", () => {
  it("refuses a stale fingerprint and names both", async () => {
    write("a.txt", "one\ntwo\n");
    const out = await h.call("edit_lines", {
      path: "a.txt",
      from: 1,
      to: 1,
      new_text: "ONE",
      fingerprint: "F#0000000000000000",
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.text).toContain("0000000000000000");
    expect(out.text).toContain(fingerprintOf(readFileSync(join(h.root, "a.txt"))));
    expect(out.details.signals).toContain("stale_anchor");
    expect(read("a.txt")).toBe("one\ntwo\n");
  });

  it("records edit_without_read when a mutating call had no prior read", async () => {
    write("b.txt", "one\ntwo\n");
    const out = await h.call("edit_lines", {
      path: "b.txt",
      from: 1,
      to: 1,
      new_text: "ONE",
      fingerprint: fp("b.txt"),
    });
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
    expect(out.text).toContain("L2#"); // the observed token
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
    const out = await h.call("edit_lines", {
      path: "small.txt",
      from: 1,
      to: 3,
      new_text: "a\nb\nc",
      fingerprint: fp("small.txt"),
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.details.signals).toContain("budget_stop");
    expect(out.text).toMatch(/BLOCKED/);
    expect(read("small.txt")).toBe("x\ny\nz\n"); // unchanged
  });

  it("refuses every further mutation once a file has tripped", async () => {
    write("t.txt", "x\ny\nz\n"); // 6 bytes -> limit 3
    await h.call("edit_lines", {
      path: "t.txt",
      from: 1,
      to: 3,
      new_text: "a\nb\nc",
      fingerprint: fp("t.txt"),
    });
    // A now-legal single-line edit is still refused (the trip is sticky).
    const out = await h.call("edit_lines", {
      path: "t.txt",
      from: 1,
      to: 1,
      new_text: "Q",
      fingerprint: fp("t.txt"),
    });
    expect(out.text).toMatch(/REFUSED/);
    expect(out.details.signals).toContain("budget_stop");
  });

  it("is cumulative: many small edits cannot get under the limit", async () => {
    write("cum.txt", "a\nb\nc\nd\n"); // 8 bytes -> limit 4
    await h.call("edit_lines", {
      path: "cum.txt",
      from: 1,
      to: 1,
      new_text: "A",
      fingerprint: fp("cum.txt"),
    });
    await h.call("edit_lines", {
      path: "cum.txt",
      from: 2,
      to: 2,
      new_text: "B",
      fingerprint: fp("cum.txt"),
    });
    // 4 bytes removed so far; a third would exceed.
    const out = await h.call("edit_lines", {
      path: "cum.txt",
      from: 3,
      to: 3,
      new_text: "C",
      fingerprint: fp("cum.txt"),
    });
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
    // The inserted text is far larger than the limit, but an insertion removes
    // nothing, so it is allowed.
    expect(out.text).toMatch(/ok/);
    expect(out.details.signals).toEqual([]);
    expect(read("ins.txt")).toBe("x\ny\nz\nq\nr\ns\na\nb\n");
  });
});
