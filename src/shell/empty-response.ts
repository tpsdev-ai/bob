// bob#256's REASONING-ONLY re-prompt requires substantive thinking content
// (compaction-contract.ts), so a message with nothing in it classifies as
// plain silence: `reasoningOnly` is false and the re-prompt loop never fires.
//
// bob re-issues the SAME request instead, and this wrapper sits on pi's stream
// function so the model and the context are handed to the provider again with
// nothing added to the transcript. Each attempt re-runs the wrapped stream
// function: an inner wrapper may add its own per-call inputs (when the
// output-cap wrapper applies a cap, model-budget.ts, it replaces the caller's
// abort signal with its own), so the provider sees the same model and context,
// not a promise of identical options objects. Before the bound, an empty zero-output attempt
// that starts no block and ends without an error or abort is dropped before
// pi sees it, unless it is a length stop pi's own classifiers accept (bob#395).
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
  isContextOverflow,
  isRecoverableLength,
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

/** The per-request retry ceiling, sharing bob#256's numeric bound. */
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

export function hasNoContentBlocks(message: Partial<AssistantMessage>): boolean {
  return (
    message.stopReason !== "error" &&
    message.stopReason !== "aborted" &&
    (!Array.isArray(message.content) || message.content.length === 0)
  );
}

/** Length stops pi classifies pass through for its recovery attempt (bob#395). */
function isPiRecoveryCandidate(
  message: AssistantMessage,
  model: Parameters<StreamFunction>[0],
): boolean {
  return (
    message.stopReason === "length" &&
    (isContextOverflow(message, model.contextWindow) ||
      isRecoverableLength(message, model.maxTokens))
  );
}

/** True for a block-start event, which flushes held events and begins forwarding. */
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
 * Re-issue a request only when its stream starts no content block and ends with
 * no content blocks, zero output tokens, and neither an error nor an abort,
 * while retries remain, except length stops pi classifies for recovery (bob#395).
 * Past the bound, pi receives an error naming the provider, model and empty
 * response (`emptyResponseErrorText`).
 *
 * On a block-start event, held events are flushed and forwarding begins.
 * Content present only in the terminal message is forwarded at the end.
 *
 * When `onDroppedAttempt` is supplied, the wrapper reports each dropped attempt's
 * terminal message to it. An exhausted request's error keeps the final attempt's
 * provider usage.
 */
export function withEmptyResponseRetry(
  inner: StreamFunction,
  deps: {
    log?: (message: string) => void;
    maxRetries?: number;
    onDroppedAttempt?: (message: AssistantMessage) => void;
  } = {},
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
        if (!Array.isArray(terminal.content) && hasNoContentBlocks(terminal)) {
          terminal.content = [];
        }
        if (
          !forwarded &&
          hasNoContentBlocks(terminal) &&
          terminal.usage?.output === 0 &&
          !isPiRecoveryCandidate(terminal, model)
        ) {
          if (retries >= maxRetries) {
            const message: AssistantMessage & {
              [EMPTY_RESPONSE_EXHAUSTED]: EmptyResponseExhaustion;
            } = {
              ...terminal,
              content: [],
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
          try {
            deps.onDroppedAttempt?.(terminal);
          } catch (err) {
            log(
              `bob: onDroppedAttempt failed: ${err instanceof Error ? err.message : String(err)}`,
            );
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
