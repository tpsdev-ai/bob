// Property test (bob#185 slice 1, acceptance gate): a modification injected
// AFTER read_lines and BEFORE the mutating call takes its per-file critical
// section must yield exactly one of two outcomes — the requested edit is applied
// to the CHECKED version, or the call is refused. Changes after the check are
// the documented cross-process race and are out of scope.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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

const FILE = "prop.txt";
const BASE = "one\ntwo\nthree\n";
const write = (content: string) => writeFileSync(join(h.root, FILE), content);
const read = () => readFileSync(join(h.root, FILE), "utf8");

type Injection = { name: string; apply: () => void };

const injections: Injection[] = [
  { name: "no modification", apply: () => {} },
  { name: "a byte-identical rewrite (fingerprint unchanged)", apply: () => write(BASE) },
  { name: "a change to another line", apply: () => write("one\nCHANGED\nthree\n") },
  { name: "a change to the target line", apply: () => write("one\nTWO-CHANGED\nthree\n") },
  { name: "an appended line", apply: () => write(`${BASE}four\n`) },
  { name: "a truncation", apply: () => write("one\n") },
  { name: "a BOM added", apply: () => write(`\uFEFF${BASE}`) },
];

describe("anchored-edit — injected-modification property", () => {
  for (const inj of injections) {
    it(`outcome is applied-to-checked or refused: ${inj.name}`, async () => {
      write(BASE);
      const before = await h.call("read_lines", { path: FILE });
      const fp = String(before.details.fingerprint).replace(/^F#/, "");

      // Inject the modification after the read and before the mutation.
      inj.apply();
      const checkedRaw = readFileSync(join(h.root, FILE));
      const sameBytes = fingerprintOf(checkedRaw) === fp;

      const res = await h.call("edit_lines", {
        path: FILE,
        from: 2,
        to: 2,
        new_text: "REPLACED",
        fingerprint: fp,
      });
      const after = read();

      if (res.text.startsWith("REFUSED")) {
        // Refused: the file is exactly what the injection left.
        expect(after).toBe(checkedRaw.toString("utf8"));
      } else {
        // Applied: the edit landed on the CHECKED version — only line 2 changed
        // relative to it.
        expect(sameBytes).toBe(true);
        const lines = checkedRaw.toString("utf8").split("\n");
        lines[1] = "REPLACED";
        expect(after).toBe(lines.join("\n"));
      }
    });
  }

  it("outcome is applied-to-checked or refused for an anchor insert", async () => {
    write(BASE);
    const before = await h.call("read_lines", { path: FILE });
    const fp = String(before.details.fingerprint).replace(/^F#/, "");
    const anchor = (before.text.split("\n").find((l) => l.startsWith("L2#")) as string).split(
      " ",
    )[0];
    write("one\nTWO-CHANGED\nthree\n"); // inject

    const res = await h.call("insert_after", {
      path: FILE,
      anchor,
      text: "inserted",
      fingerprint: fp,
    });
    if (res.text.startsWith("REFUSED")) {
      expect(read()).toBe("one\nTWO-CHANGED\nthree\n");
    } else {
      // The anchor's line was unchanged, so this only applies if bytes matched.
      expect(read()).toBe("one\ntwo\ninserted\nthree\n");
    }
  });
});
