// bob#256 — a reasoning-only turn is not a final answer.
//
// Local reasoning models regularly end a turn with a thinking block and no
// text and no tool call. pi treats a turn with no tool call as the agent being
// finished, so such a run ends mid-task with the work unfinished. bob re-prompts
// the SAME session with a short continuation instead of letting that end the
// run.
//
// The re-prompting is BOUNDED by a constant (DEFAULT_MAX_REASONING_REPROMPTS),
// never by the model's output: after that many consecutive reasoning-only
// endings the run stops and reports the honest outcome. A model that answers
// with reasoning only forever therefore cannot hold the run — the loop's exit
// does not depend on a turn ever producing text.
//
// The caller sends the first prompt (through promptSession) and then calls
// repromptWhileReasoningOnly, which only continues it.

import {
  type AssistantEnding,
  capText,
  DEFAULT_MAX_REASONING_REPROMPTS,
  DEFAULT_REASONING_EXCERPT_CHARS,
  REASONING_CONTINUE_TURN,
} from "./compaction-contract.js";
import type { RunSession } from "./run.js";
import { promptSession } from "./session.js";

export interface ReasoningRetryResult {
  /** How many reasoning-only endings were re-prompted (0..maxReprompts). */
  reprompts: number;
  /** True when the LAST turn still ended reasoning-only (the run ended without a
   *  final report). */
  endedReasoningOnly: boolean;
  /** A bounded excerpt of the last reasoning, for the honest outcome. "" when
   *  there was none. */
  reasoningExcerpt: string;
}

export interface ReasoningRetryOptions {
  session: RunSession;
  /** The last assistant ending observed so far (undefined when the transport
   *  ends no message, in which case there is nothing to re-prompt). */
  readEnding: () => AssistantEnding | undefined;
  /** Max consecutive reasoning-only endings to re-prompt. Defaults to
   *  DEFAULT_MAX_REASONING_REPROMPTS. Clamped to >= 0. */
  maxReprompts?: number;
  excerptChars?: number;
  /** Called before each re-prompt's own turn, so the caller can open a fresh
   *  turn boundary (the observer's startTurn). */
  beginTurn?: () => void;
  /** Test/log seam: called once per re-prompt with the 1-based count and max. */
  onReprompt?: (n: number, max: number) => void;
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
  const max = Math.max(0, Math.floor(opts.maxReprompts ?? DEFAULT_MAX_REASONING_REPROMPTS));
  const excerptChars = opts.excerptChars ?? DEFAULT_REASONING_EXCERPT_CHARS;
  let reprompts = 0;
  let ending = opts.readEnding();
  while (reprompts < max && ending?.reasoningOnly === true) {
    reprompts += 1;
    opts.onReprompt?.(reprompts, max);
    opts.beginTurn?.();
    await promptSession(opts.session, REASONING_CONTINUE_TURN);
    ending = opts.readEnding();
  }
  return {
    reprompts,
    endedReasoningOnly: ending?.reasoningOnly === true,
    reasoningExcerpt: capText((ending?.reasoning ?? "").trim(), excerptChars),
  };
}
