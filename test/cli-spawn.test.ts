// Proves two properties of the shared CLI-spawn helper (test/cli-spawn.ts):
//
//  1. A spawn that exceeds its per-spawn timeout is KILLED, so a future
//     command that blocks hangs at most one spawn (the timeout budget), never
//     the whole suite. This is the regression #163 guards: a blocking command
//     must time out, not hang bun test.
//  2. A CLI path containing a space works, because the spawn uses an argv array
//     (no shell to re-split the path on its space or a shell metacharacter).
//
// These run the helper directly rather than the CLI, so they test the
// timeout/path contract in isolation from any particular command.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_SPAWN_TIMEOUT_MS, SpawnError, spawnNode } from "./cli-spawn.js";

const CLI = join(import.meta.dir, "..", "dist", "cli.js");

describe("CLI spawn helper bounds and path handling (#163)", () => {
  // Document the single, shared timeout value: it is the one place that
  // bounds every CLI spawn in the suite.
  it("exposes a single 10-second per-spawn timeout budget", () => {
    expect(CLI_SPAWN_TIMEOUT_MS).toBe(10_000);
  });

  // A 5s timer is spawned with a 500ms per-spawn timeout. The helper must
  // kill it at 500ms; without the timeout the child would run to 5s and,
  // held by the 2s OUTER bun-time-test below, this test would hang to the
  // outer bound and fail. A kill signal (SIGTERM/SIGKILL) proves the
  // timeout terminated the child rather than the child exiting on its own.
  it("kills a spawn that exceeds its per-spawn timeout (bounded, not hanging)", () => {
    let thrown: unknown;
    try {
      spawnNode(["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 500 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SpawnError);
    const cause = thrown as SpawnError;
    expect(["SIGTERM", "SIGKILL"]).toContain(cause.signal ?? "");
    expect(cause.killed).toBe(true);
  }, 2000);
  // A non-zero, non-killed exit carries its numeric code from `status`;
  // there is no kill signal, so `killed` is false. Asserts both SpawnError
  // fields (code + killed) for a completed non-zero exit (CodeRabbit ask).
  it("captures the numeric exit code of a non-zero, non-killed spawn", () => {
    let thrown: unknown;
    try {
      spawnNode(["-e", "process.exit(30)"]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SpawnError);
    const cause = thrown as SpawnError;
    expect(cause.code).toBe(30);
    expect(cause.killed).toBe(false);
    expect(cause.signal ?? "").toBe("");
  });

  // If the spawn used a shell string, a path with a space would be split
  // into multiple arguments and the wrong program (or nothing) would run.
  // With argv-array spawning the space is a literal path component and the
  // real CLI runs. Symlink (not copy) the built CLI into a directory whose name has a
  // space and assert `bob help` still works through the helper.
  it("handles a CLI path containing a space (no shell re-parsing)", () => {
    const base = mkdtempSync(join(tmpdir(), "cli-spawn-space-"));
    const spacedDir = join(base, "my dir");
    mkdirSync(spacedDir);
    const spacedCli = join(spacedDir, "cli.js");
    symlinkSync(CLI, spacedCli);
    try {
      const help = spawnNode([spacedCli, "help"]);
      expect(help).toContain("Commands:");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
