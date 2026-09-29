// Regression test for #221: the WHOLE suite must not leave temporary
// directories under TMPDIR — and this check must not pass vacuously when the
// suite it runs fails or is truncated.
//
// It runs `bun test ./test` in a CHILD process with TMPDIR pointed at a fresh
// empty directory, waits for the child, and asserts THREE things:
//
//   1. the child SUCCEEDED (exit status 0) — a suite whose tests FAILED must
//      fail THIS check, not sail through on the "Ran N tests" text alone;
//   2. the child ran the WHOLE suite — Bun's end summary reports how many files
//      it ran, and that count must equal the test files discovered under test/;
//   3. nothing is left behind.
//
// It is OPT-IN: the normal suite skips it (it spawns a whole second suite), and
// CI runs it in its own job with BOB_LEAK_CHECK=1. A guard env var stops the
// child from re-running THIS file, which would recurse.
//
// The runtime itself creates a couple of paths under TMPDIR during a run. They
// are named EXPLICITLY below — never excluded by a broad pattern, so a real
// test leak cannot hide behind the exclusion.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Paths the RUNTIME (not a test) creates directly under TMPDIR during a run.
const RUNTIME_CREATED = new Set(["jiti"]);

const IS_CHILD = process.env.BOB_LEAK_CHECK_CHILD === "1";
const ENABLED = process.env.BOB_LEAK_CHECK === "1";
const REPO_ROOT = join(import.meta.dir, "..");
const TEST_ROOT = join(REPO_ROOT, "test");

// The test files Bun discovers under a directory: its default patterns are
// `*.test.*` / `*_test.*` / `*.spec.*`. Counted with the SAME rule, so the
// child's reported file count is checked against the files on disk — a child
// that ran only part of the suite (or none of it) cannot pass.
const TEST_FILE = /(?:^|[/\\])[^/\\]*?(?:\.|_)(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

function discoveredTestFiles(dir: string): number {
  return readdirSync(dir, { recursive: true }).filter((entry) => TEST_FILE.test(entry)).length;
}

describe("leak check (#221)", () => {
  // Skip in the child (it would spawn another whole-suite child and recurse),
  // and unless explicitly enabled — the normal suite stays fast, and CI runs
  // this file in its own job with BOB_LEAK_CHECK=1.
  (IS_CHILD || !ENABLED ? test.skip : test)(
    "the whole suite leaves no temporary directory under TMPDIR",
    () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "bob-leak-check-"));
      // A real TMPDIR is world-traversable (/tmp is 1777); mkdtempSync makes a
      // 0700 root. The suite contains a proof that runs as a DIFFERENT OS user
      // (the jarvis key-read proof) and cannot traverse a 0700 root, so give the
      // isolated root traverse permission — otherwise the child fails for a
      // reason that is the environment, not a leaked directory.
      chmodSync(tmpRoot, 0o711);
      try {
        const res = spawnSync(process.execPath, ["test", "./test"], {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TMPDIR: tmpRoot, BOB_LEAK_CHECK_CHILD: "1" },
          timeout: 600_000,
        });
        const stderr = String(res.stderr ?? "");
        expect(res.error, `child failed to run: ${String(res.error)}`).toBeUndefined();
        // (1) The child must have SUCCEEDED. The old check accepted any "Ran N
        // tests" text, so a suite whose tests FAILED still passed this check.
        expect(
          res.status,
          `child suite did not exit 0 (status ${String(res.status)}):\n${stderr.slice(-2000)}`,
        ).toBe(0);
        // (2) The child must have run the WHOLE suite. Parse Bun's end summary
        // and compare the file count it reports to the test files on disk — a
        // truncated run (Bun exits 0 when it finds no tests) cannot pass.
        const summary = /Ran \d+ tests across (\d+) files/.exec(stderr);
        expect(
          summary,
          `child did not report a run summary:\n${stderr.slice(-1000)}`,
        ).not.toBeNull();
        const ranFiles = Number((summary as RegExpExecArray)[1]);
        const onDisk = discoveredTestFiles(TEST_ROOT);
        expect(
          ranFiles,
          `child ran ${ranFiles} files but ${onDisk} test files exist under ${relative(REPO_ROOT, TEST_ROOT)}/`,
        ).toBe(onDisk);
        // (3) Nothing but the runtime-created paths may remain (a leak is named
        // by the leftover entries, so a failure reports the offending prefix).
        const leftover = readdirSync(tmpRoot).filter((e) => !RUNTIME_CREATED.has(e));
        expect(leftover).toEqual([]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
