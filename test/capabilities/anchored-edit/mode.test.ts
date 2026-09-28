// An edit must keep the target file's permission bits (the capability promises that
// only the affected byte span changes).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const modeOf = (name: string): number => statSync(join(h.root, name)).mode & 0o777;
const fp = (name: string): string => `F#${fingerprintOf(readFileSync(join(h.root, name)))}`;

describe("anchored-edit keeps permission bits", () => {
  for (const mode of [0o755, 0o644, 0o600]) {
    it(`edit_lines and insert_after keep mode ${mode.toString(8)}`, async () => {
      writeFileSync(join(h.root, "f.sh"), "echo one\necho two\n");
      chmodSync(join(h.root, "f.sh"), mode);
      const edited = await h.call("edit_lines", {
        path: "f.sh",
        from: h.anchor("f.sh", 2),
        to: h.anchor("f.sh", 2),
        new_text: "echo TWO",
        fingerprint: fp("f.sh"),
      });
      expect(edited.text).not.toMatch(/REFUSED/);
      expect(modeOf("f.sh")).toBe(mode);
      const inserted = await h.call("insert_after", {
        path: "f.sh",
        anchor: h.anchor("f.sh", 2),
        text: "echo three",
        fingerprint: fp("f.sh"),
      });
      expect(inserted.text).not.toMatch(/REFUSED/);
      expect(modeOf("f.sh")).toBe(mode);
      expect(readFileSync(join(h.root, "f.sh"), "utf8")).toBe("echo one\necho TWO\necho three\n");
    });
  }
});
