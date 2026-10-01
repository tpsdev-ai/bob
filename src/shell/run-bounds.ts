// run-bounds.ts — the bounds that make a one-shot `bob run` always terminate.
//
// bob#135: a one-shot run has hung at startup and mid-run, with no timeout on
// the inference call and nothing watching the run log, so the process sat until
// someone killed it. Three independent bounds now apply, each configurable
// (`bob run` flags, bob.yaml `run:` keys) with a sane default:
//
//   * wall_clock  — the whole run's deadline.
//   * no_progress — no run-log event for N milliseconds. A stuck inference call
//                   emits nothing, so the log stops growing; this is the
//                   heartbeat the issue asks for, without external polling.
//   * call_timeout — ONE provider call's deadline, with a bounded retry, so a
//                   single stuck call cannot wedge the whole run.
//
// The wall-clock and the watchdog are RUN-LEVEL: either one, when it fires,
// sets the run's reason and aborts the signal, and {@link RunBounds.guard}
// turns that into a {@link RunAbortedError} at the next await. The per-call
// bound is applied at the prompt call site (run.ts) with {@link raceTimeout}.
//
// Every timer is cleared by {@link RunBounds.stop}, which the run calls in a
// `finally`, so a completed run leaves no timer holding the event loop open.
export type TerminationReason = "wall_clock" | "no_progress" | "call_timeout";

export interface RunLimits {
  /** Whole-run wall-clock deadline, in milliseconds. */
  wallClockMs: number;
  /** No run-log event for this long ends the run, in milliseconds. */
  noProgressMs: number;
  /** One provider call's deadline, in milliseconds. */
  callTimeoutMs: number;
  /** Retries after a per-call timeout (0 = one attempt, no retry). */
  callRetries: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = Object.freeze({
  wallClockMs: 30 * 60_000,
  noProgressMs: 10 * 60_000,
  callTimeoutMs: 5 * 60_000,
  callRetries: 1,
});

/** The `run:` block of bob.yaml, in SECONDS (the operator-facing unit). */
export interface RunLimitsBlock {
  wallClockSeconds?: number;
  noProgressSeconds?: number;
  callTimeoutSeconds?: number;
  callRetries?: number;
}

/** Per-invocation overrides (the `bob run` flags), already in milliseconds. */
export interface RunLimitsOverrides {
  wallClockMs?: number;
  noProgressMs?: number;
  callTimeoutMs?: number;
  callRetries?: number;
}

/**
 * The effective limits: the defaults, the agent's bob.yaml `run:` block, then
 * the per-invocation overrides — later layers win, and an absent key at any
 * layer leaves the earlier value.
 */
export function resolveRunLimits(block: RunLimitsBlock, overrides?: RunLimitsOverrides): RunLimits {
  const o = overrides ?? {};
  return {
    ...DEFAULT_RUN_LIMITS,
    ...(block.wallClockSeconds !== undefined ? { wallClockMs: block.wallClockSeconds * 1000 } : {}),
    ...(block.noProgressSeconds !== undefined
      ? { noProgressMs: block.noProgressSeconds * 1000 }
      : {}),
    ...(block.callTimeoutSeconds !== undefined
      ? { callTimeoutMs: block.callTimeoutSeconds * 1000 }
      : {}),
    ...(block.callRetries !== undefined ? { callRetries: block.callRetries } : {}),
    ...(o.wallClockMs !== undefined ? { wallClockMs: o.wallClockMs } : {}),
    ...(o.noProgressMs !== undefined ? { noProgressMs: o.noProgressMs } : {}),
    ...(o.callTimeoutMs !== undefined ? { callTimeoutMs: o.callTimeoutMs } : {}),
    ...(o.callRetries !== undefined ? { callRetries: o.callRetries } : {}),
  };
}

/** A run ended by one of its own bounds rather than by the session. */
export class RunAbortedError extends Error {
  readonly reason: TerminationReason;
  constructor(reason: TerminationReason) {
    super(`the run was ended by its ${reason} bound`);
    this.name = "RunAbortedError";
    this.reason = reason;
  }
}

export interface RunBounds {
  limits: RunLimits;
  /** Why the run was aborted, or undefined while it is running. */
  reason(): TerminationReason | undefined;
  /** Abort the run for `reason` (no-op if it already aborted). */
  fire(reason: TerminationReason): void;
  /** Re-arm the no-progress watchdog — call on every run-log event. */
  noteProgress(): void;
  /** Race `work` against the abort; rejects with {@link RunAbortedError} when a run-level bound fires. */
  guard<T>(work: Promise<T>): Promise<T>;
  /** Clear every timer. Safe to call more than once. */
  stop(): void;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`run bounds: ${name} must be a positive number (got ${value})`);
  }
}

export function createRunBounds(limits: RunLimits): RunBounds {
  assertPositive("wall_clock", limits.wallClockMs);
  assertPositive("no_progress", limits.noProgressMs);
  assertPositive("call_timeout", limits.callTimeoutMs);
  if (!Number.isInteger(limits.callRetries) || limits.callRetries < 0) {
    throw new Error(
      `run bounds: call_retries must be a non-negative integer (got ${limits.callRetries})`,
    );
  }

  const controller = new AbortController();
  let reason: TerminationReason | undefined;
  const fire = (r: TerminationReason): void => {
    if (reason !== undefined) return; // first bound to fire wins
    reason = r;
    controller.abort();
  };

  const wallTimer = setTimeout(() => fire("wall_clock"), limits.wallClockMs);
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const noteProgress = (): void => {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => fire("no_progress"), limits.noProgressMs);
  };

  const stop = (): void => {
    clearTimeout(wallTimer);
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  };

  const guard = <T>(work: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) {
      return Promise.reject(new RunAbortedError(reason ?? "wall_clock"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new RunAbortedError(reason ?? "wall_clock"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  };

  // Arm the watchdog once, at creation: a run that never emits an event at all
  // (the startup hang) is bounded by it too, not only by the wall clock.
  noteProgress();

  return { limits, reason: () => reason, fire, noteProgress, guard, stop };
}

/** Sentinel returned by {@link raceTimeout} when the deadline wins. */
export const TIMED_OUT: unique symbol = Symbol("run-bounds.timed-out");

/** Resolve `work`, or {@link TIMED_OUT} after `ms`. The timer is always cleared. */
export async function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The operator message for a run a bound ended, naming the knob that raises it. */
export function boundMessage(name: string, reason: TerminationReason, limits: RunLimits): string {
  // A bound set below a second (tests, or a future sub-second flag) keeps its
  // real value in the message — never a rounded "0s".
  const secs = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);
  switch (reason) {
    case "wall_clock":
      return `bob run ${name}: WALL-CLOCK TIMEOUT — the run exceeded its ${secs(limits.wallClockMs)} wall clock and was ended (exit 1). Raise it with --timeout <seconds> or run.wall_clock_seconds in bob.yaml.\n`;
    case "no_progress":
      return `bob run ${name}: NO-PROGRESS WATCHDOG — the run log saw no new event for ${secs(limits.noProgressMs)}, so the run was ended (exit 1). Raise it with --no-progress-timeout <seconds> or run.no_progress_seconds in bob.yaml.\n`;
    case "call_timeout":
      return `bob run ${name}: PER-CALL TIMEOUT — the provider did not answer within ${secs(limits.callTimeoutMs)} after ${limits.callRetries} retr${limits.callRetries === 1 ? "y" : "ies"}, so the run was ended (exit 1). Raise it with --call-timeout <seconds> or run.call_timeout_seconds in bob.yaml.\n`;
  }
}
