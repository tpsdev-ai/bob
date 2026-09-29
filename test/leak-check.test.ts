// Regression test for #221: the WHOLE suite must not leave temporary
// directories under TMPDIR.
//
// It runs `bun test` in a CHILD process with TMPDIR pointed at a fresh empty
// directory, waits for the child to exit, and asserts that nothing is left
// behind. A guard env var stops the child from re-running THIS file, which
// would recurse.
//
// The runtime itself creates a couple of paths under TMPDIR during a run. They
// are named EXPLICITLY below — never excluded by a broad pattern, so a real
// test leak cannot hide behind the exclusion.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Paths the RUNTIME (not a test) creates directly under TMPDIR during a run.
const RUNTIME_CREATED = new Set(["jiti"]);

const IS_CHILD = process.env.BOB_LEAK_CHECK_CHILD === "1";
const REPO_ROOT = join(import.meta.dir, "..");

describe("leak check (#221)", () => {
  // In the child, skip this file entirely (it would spawn another whole-suite
  // child and recurse).
  (IS_CHILD ? test.skip : test)(
    "the whole suite leaves no temporary directory under TMPDIR",
    () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "bob-leak-check-"));
      try {
        const res = spawnSync(process.execPath, ["test", "./test"], {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TMPDIR: tmpRoot, BOB_LEAK_CHECK_CHILD: "1" },
          timeout: 600_000,
        });
        const stderr = String(res.stderr ?? "");
        // The child must have RUN the suite — otherwise an empty TMPDIR would
        // pass vacuously. (The suite's own pass/fail is CI's job; this check's
        // job is the leftover directories.) bun test writes its summary to stderr.
        expect(res.error, `child failed to run: ${String(res.error)}`).toBeUndefined();
        expect(
          /Ran \d+ tests/.test(stderr),
          `child did not run the suite:\n${stderr.slice(-1000)}`,
        ).toBe(true);
        // Nothing but the runtime-created paths may remain (a leak is named by
        // the leftover entries, so a failure reports the offending prefix).
        const leftover = readdirSync(tmpRoot).filter((e) => !RUNTIME_CREATED.has(e));
        expect(leftover).toEqual([]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
