// Property test (bob#185 slice 1, acceptance gate): a modification injected
// AFTER the mutating call is dispatched but BEFORE it takes its per-file
// critical section must yield exactly one of two outcomes — the requested edit
// is applied to the CHECKED version, or the call is refused. Changes after the
// per-file check are the documented cross-process race and are out of scope.
//
// The injection is SYNCHRONOUS, immediately after the (unawaited) call: the
// critical section runs in a microtask, so this lands between dispatch and lock
// entry. If the fingerprint were checked OUTSIDE the lock, an unchanged case
// would still succeed while a changed one would slip through; this test would
// catch both.

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

type Injection = { name: string; unchanged: boolean; apply: () => void };

const injections: Injection[] = [
  { name: "no modification", unchanged: true, apply: () => {} },
  { name: "a byte-identical rewrite", unchanged: true, apply: () => write(BASE) },
  {
    name: "a change to another line",
    unchanged: false,
    apply: () => write("one\nCHANGED\nthree\n"),
  },
  {
    name: "a change to the target line",
    unchanged: false,
    apply: () => write("one\nTWO-CHANGED\nthree\n"),
  },
  { name: "an appended line", unchanged: false, apply: () => write(`${BASE}four\n`) },
  { name: "a truncation", unchanged: false, apply: () => write("one\n") },
  { name: "a BOM added", unchanged: false, apply: () => write(`\uFEFF${BASE}`) },
];

describe("anchored-edit — injected-modification property (inject after dispatch, before the lock)", () => {
  for (const inj of injections) {
    it(`outcome is applied-to-checked or refused: ${inj.name}`, async () => {
      write(BASE);
      const before = await h.call("read_lines", { path: FILE });
      const fp = String(before.details.fingerprint).replace(/^F#/, "");
      const from = h.anchor(FILE, 2);
      const to = h.anchor(FILE, 2);

      // DISPATCH the mutation, then inject SYNCHRONOUSLY (before the lock).
      const pending = h.call("edit_lines", {
        path: FILE,
        from,
        to,
        new_text: "REPLACED",
        fingerprint: fp,
      });
      inj.apply();
      const checkedRaw = readFileSync(join(h.root, FILE));
      const res = await pending;
      const after = read();

      if (inj.unchanged) {
        // UNCHANGED cases MUST succeed.
        expect(res.text).toMatch(/ok/);
        expect(after).toBe("one\nREPLACED\nthree\n");
      } else if (res.text.startsWith("REFUSED")) {
        expect(after).toBe(checkedRaw.toString("utf8"));
      } else {
        // Applied — only if the bytes were still the checked version.
        expect(fingerprintOf(checkedRaw)).toBe(fp);
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
    const pending = h.call("insert_after", {
      path: FILE,
      anchor,
      text: "inserted",
      fingerprint: fp,
    });
    write("one\nTWO-CHANGED\nthree\n"); // inject after dispatch
    const res = await pending;
    if (res.text.startsWith("REFUSED")) {
      expect(read()).toBe("one\nTWO-CHANGED\nthree\n");
    } else {
      expect(read()).toBe("one\ntwo\ninserted\nthree\n");
    }
  });
});
