// Containment tests (bob#185 slice 1, round 2, blocker 2): the trusted root is
// pinned once per session, and I/O is bound to the verified target, so a
// directory (or the root) replaced AFTER a call resolves its path but BEFORE it
// takes the per-file lock is caught rather than followed.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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

describe("anchored-edit — containment", () => {
  it("refuses a call whose parent DIRECTORY was replaced after resolution", async () => {
    // root/sub/f.txt, resolved and dispatched...
    mkdirSync(join(h.root, "sub"));
    writeFileSync(join(h.root, "sub", "f.txt"), "one\ntwo\n");
    const fp = `F#${fingerprintOf(readFileSync(join(h.root, "sub", "f.txt")))}`;
    const from = h.anchor("sub/f.txt", 2);
    const to = h.anchor("sub/f.txt", 2);
    // A stand-in directory OUTSIDE the root, holding a file of the same name.
    const outside = mkdtempSync(join(tmpdir(), "bob-outside-dir-"));
    writeFileSync(join(outside, "f.txt"), "SECRET\n");
    try {
      // Dispatch the edit, then replace `sub` with a symlink to `outside`
      // BEFORE the lock runs.
      const pending = h.call("edit_lines", {
        path: "sub/f.txt",
        from,
        to,
        new_text: "X",
        fingerprint: fp,
      });
      renameSync(join(h.root, "sub"), join(h.root, "sub-moved"));
      symlinkSync(outside, join(h.root, "sub"));
      const res = await pending;
      // The call is refused, and the outside file is untouched.
      expect(res.text).toMatch(/REFUSED/);
      expect(res.text).toMatch(/replaced|outside/);
      expect(readFileSync(join(outside, "f.txt"), "utf8")).toBe("SECRET\n");
      // The moved-away original is untouched too.
      expect(readFileSync(join(h.root, "sub-moved", "f.txt"), "utf8")).toBe("one\ntwo\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("pins the trusted root ONCE: a replaced root symlink does not redefine it", async () => {
    // base/link -> base/a ; base/b is a different directory.
    const base = mkdtempSync(join(tmpdir(), "bob-roothost-"));
    const a = join(base, "a");
    const b = join(base, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "x.txt"), "from-A\n");
    writeFileSync(join(b, "x.txt"), "from-B\n");
    const link = join(base, "link");
    symlinkSync(a, link);
    try {
      // First call through the symlinked root pins the canonical root (a).
      const first = await h.call("read_lines", { path: "x.txt" }, link);
      expect(first.text).toContain("from-A");
      // Re-point the root symlink at b.
      rmSync(link);
      symlinkSync(b, link);
      // The session must STILL operate in the pinned root (a), not b.
      const second = await h.call("read_lines", { path: "x.txt" }, link);
      expect(second.text).toContain("from-A");
      expect(second.text).not.toContain("from-B");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
