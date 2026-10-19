// bob#365 — a narrating turn is not a final report.
//
// A one-shot builder run ends when the model returns a turn with text and no
// tool call, because pi treats a turn with no tool call as the agent being
// finished — even when that text announces a next step ("Let me fix lines
// 282-284:") instead of reporting. When the run DECLARES final-report markers
// (role.json `final_markers`, or the run's `finalMarkers` option), such a turn
// is decided structurally: its trimmed text does not start with a marker, so it
// is not a final report, and bob re-prompts the SAME session with a fixed
// continuation instead of letting it end the run. The caller owns that
// classification (`narrating`), so the loop and the run's outcome use ONE rule.
// A run that declares no markers is unchanged.
//
// The re-prompting is BOUNDED by a constant (DEFAULT_MAX_NARRATION_REPROMPTS),
// never by the model's output, and is its own budget, separate from the
// reasoning-only one (reasoning-retry.ts). A one-shot run (run.ts) carries ONE
// narration budget across its whole run, the compaction retry included, and
// sends every re-prompt through its bounded sender. The caller sends the first
// prompt and then calls repromptWhileNarrating, which only continues it.

import { DEFAULT_MAX_NARRATION_REPROMPTS, NARRATION_CONTINUE_TURN } from "./compaction-contract.js";
import type { RunSession } from "./run.js";
import { promptSession } from "./session.js";

export interface NarrationRetryResult {
  /** How many narrating endings were re-prompted (0..maxReprompts). */
  reprompts: number;
  /** True when the turn that just ended is still narration. */
  endedNarrating: boolean;
}

export interface NarrationRetryOptions {
  session: RunSession;
  /** Whether the run's current ending is narration rather than a final report.
   *  run.ts passes its one classifier, the same function its outcome calls, so
   *  the loop and the outcome apply the same rule to the same ending. */
  narrating: () => boolean;
  /** Max narration re-prompts. Must be a positive INTEGER; capped at
   *  DEFAULT_MAX_NARRATION_REPROMPTS so no caller can make the loop unbounded.
   *  Defaults to that constant. */
  maxReprompts?: number;
  /** Called before each re-prompt's own turn, so the caller can open a fresh
   *  turn boundary (the observer's startTurn). */
  beginTurn?: () => void;
  /** How to send one continuation turn. Defaults to `promptSession(session,
   *  text)`. A one-shot caller passes its BOUNDED sender, so a stalled
   *  continuation is bounded exactly like the first prompt. */
  send?: (text: string) => Promise<void>;
  /** Called after each re-prompt's turn and before `narrating` is asked again. A
   *  one-shot caller drains a reasoning-only ending here, on the run's own
   *  reasoning budget, so a continuation that ends reasoning-only is handled
   *  exactly as any other turn. */
  afterTurn?: () => Promise<void>;
  /** Test/log seam: called once per re-prompt with the 1-based count and max. */
  onReprompt?: (n: number, max: number) => void;
}

/**
 * Resolve the narration re-prompt budget: a positive INTEGER, capped at the
 * constant ceiling. Rejects a non-integer or non-positive value rather than
 * looping.
 */
export function resolveMaxNarrationReprompts(value?: number): number {
  const raw = value ?? DEFAULT_MAX_NARRATION_REPROMPTS;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(`invalid maxReprompts: ${raw} (must be a positive integer)`);
  }
  return Math.min(raw, DEFAULT_MAX_NARRATION_REPROMPTS);
}

/**
 * Re-prompt the session while its last turn ended with narration, bounded.
 *
 * The first prompt has already been sent. Each iteration sends
 * NARRATION_CONTINUE_TURN as its own turn, runs `afterTurn`, and asks
 * `narrating` again. The loop stops when the ending is no longer narration OR
 * the bound is reached — the bound is checked before every send, so it can
 * never spin past it.
 */
export async function repromptWhileNarrating(
  opts: NarrationRetryOptions,
): Promise<NarrationRetryResult> {
  const max = resolveMaxNarrationReprompts(opts.maxReprompts);
  const send = opts.send ?? ((text: string) => promptSession(opts.session, text));
  let reprompts = 0;
  while (reprompts < max && opts.narrating()) {
    reprompts += 1;
    opts.onReprompt?.(reprompts, max);
    opts.beginTurn?.();
    await send(NARRATION_CONTINUE_TURN);
    await opts.afterTurn?.();
  }
  return { reprompts, endedNarrating: opts.narrating() };
}
