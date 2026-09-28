// Short-write tests (bob#185 slice 1, round 3, blocker 5): a writer that accepts
// FEWER bytes than requested must be looped until every byte is accepted, and an
// incomplete write must be cleaned up and refused rather than reported as a
// success with a fingerprint for bytes that never landed.
//
// The writer seam is injected through the harness. On the pre-fix behaviour
// (a single `writeSync` whose count is ignored) the one-byte writer truncates
// the file and the incomplete-write cases report success — both tests fail.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
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

const fpIn = (root: string, name: string): string =>
  `F#${fingerprintOf(readFileSync(join(root, name)))}`;

describe("anchored-edit — short writes are looped to completion", () => {
  it("a one-byte-at-a-time writer still lands every byte of an edit", async () => {
    let calls = 0;
    const short = makeHarness({
      writeChunk: (fd, data) => {
        calls += 1;
        const n = Math.min(1, data.length); // accept at most one byte per call
        return writeSync(fd, data.subarray(0, n));
      },
    });
    try {
      writeFileSync(join(short.root, "f.txt"), "one\ntwo\n");
      const out = await short.call("edit_lines", {
        path: "f.txt",
        from: short.anchor("f.txt", 2),
        to: short.anchor("f.txt", 2),
        new_text: "TWO",
        fingerprint: fpIn(short.root, "f.txt"),
      });
      expect(out.text).toMatch(/ok/);
      expect(readFileSync(join(short.root, "f.txt"), "utf8")).toBe("one\nTWO\n");
      expect(calls).toBeGreaterThan(1); // it really did loop
    } finally {
      short.cleanup();
    }
  });
});

describe("anchored-edit — an incomplete write is cleaned up and refused", () => {
  it("refuses an edit whose writer accepts no bytes, leaving the file unchanged", async () => {
    const stuck = makeHarness({ writeChunk: () => 0 });
    try {
      writeFileSync(join(stuck.root, "f.txt"), "one\ntwo\n");
      const out = await stuck.call("edit_lines", {
        path: "f.txt",
        from: stuck.anchor("f.txt", 2),
        to: stuck.anchor("f.txt", 2),
        new_text: "TWO",
        fingerprint: fpIn(stuck.root, "f.txt"),
      });
      expect(out.text).toMatch(/REFUSED/);
      expect(readFileSync(join(stuck.root, "f.txt"), "utf8")).toBe("one\ntwo\n");
      // No half-written temporary file left behind.
      expect(readdirSync(stuck.root).some((n) => n.includes(".anchored-edit."))).toBe(false);
    } finally {
      stuck.cleanup();
    }
  });

  it("refuses a creation whose writer accepts no bytes, leaving no file behind", async () => {
    const stuck = makeHarness({ writeChunk: () => 0 });
    try {
      const out = await stuck.call("write_file", { path: "new.txt", content: "hi\n" });
      expect(out.text).toMatch(/REFUSED/);
      expect(existsSync(join(stuck.root, "new.txt"))).toBe(false);
    } finally {
      stuck.cleanup();
    }
  });
});
