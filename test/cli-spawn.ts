// Shared CLI-spawn helper for the test suite.
//
// One place that:
//    - runs the built CLI (or any script) with execFileSync, i.e. a program +
//     argv array and NO shell, so a CLI path containing a space or a shell
//     metacharacter is a literal argument, not shell syntax;
//    - sets a per-spawn timeout in exactly one spot (CLI_SPAWN_TIMEOUT_MS),
//     so a future command that blocks hangs at most one spawn, not the whole
//     suite, before it is killed.
//
// Mirrors test/shell/flair-fake.ts: a shared, non-`.test.ts` module the
// CLI-spawning tests import so the timeout lives in one place and the spawn is
// always shell-free.
import { spawnSync } from "node:child_process";
// The default per-spawn budget. One place sets the timeout so every CLI spawn
// in the suite is bounded: a blocking command hangs at most this long.
export const CLI_SPAWN_TIMEOUT_MS = 10_000;
// The runtime that executes the built CLI. process.execPath is the exact engine
// running these tests, so there is no dependency on a bare `node`/`bun` being
// first on PATH.
const INTERPRETER = process.execPath;

// A spawn that did not complete cleanly (non-zero exit, timeout/kill, or a
// spawn failure). `.stdout` carries the merged stdout+stderr, so a caller
// reading it sees whatever the child wrote to either stream; `.signal`/`.killed`
// carry the failure cause, so a timeout (a kill signal) is tellable from an
// ordinary non-zero exit.
export class SpawnError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly signal: string | null;
  readonly code: number | null;

  constructor(details: {
    stdout: string;
    stderr: string;
    killed: boolean;
    signal: string | null;
    code: number | null;
  }) {
    super(details.stdout || "spawn failed");
    this.name = "SpawnError";
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.killed = details.killed;
    this.signal = details.signal;
    this.code = details.code;
  }
}

export interface SpawnOptions {
  timeoutMs?: number;
  /** Environment for the child (defaults to this process's). A test that isolates HOME passes it here. */
  env?: NodeJS.ProcessEnv;
}

// Run INTERPRETER over `args` (an argv array; the first element is typically
// the CLI path, a `-e` script, or a script file, never a shell string) with a
// per-spawn timeout. On success returns stdout as a string. On a non-zero
// exit, a timeout (the child is killed), or a spawn failure, throws a
// SpawnError whose `.stdout` is the merged stdout+stderr and whose `.signal`/
// `.killed` carry the failure cause, so a timeout (a kill signal) is tellable
// from an ordinary non-zero exit.
export function spawnNode(args: string[], opts: SpawnOptions = {}): string {
  const timeoutMs = opts.timeoutMs ?? CLI_SPAWN_TIMEOUT_MS;
  // spawnSync, not execFileSync: it captures stderr as well as stdout, so the
  // helper returns the merged output the old shell form's `2>&1` gave every
  // caller, and it reports the exit `status` and the kill `signal` directly.
  const run = spawnSync(INTERPRETER, args, {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = String(run.stdout ?? "");
  const stderr = String(run.stderr ?? "");
  const merged = stdout + stderr;
  const timedOut = (run.error as { code?: string } | undefined)?.code === "ETIMEDOUT";
  if (run.error || run.signal || run.status !== 0) {
    throw new SpawnError({
      stdout: merged,
      stderr,
      killed: Boolean(run.signal) || timedOut,
      signal: run.signal ?? (timedOut ? "SIGKILL" : null),
      code: Number.isFinite(run.status) ? (run.status as number) : null,
    });
  }
  return merged;
}
