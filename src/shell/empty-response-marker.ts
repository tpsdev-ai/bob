// bob#381 — provenance for an empty-response bound that was spent.
//
// The empty-response wrapper (empty-response.ts) sets this marker on the error
// message of a request whose own empty answers outlasted its bound. The runner
// and the turn admission classify on this typed marker, never on error text: a
// provider can put any phrase in an error message of its own.
//
// It lives in its own module because empty-response.ts also needs a constant
// from compaction-contract.ts; importing the marker there would make the two
// modules a cycle at evaluation time.

/** The phrase an exhausted request's error carries. It is DISPLAY text only:
 *  classification reads the typed provenance below, never this text, because a
 *  provider can put any phrase in an error message of its own. */
export const EMPTY_RESPONSE_MARK =
  "returned an empty response (no content blocks, zero output tokens)";

/** Provenance the wrapper sets on the error message of a request whose own empty
 *  responses outlasted its bound. */
export interface EmptyResponseExhaustion {
  readonly provider: string;
  readonly model: string;
  readonly retries: number;
}

/** The property carrying {@link EmptyResponseExhaustion} on an exhausted
 *  message. Enumerable, so pi's in-place message replacement copies it. */
export const EMPTY_RESPONSE_EXHAUSTED = "bobEmptyResponseExhausted" as const;

/** The named error for a request whose empty responses outlasted the bound. */
export function emptyResponseErrorText(provider: string, model: string, retries: number): string {
  return `the provider ${provider} ${EMPTY_RESPONSE_MARK} for model ${model} after ${retries} retries`;
}

/** The exhaustion provenance on `message`, when present: the empty-response wrapper (empty-response.ts) sets it; this reads its shape only. */
export function emptyResponseExhaustionOf(message: unknown): EmptyResponseExhaustion | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const value = (message as Record<string, unknown>)[EMPTY_RESPONSE_EXHAUSTED];
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string") return undefined;
  if (typeof record.model !== "string") return undefined;
  if (typeof record.retries !== "number") return undefined;
  return { provider: record.provider, model: record.model, retries: record.retries };
}

/** The typed failure an admitted turn rejects with when its last assistant
 *  message is the exhausted empty-response error. */
export class EmptyResponseExhaustedError extends Error {
  constructor(readonly exhaustion: EmptyResponseExhaustion) {
    super(emptyResponseErrorText(exhaustion.provider, exhaustion.model, exhaustion.retries));
    this.name = "EmptyResponseExhaustedError";
  }
}
