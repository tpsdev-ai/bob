// bob#381 — an empty model response is not the end of the task.
//
// A provider can answer a request with an assistant message that carries no
// content blocks at all and reports zero output tokens. pi treats a turn with
// no tool call as the agent being finished, so such a response ends a one-shot
// run mid-task — as a missing final message, never a completion — and lets an
// admitted persistent turn complete without a reply.
//
// bob#256's re-prompt does not cover it. That path is for a REASONING-ONLY
// ending, and `classifyAssistantEnding` requires substantive thinking content
// (compaction-contract.ts), so a message with nothing in it classifies as
// plain silence: `reasoningOnly` is false and the re-prompt loop never fires.
// The one continue turn after a compaction (run.ts) is a NEW user message,
// sent once; when the model answers it empty too, the run ends without a final
// report (`settled_after_compaction` when a compaction was seen).
//
// bob re-issues the SAME request instead, and this wrapper sits on pi's stream
// function so the model and the context are handed to the provider again with
// nothing added to the transcript. Each attempt re-runs the wrapped stream
// function: an inner wrapper may add its own per-call inputs (when the
// output-cap wrapper applies a cap, model-budget.ts, it replaces the caller's
// abort signal with its own), so the provider sees the same model and context,
// not a promise of identical options objects. The empty attempt is dropped
// before pi can see it, so it can never count as the turn that ended the run.
// The retry is BOUNDED by a constant, and past the bound the request ends with a
// named error that names the provider, the model and the empty response.
//
// The bound is DEFAULT_MAX_REASONING_REPROMPTS — the number bob#256 uses for its
// reasoning-only re-prompts. It bounds a different thing: the re-issues of ONE
// provider request, reset for every request, while bob#256's budget bounds the
// continuation turns of a whole run or admitted turn. The two budgets are
// independent; they only share the number.

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { DEFAULT_MAX_REASONING_REPROMPTS } from "./compaction-contract.js";
import {
  EMPTY_RESPONSE_EXHAUSTED,
  type EmptyResponseExhaustion,
  emptyResponseErrorText,
} from "./empty-response-marker.js";
import type { StreamFunction } from "./model-budget.js";

export {
  EMPTY_RESPONSE_EXHAUSTED,
  EMPTY_RESPONSE_MARK,
  EmptyResponseExhaustedError,
  type EmptyResponseExhaustion,
  emptyResponseErrorText,
  emptyResponseExhaustionOf,
} from "./empty-response-marker.js";

/** The most empty responses re-issued for one request: bob#256's reasoning-only
 *  bound (3), so a model that answers nothing is given the same number of
 *  chances whether it answers with thinking only or with nothing at all. A
 *  CONSTANT, never a function of the model's output. */
export const DEFAULT_MAX_EMPTY_RESPONSE_RETRIES = DEFAULT_MAX_REASONING_REPROMPTS;

/**
 * Resolve the empty-response retry budget: a positive INTEGER, capped at the
 * constant ceiling. Rejects a non-integer or non-positive value rather than
 * looping.
 */
export function resolveMaxEmptyResponseRetries(value?: number): number {
  const raw = value ?? DEFAULT_MAX_EMPTY_RESPONSE_RETRIES;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(`invalid maxEmptyResponseRetries: ${raw} (must be a positive integer)`);
  }
  return Math.min(raw, DEFAULT_MAX_EMPTY_RESPONSE_RETRIES);
}

/**
 * True when `message` is an empty response (bob#381): no content blocks at all
 * and zero output tokens. A message that ended on an error or an abort is a
 * failure the provider reported, not an empty response, and is left to the
 * caller's error handling.
 */
export function isEmptyResponse(message: AssistantMessage): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  const blocks = Array.isArray(message.content) ? message.content.length : 0;
  if (blocks !== 0) return false;
  const output = message.usage?.output;
  return typeof output === "number" && output === 0;
}

/** True when an event introduces a content block. It is the moment the attempt
 *  stops being empty, and the point from which its events are forwarded. */
function startsBlock(event: AssistantMessageEvent): boolean {
  return (
    event.type === "text_start" ||
    event.type === "thinking_start" ||
    event.type === "toolcall_start"
  );
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function failureMessage(model: Parameters<StreamFunction>[0], err: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "error",
    errorMessage: err instanceof Error ? err.message : String(err),
    timestamp: Date.now(),
  };
}

/**
 * Wrap a stream function so an empty response is re-issued, bounded, instead of
 * ending the run.
 *
 * Each attempt's events are held until its first content block. An attempt that
 * ends with no content block and zero output tokens is discarded whole — pi
 * never sees its `start` or its end — and the same request is issued again. An
 * attempt that produces a block is forwarded from that block on, as the wrapped
 * stream sent it. Past the bound the request ends with an error message whose
 * `errorMessage` names the provider, the model and the empty response
 * (`emptyResponseErrorText`).
 */
export function withEmptyResponseRetry(
  inner: StreamFunction,
  deps: { log?: (message: string) => void; maxRetries?: number } = {},
): StreamFunction {
  const log = deps.log ?? (() => {});
  const maxRetries = resolveMaxEmptyResponseRetries(deps.maxRetries);
  const wrapped = async (
    model: Parameters<StreamFunction>[0],
    context: Parameters<StreamFunction>[1],
    options?: Parameters<StreamFunction>[2],
  ): Promise<AssistantMessageEventStream> => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      let retries = 0;
      for (;;) {
        let source: AssistantMessageEventStream;
        try {
          source = await inner(model, context, options);
        } catch (err) {
          const message = failureMessage(model, err);
          out.push({ type: "error", reason: "error", error: message });
          out.end(message);
          return;
        }
        const held: AssistantMessageEvent[] = [];
        let forwarded = false;
        let terminal: AssistantMessage | undefined;
        try {
          for await (const event of source) {
            if (!forwarded && startsBlock(event)) {
              forwarded = true;
              for (const h of held) out.push(h);
              held.length = 0;
            }
            if (forwarded) out.push(event);
            else held.push(event);
            if (event.type === "done") terminal = event.message;
            else if (event.type === "error") terminal = event.error;
          }
          if (terminal === undefined) terminal = await source.result();
        } catch (err) {
          // The source broke its own event contract: end the request as an error
          // rather than leaving the caller waiting (as the output-cap backstop does).
          const message = failureMessage(model, err);
          if (!forwarded) for (const h of held) out.push(h);
          out.push({ type: "error", reason: "error", error: message });
          out.end(message);
          return;
        }
        if (!forwarded && isEmptyResponse(terminal)) {
          if (retries >= maxRetries) {
            const message: AssistantMessage & {
              [EMPTY_RESPONSE_EXHAUSTED]: EmptyResponseExhaustion;
            } = {
              ...terminal,
              content: [],
              usage: zeroUsage(),
              stopReason: "error",
              errorMessage: emptyResponseErrorText(model.provider, model.id, retries),
              [EMPTY_RESPONSE_EXHAUSTED]: {
                provider: model.provider,
                model: model.id,
                retries,
              },
            };
            out.push({ type: "error", reason: "error", error: message });
            out.end(message);
            return;
          }
          retries += 1;
          log(
            `bob: the provider ${model.provider} returned an empty response for ${model.id} (no content blocks, zero output tokens) — re-issuing the same request (${retries}/${maxRetries})`,
          );
          continue;
        }
        if (!forwarded) for (const h of held) out.push(h);
        out.end(terminal);
        return;
      }
    })();
    return out;
  };
  return wrapped as StreamFunction;
}
