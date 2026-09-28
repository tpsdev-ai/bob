// Output-cap tests (bob#185 slice 1, round 2, blocker 5): every result is bounded
// by UTF-8 bytes, the cut marker is inside the cap, and the structured anchor
// list is bounded with a re-read instruction.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_OUTPUT_BYTES } from "../../../src/capabilities/anchored-edit/core.js";
import { type Harness, makeHarness } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

describe("anchored-edit — output cap", () => {
  it("a read rendering never exceeds the byte cap, marker included", async () => {
    // Enough long-ish lines that a naive render would overflow.
    const line = "a".repeat(80);
    const content = `${Array.from({ length: 300 }, () => line).join("\n")}\n`;
    writeFileSync(join(h.root, "big.txt"), content);
    const out = await h.call("read_lines", { path: "big.txt" });
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(out.text).toMatch(/page cut/); // it says it was cut
  });

  it("bounds the structured anchors and says how many were omitted", async () => {
    writeFileSync(join(h.root, "ins.txt"), "a\nb\n");
    await h.call("read_lines", { path: "ins.txt" });
    const fp = `F#${(await h.call("read_lines", { path: "ins.txt" })).details.fingerprint?.toString().replace(/^F#/, "")}`;
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const res = await h.call("insert_after", {
      path: "ins.txt",
      anchor: "L0",
      text: many,
      fingerprint: fp,
    });
    expect(res.text).toMatch(/ok/);
    expect((res.details.anchors as string[]).length).toBeLessThanOrEqual(64);
    expect(res.details.anchorsOmitted as number).toBeGreaterThan(0);
    expect(res.text).toMatch(/read_lines to re-anchor/);
  });
});
