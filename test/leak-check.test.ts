// Regression test for #221: verifies that positions-195 does NOT leak
// any directories under TMPDIR.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function checkLeak(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), "bob-leak-check-"));
  try {
    const _res = spawnSync(process.execPath, ["test", "./test/shell/positions-195.test.ts"], {
      cwd: join(import.meta.dir, ".."),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: tmpRoot },
      timeout: 60_000,
    });
    const entries = readdirSync(tmpRoot);
    expect(entries).toEqual([]);
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

describe("leak check (#221)", () => {
  test("positions-195: no dirs left after test run", () => {
    checkLeak();
  });
});
