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
import { execFileSync } from "node:child_process";
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
  try {
    return execFileSync(INTERPRETER, args, {
      timeout: timeoutMs,
      // killSignal SIGKILL so the timeout bounds even a child that traps
      // SIGTERM; the default SIGTERM can leave execFileSync waiting past the
      // budget instead of terminating the child (CodeRabbit review).
      killSignal: "SIGKILL",
      encoding: "utf8",
    });
  } catch (e) {
    const cause = e as {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string | null;
      code?: number | null;
      status?: number | null;
    };
    const rawStdout = String(cause.stdout ?? "");
    const rawStderr = String(cause.stderr ?? "");
    // A non-zero synchronous result carries its exit code in `status`, not
    // `code` (the synchronous result does not expose `code` for a killed
    // child). A kill/timeout leaves no code but a termination `signal`, from
    // which `killed` is derived.
    const code = Number.isFinite(cause.status)
      ? (cause.status as number)
      : Number.isFinite(cause.code)
        ? (cause.code as number)
        : null;
    throw new SpawnError({
      stdout: rawStdout + rawStderr,
      stderr: rawStderr,
      killed: Boolean(cause.killed) || Boolean(cause.signal),
      signal: cause.signal ?? null,
      code,
    });
  }
}
