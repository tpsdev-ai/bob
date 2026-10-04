// bob#214 — one usage record per model request, for the run log.
//
// The run log already carries every event, but reading token counts and timing
// out of it meant reverse engineering: prompt tokens split across `input` and
// `cacheRead`, time to first token only from the gap between the message's
// timestamp and the first streamed delta, and thinking tokens reported as 0 by
// servers that do not count them. This tracker turns each agent request into
// one flat record when its assistant message ends.
//
// Sources, stated so a reader knows what each number is:
//   * start          — the assistant message's `timestamp`, which pi-ai sets
//                      just before it makes the HTTP request;
//   * first token    — bob's clock at the first streamed piece (a text,
//                      thinking or tool-call delta with content), so `ttftMs`
//                      covers queueing, load and prefill;
//   * token counts   — the provider's final usage (`usage` on message_end):
//                      promptTokens = input + cacheRead + cacheWrite,
//                      cachedPromptTokens = cacheRead, completionTokens = output.
//                      A stream bob's output backstop ended has no provider
//                      usage (it never arrives, and bob does not count tokens):
//                      `outputCapped` marks it, its prompt counts are 0 and its
//                      completionTokens is the cap bob assigned (a lower bound,
//                      not a count; model-budget.ts capOutputStream);
//   * thinking tokens — the provider's `usage.reasoning` when it reports a
//                      positive count ("provider"); otherwise the number of
//                      streamed thinking pieces ("stream-deltas"). That is a
//                      count of pieces, not tokens: a piece can carry several.
//
// pi's own summarization calls (compaction) are not agent requests and emit no
// message events; their usage is on the `compaction_end` record.

import { OUTPUT_CAP_MARK } from "./model-budget.js";

export interface RequestUsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  thinkingTokens: number;
  thinkingTokensSource: "provider" | "stream-deltas";
  /** ms from the request start to the first streamed piece; null when nothing streamed. */
  ttftMs: number | null;
  /** ms from the request start to the end of the message. */
  durationMs: number | null;
  stopReason: string;
  /** Present when bob's output backstop ended the stream (more streamed pieces
   *  than the token cap the provider was sent). The record's token counts are
   *  then not the provider's: its usage never arrived, so the prompt counts are
   *  0 and completionTokens is the cap bob assigned, a lower bound. */
  outputCapped?: true;
  /** The session model's output cap when the selected row declares a budget
   *  (bob#185 item 2, bob#306), present only on a request whose stopReason is
   *  "length". */
  outputCap?: number;
}

interface UsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
}

interface MessageLike {
  role?: string;
  provider?: unknown;
  model?: unknown;
  timestamp?: unknown;
  stopReason?: unknown;
  usage?: UsageLike;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface RequestUsageTracker {
  /** Feed every session event. Returns the record when an assistant message ends. */
  observe(event: unknown): RequestUsageRecord | undefined;
}

export function createRequestUsageTracker(
  clock: () => number = Date.now,
  deps: { outputCap?: number } = {},
): RequestUsageTracker {
  let firstDeltaAt: number | undefined;
  let thinkingDeltas = 0;
  const outputCap =
    typeof deps.outputCap === "number" && Number.isFinite(deps.outputCap) && deps.outputCap > 0
      ? deps.outputCap
      : undefined;

  const reset = (): void => {
    firstDeltaAt = undefined;
    thinkingDeltas = 0;
  };

  return {
    observe(event: unknown): RequestUsageRecord | undefined {
      const e = (event ?? {}) as {
        type?: string;
        message?: MessageLike;
        assistantMessageEvent?: { type?: string; delta?: unknown };
      };
      if (e.type === "message_start" && e.message?.role === "assistant") {
        reset();
        return undefined;
      }
      if (e.type === "message_update") {
        const inner = e.assistantMessageEvent;
        const kind = inner?.type;
        const hasContent = typeof inner?.delta === "string" && inner.delta.length > 0;
        if (
          hasContent &&
          (kind === "text_delta" || kind === "thinking_delta" || kind === "toolcall_delta")
        ) {
          if (firstDeltaAt === undefined) firstDeltaAt = clock();
          if (kind === "thinking_delta") thinkingDeltas += 1;
        }
        return undefined;
      }
      if (e.type !== "message_end" || e.message?.role !== "assistant") return undefined;

      const message = e.message;
      const usage = message.usage ?? {};
      const endedAt = clock();
      const start = typeof message.timestamp === "number" ? message.timestamp : undefined;
      const reportedThinking = count(usage.reasoning);
      const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
      const record: RequestUsageRecord = {
        provider: typeof message.provider === "string" ? message.provider : "",
        model: typeof message.model === "string" ? message.model : "",
        promptTokens: count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite),
        cachedPromptTokens: count(usage.cacheRead),
        completionTokens: count(usage.output),
        thinkingTokens: reportedThinking > 0 ? reportedThinking : thinkingDeltas,
        thinkingTokensSource: reportedThinking > 0 ? "provider" : "stream-deltas",
        ttftMs: start !== undefined && firstDeltaAt !== undefined ? firstDeltaAt - start : null,
        durationMs: start !== undefined ? endedAt - start : null,
        stopReason,
        ...(outputCap !== undefined && stopReason === "length" ? { outputCap } : {}),
        ...((message as Record<string, unknown>)[OUTPUT_CAP_MARK] === true
          ? { outputCapped: true as const }
          : {}),
      };
      reset();
      return record;
    },
  };
}
