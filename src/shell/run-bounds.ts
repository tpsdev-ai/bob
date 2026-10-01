// run-bounds.ts — the bounds that end a one-shot `bob run` that stalls.
//
// bob#135: a one-shot run has hung at startup and mid-run, with no timeout on
// the inference call and nothing watching the run log, so the process sat until
// someone killed it. Three independent bounds now apply, each configurable
// (`bob run` flags, bob.yaml `run:` keys) with a sane default:
//
//   * wall_clock  — the run's deadline, counted from createRunBounds. run.ts
//                   calls it once the agent's configuration is resolved,
//                   before the Flair bootstrap and the session start.
//   * no_progress — no run-log event for N milliseconds. A stuck inference call
//                   emits nothing, so the log stops growing; this is the
//                   heartbeat the issue asks for, without external polling.
//   * turn_timeout — the deadline for ONE prompt bob sends. A prompt that
//                   misses it ends the run; there is no retry.
//
// The wall-clock and the watchdog are RUN-LEVEL: either one, when it fires,
// sets the run's reason and aborts the signal, and {@link RunBounds.guard}
// turns that into a {@link RunAbortedError} at the next guarded await. The turn
// bound is applied to every prompt a one-shot run sends (the task, the continue
// turn and the reasoning re-prompts; run.ts's `boundedPrompt`), which races the
// whole `prompt()` call against {@link raceTimeout} and, when the deadline wins,
// fires `turn_timeout` to end the run. The compaction note is queued with
// `steer()` and starts no turn of its own. pi's `prompt()` is a whole turn (model
// requests plus tool work) and offers no per-request signal, so a turn is the
// smallest unit bob can bound.
//
// Every timer is cleared by the time the run ends: {@link RunBounds.stop}
// clears the run-level timers, and a fired run-level bound cancels the turn
// deadline ({@link raceTimeout} takes the run's signal), so a completed run
// leaves no timer holding the event loop open.
export type TerminationReason = "wall_clock" | "no_progress" | "turn_timeout";

export interface RunLimits {
  /** The run's wall-clock deadline, in milliseconds, counted from createRunBounds. */
  wallClockMs: number;
  /** No run-log event for this long ends the run, in milliseconds. */
  noProgressMs: number;
  /** The deadline for one prompt bob sends, in milliseconds. */
  turnTimeoutMs: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = Object.freeze({
  wallClockMs: 30 * 60_000,
  noProgressMs: 10 * 60_000,
  turnTimeoutMs: 5 * 60_000,
});

/** Node's maximum timer delay: `setTimeout` clamps a larger delay to 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** The `run:` block of bob.yaml, in SECONDS (the operator-facing unit). */
export interface RunLimitsBlock {
  wallClockSeconds?: number;
  noProgressSeconds?: number;
  turnTimeoutSeconds?: number;
}

/** Per-invocation overrides (the `bob run` flags), already in milliseconds. */
export interface RunLimitsOverrides {
  wallClockMs?: number;
  noProgressMs?: number;
  turnTimeoutMs?: number;
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
    ...(block.turnTimeoutSeconds !== undefined
      ? { turnTimeoutMs: block.turnTimeoutSeconds * 1000 }
      : {}),
    ...(o.wallClockMs !== undefined ? { wallClockMs: o.wallClockMs } : {}),
    ...(o.noProgressMs !== undefined ? { noProgressMs: o.noProgressMs } : {}),
    ...(o.turnTimeoutMs !== undefined ? { turnTimeoutMs: o.turnTimeoutMs } : {}),
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
  /** Aborted when any bound fires ({@link RunBounds.fire}). A raced turn
   *  deadline watches it, so it does not outlive the run. */
  signal: AbortSignal;
  /** Why the run was aborted, or undefined while it is running. */
  reason(): TerminationReason | undefined;
  /** Abort the run for `reason` (no-op if it already aborted). */
  fire(reason: TerminationReason): void;
  /** Re-arm the no-progress watchdog — call on every run-log event. */
  noteProgress(): void;
  /** Race `work` against the abort; rejects with {@link RunAbortedError} once any bound has fired. */
  guard<T>(work: Promise<T>): Promise<T>;
  /** Clear the run-level timers. Safe to call more than once. */
  stop(): void;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`run bounds: ${name} must be a positive number (got ${value})`);
  }
}

function assertWithinTimerRange(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value > MAX_TIMER_MS) {
    throw new Error(
      `run bounds: ${name} must be a whole number of ms at most ${MAX_TIMER_MS} (got ${value})`,
    );
  }
}

export function createRunBounds(limits: RunLimits): RunBounds {
  assertPositive("wall_clock", limits.wallClockMs);
  assertPositive("no_progress", limits.noProgressMs);
  assertPositive("turn_timeout", limits.turnTimeoutMs);
  assertWithinTimerRange("wall_clock", limits.wallClockMs);
  assertWithinTimerRange("no_progress", limits.noProgressMs);
  assertWithinTimerRange("turn_timeout", limits.turnTimeoutMs);

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

  return {
    limits,
    signal: controller.signal,
    reason: () => reason,
    fire,
    noteProgress,
    guard,
    stop,
  };
}

/** Sentinel returned by {@link raceTimeout} when the deadline wins. */
export const TIMED_OUT: unique symbol = Symbol("run-bounds.timed-out");

/** Resolve `work`, or {@link TIMED_OUT} after `ms`. The timer is always cleared:
 *  when the race settles, and when `signal` aborts — a run-level bound that wins
 *  cancels the deadline rather than leaving it to hold the event loop open. */
export async function raceTimeout<T>(
  work: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    // Already aborted: there is no deadline to arm. The caller's guard rejects
    // `work` on its own, and a timer armed here would outlive the run.
    if (signal?.aborted === true) return;
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  const onAbort = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
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
    case "turn_timeout":
      return `bob run ${name}: TURN TIMEOUT — the prompt turn did not finish within ${secs(limits.turnTimeoutMs)}, so the run was ended (exit 1). Raise it with --turn-timeout <seconds> or run.turn_timeout_seconds in bob.yaml.\n`;
  }
}
