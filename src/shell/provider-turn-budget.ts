// Provider-aware REASONING / OUTPUT budget, carried by the SELECTED provider
// row (bob#185 item 2).
//
// The measured problem: on a local model a single turn generated up to 19k
// output tokens (mostly reasoning) at ~15 tokens/s, so one turn ran for
// minutes. The harness asked a local model to behave like a cloud one. This
// module turns the row into the source of a per-turn budget:
//
//   * maxOutputTokens — the output cap pi sends on the turn's request, as
//     `max_tokens` (the budgeted model's compat selects that field).
//   * reasoning — the thinking level for the turn: a reduced budget, or "off"
//     (non-thinking) for tool-heavy turns. The value is one of pi's own
//     thinking levels, so pi hands each provider the level in that provider's
//     own request shape (for the OpenAI-compatible adapter, `reasoning_effort`).
//
// A budget is only valid on a `bob/none` row: bob applies it to that row's
// session only. The session factory folds the cap into the model's output cap
// (bob#306); the keyless transport (base-url-transport.ts) sets the cap's wire
// field and the level. The row owns the values;
// this module owns the bounds and the mode set (validated at load by
// provider-registry.ts).

/**
 * The thinking levels a row may declare for a turn. `off` is non-thinking;
 * the rest are pi's own levels (the extended `xhigh`/`max` are omitted, since
 * pi clamps them and a local row has no use for them). The row names the level
 * pi hands the provider; it does not name a wire field.
 */
export const TURN_REASONING_MODES = ["off", "low", "medium", "high"] as const;
export type TurnReasoningMode = (typeof TURN_REASONING_MODES)[number];

/** A row's per-turn reasoning / output budget. Every field is required. */
export interface ProviderTurnBudget {
  /** Per-turn output cap in tokens; pi sends it in the provider's own field. */
  readonly maxOutputTokens: number;
  /** The turn's thinking level; `off` is non-thinking. */
  readonly reasoning: TurnReasoningMode;
}

/**
 * The validated bounds for a budget an operator may declare. `maxOutputTokens`
 * is bounded well below a context window; a value outside the bounds is
 * refused rather than clamped.
 */
export const TURN_BUDGET_BOUNDS = Object.freeze({
  maxOutputTokens: Object.freeze({ min: 256, max: 131_072 }),
});

/** True when `value` is one of the declared reasoning modes. */
export function isTurnReasoningMode(value: unknown): value is TurnReasoningMode {
  return typeof value === "string" && (TURN_REASONING_MODES as readonly string[]).includes(value);
}
