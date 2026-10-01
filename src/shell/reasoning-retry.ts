// bob#256 — a reasoning-only turn is not a final answer.
//
// Local reasoning models regularly end a turn with a thinking block, no
// text beyond whitespace and no tool call. pi treats a turn with no tool call as the agent being
// finished, so such a run ends mid-task with the work unfinished. bob re-prompts
// the SAME session with a short continuation instead of letting that end the
// run.
//
// The re-prompting is BOUNDED by a constant (DEFAULT_MAX_REASONING_REPROMPTS),
// never by the model's output. A one-shot run (run.ts) carries ONE budget across
// its whole run, the compaction retry included; each admitted runtime turn
// (turn-admission.ts) gets a fresh budget, and exhaustion rejects that turn while
// the runtime continues. The loop's exit never depends on a turn producing text.
// The caller sends the first prompt (through promptSession) and then calls
// repromptWhileReasoningOnly, which only continues it.

import {
  type AssistantEnding,
  DEFAULT_MAX_REASONING_REPROMPTS,
  REASONING_CONTINUE_TURN,
} from "./compaction-contract.js";
import type { RunSession } from "./run.js";
import { promptSession } from "./session.js";

/**
 * Thrown by a turn ADMISSION when an admitted turn keeps ending reasoning-only
 * past the bound. Callers (the cron scheduler, the Discord inbound listener)
 * treat it as a failed turn rather than a successful one.
 */
export class ReasoningOnlyExhaustedError extends Error {
  readonly reprompts: number;
  constructor(reprompts: number) {
    super(
      `the turn ended without a final report: its last turns carried reasoning only (no text beyond whitespace, no tool call) after ${reprompts} re-prompt(s)`,
    );
    this.name = "ReasoningOnlyExhaustedError";
    this.reprompts = reprompts;
  }
}

export interface ReasoningRetryResult {
  /** How many reasoning-only endings were re-prompted (0..maxReprompts). */
  reprompts: number;
  /** True when the turn that just ended is still reasoning-only. */
  endedReasoningOnly: boolean;
}

export interface ReasoningRetryOptions {
  session: RunSession;
  /** The last assistant ending observed so far (undefined when the transport
   *  ends no message, in which case there is nothing to re-prompt). */
  readEnding: () => AssistantEnding | undefined;
  /** Max reasoning-only re-prompts. Must be a positive INTEGER; capped at
   *  DEFAULT_MAX_REASONING_REPROMPTS so no caller can make the loop unbounded.
   *  Defaults to that constant. */
  maxReprompts?: number;
  /** Called before each re-prompt's own turn, so the caller can open a fresh
   *  turn boundary (the observer's startTurn). */
  beginTurn?: () => void;
  /** Test/log seam: called once per re-prompt with the 1-based count and max. */
  onReprompt?: (n: number, max: number) => void;
}

/**
 * Resolve the re-prompt budget: a positive INTEGER, capped at the constant
 * ceiling. Rejects a non-integer or non-positive value rather than looping.
 */
export function resolveMaxReprompts(value?: number): number {
  const raw = value ?? DEFAULT_MAX_REASONING_REPROMPTS;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(`invalid maxReprompts: ${raw} (must be a positive integer)`);
  }
  return Math.min(raw, DEFAULT_MAX_REASONING_REPROMPTS);
}

/**
 * Re-prompt the session while its last turn ended reasoning-only, bounded.
 *
 * The first prompt has already been sent. Each iteration sends
 * REASONING_CONTINUE_TURN as its own turn and re-reads the ending. The loop
 * stops when the ending is no longer reasoning-only OR the bound is reached —
 * the bound is checked before every send, so it can never spin past it.
 */
export async function repromptWhileReasoningOnly(
  opts: ReasoningRetryOptions,
): Promise<ReasoningRetryResult> {
  const max = resolveMaxReprompts(opts.maxReprompts);
  let reprompts = 0;
  let ending = opts.readEnding();
  while (reprompts < max && ending?.reasoningOnly === true) {
    reprompts += 1;
    opts.onReprompt?.(reprompts, max);
    opts.beginTurn?.();
    await promptSession(opts.session, REASONING_CONTINUE_TURN);
    ending = opts.readEnding();
  }
  return { reprompts, endedReasoningOnly: ending?.reasoningOnly === true };
}
