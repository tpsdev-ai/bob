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
//   * first token    — bob's clock at the first streamed delta with content
//                      (text, thinking or tool call), so `ttftMs` covers
//                      queueing, load and prefill;
//   * token counts   — the provider's final usage (`usage` on message_end):
//                      promptTokens = input + cacheRead + cacheWrite,
//                      cachedPromptTokens = cacheRead, completionTokens = output;
//   * thinking tokens — the provider's `usage.reasoning` when it reports a
//                      positive count ("provider"); otherwise the number of
//                      streamed thinking deltas ("stream-deltas"), a lower bound
//                      (each delta carries at least one token).
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
  /** ms from the request start to the first streamed delta; null when nothing streamed. */
  ttftMs: number | null;
  /** ms from the request start to the end of the message. */
  durationMs: number | null;
  stopReason: string;
  /** Present when bob ended the stream at the output cap (the provider ignored it). */
  outputCapped?: true;
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

export function createRequestUsageTracker(clock: () => number = Date.now): RequestUsageTracker {
  let firstDeltaAt: number | undefined;
  let thinkingDeltas = 0;

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
        stopReason: typeof message.stopReason === "string" ? message.stopReason : "",
        ...((message as Record<string, unknown>)[OUTPUT_CAP_MARK] === true
          ? { outputCapped: true as const }
          : {}),
      };
      reset();
      return record;
    },
  };
}
