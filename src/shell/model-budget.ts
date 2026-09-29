// bob#214 — the model's budget: its context window, its output cap, when to
// compact, and how much to think.
//
// What pi already has, and bob configures rather than reimplements:
//   * the COMPACTION trigger — pi's `shouldCompact(tokens, window, settings)` is
//     `tokens > window - reserveTokens`, and `reserveTokens` is a pi setting. A
//     threshold of 0.5 is therefore `reserveTokens = window - floor(window * 0.5)`
//     in the session's in-memory settings (`compactionSettingsFor`);
//   * the COMPACTION itself — pi's own threshold path (`_checkCompaction` →
//     `_runAutoCompaction`), with its events, session entries, extension hooks
//     and retry settings. bob never summarizes anything itself;
//   * the THINKING level — pi's session option `thinkingLevel`, which pi clamps
//     to what the model declares and hands each provider in that provider's own
//     request shape;
//   * the OUTPUT cap — pi sends `maxTokens` (clamped to the room left in the
//     window) on every request, from the model's `maxTokens`.
//
// What pi lacks, and bob adds as small hooks on pi's public surfaces:
//   * a RUNTIME override of a model's context window / output cap. pi reads them
//     from models.json or its catalog; bob wraps the model runtime's `getModel`
//     so the configured pair always resolves with the configured numbers
//     (`applyModelLimits`), including after pi refreshes the session's model;
//   * a compaction check BETWEEN MODEL CALLS. pi checks only when an agent run
//     ends (or before the next prompt), so a long single-prompt run grows to the
//     server's limit before it compacts. pi-agent-core's documented
//     `shouldStopAfterTurn` hook ("request a graceful stop after the current turn,
//     e.g. before context gets too full") ends the low-level loop at a turn
//     boundary; pi's own post-run handler then runs its threshold compaction, and
//     the steer bob queued before stopping makes pi continue the run
//     (`installMidRunCompaction`);
//   * ENFORCING the output cap when a provider ignores it. bob wraps the agent's
//     stream function and ends a stream whose streamed deltas exceed the cap pi
//     sent (`capOutputStream`).

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { calculateContextTokens, shouldCompact } from "@earendil-works/pi-coding-agent";
import { ModelBudgetError, type ModelLimits, PI_KEEP_RECENT_TOKENS } from "./session-budget.js";

export {
  ModelBudgetError,
  type ModelLimits,
  PI_KEEP_RECENT_TOKENS,
  parseCompactionThreshold,
  parseSessionBudget,
  parseThinkingSetting,
  positiveTokens,
  SESSION_BUDGET_KEYS,
  type SessionBudget,
  THINKING_SETTINGS,
  type ThinkingSetting,
} from "./session-budget.js";

/**
 * pi's compaction settings for a threshold: pi compacts when
 * `contextTokens > window - reserveTokens`, so the threshold IS the reserve.
 * Refuses a threshold whose token count is at or below the tokens pi keeps
 * verbatim after a compaction (it could not shrink the context).
 */
export function compactionSettingsFor(
  contextWindow: number,
  threshold: number,
): { reserveTokens: number; thresholdTokens: number } {
  const thresholdTokens = Math.floor(contextWindow * threshold);
  if (thresholdTokens <= PI_KEEP_RECENT_TOKENS) {
    throw new ModelBudgetError(
      `bob: compaction_threshold ${threshold} of a ${contextWindow}-token context window is ${thresholdTokens} tokens, at or below the ${PI_KEEP_RECENT_TOKENS} tokens pi keeps verbatim after a compaction — a compaction could not shrink the context. Remedy: raise session.compaction_threshold (bob.yaml) or check provider.context_window.`,
    );
  }
  return { reserveTokens: contextWindow - thresholdTokens, thresholdTokens };
}

/**
 * The session's model must have a declared window, and the declaration must
 * describe the pair the session runs. Returns the limits; throws a named
 * refusal otherwise. There is no default: a window bob guessed can disagree
 * with the server, which is the defect this exists for.
 */
export function requireModelLimits(input: {
  provider: string;
  model: string;
  limits: ModelLimits | undefined;
  bobYamlPath: string;
}): ModelLimits {
  const { limits } = input;
  if (limits === undefined) {
    throw new ModelBudgetError(
      `bob: refusing to start a session for ${input.provider}/${input.model} without a declared context window — bob does not guess it (a model default can disagree with the server). Remedy: add "context_window: <tokens>" under "provider:" in ${input.bobYamlPath}, set to the context length the server enforces for this model.`,
    );
  }
  if (limits.provider !== input.provider || limits.model !== input.model) {
    throw new ModelBudgetError(
      `bob: the context window in ${input.bobYamlPath} (provider.context_window) describes ${limits.provider}/${limits.model}, but this session runs ${input.provider}/${input.model}. Remedy: set provider.name, provider.model and provider.context_window in bob.yaml to the model this session runs.`,
    );
  }
  if (limits.maxOutputTokens !== undefined && limits.maxOutputTokens >= limits.contextWindow) {
    throw new ModelBudgetError(
      `bob: provider.max_output_tokens (${limits.maxOutputTokens}) must be smaller than provider.context_window (${limits.contextWindow}) in ${input.bobYamlPath}.`,
    );
  }
  return limits;
}

/** The structural slice of pi's ModelRuntime this module wraps. */
interface ModelLookup {
  getModel(provider: string, modelId: string): unknown;
}

const LIMITS_MARK = Symbol.for("bob.modelLimits");

/**
 * Make the configured pair resolve with the configured window (and output cap)
 * everywhere pi looks it up: session creation, a restored session, and pi's
 * refresh after an extension registers a provider. Wraps the runtime's
 * `getModel` once; a second call replaces the limits it applies.
 */
export function applyModelLimits(runtime: object, limits: ModelLimits): void {
  const target = runtime as ModelLookup & { [LIMITS_MARK]?: { limits: ModelLimits } };
  const existing = target[LIMITS_MARK];
  if (existing) {
    existing.limits = limits;
    return;
  }
  const state = { limits };
  target[LIMITS_MARK] = state;
  const original = target.getModel.bind(target);
  target.getModel = (provider: string, modelId: string) => {
    const model = original(provider, modelId);
    const l = state.limits;
    if (model === undefined || model === null || provider !== l.provider || modelId !== l.model) {
      return model;
    }
    return {
      ...(model as object),
      contextWindow: l.contextWindow,
      ...(l.maxOutputTokens !== undefined ? { maxTokens: l.maxOutputTokens } : {}),
    };
  };
}

// ─── Compaction between model calls ─────────────────────────────────────────

/** The steer bob queues when it ends the low-level loop for a compaction. It is
 *  what makes pi CONTINUE the run after its post-run compaction (pi continues
 *  when a message is queued), so it states plainly that the task is not over. */
export function checkpointText(input: {
  contextTokens: number;
  thresholdTokens: number;
  contextWindow: number;
}): string {
  return [
    "[BOB CONTEXT CHECKPOINT — the context was compacted between model calls]",
    `The conversation reached ${input.contextTokens} tokens, over this session's compaction threshold (${input.thresholdTokens} of a ${input.contextWindow}-token context window).`,
    "This is not the end of the task. Continue from the state above.",
  ].join("\n");
}

/** What the mid-run check needs from a pi AgentSession (structural, so a test
 *  can drive it without pi). */
export interface MidRunCompactionSession {
  agent: {
    shouldStopAfterTurn?: (
      context: StopAfterTurnContext,
      signal?: AbortSignal,
    ) => boolean | Promise<boolean>;
  };
  settingsManager: {
    getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  };
  readonly model: { contextWindow?: number } | undefined;
  steer(text: string): Promise<void>;
  subscribe(listener: (event: never) => void): () => void;
}

/** The fields of pi-agent-core's ShouldStopAfterTurnContext this reads. */
export interface StopAfterTurnContext {
  message: {
    stopReason?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
  };
  toolResults: ReadonlyArray<unknown>;
}

/**
 * Check the compaction threshold BETWEEN model calls. After every turn that
 * ended in tool calls (the loop would otherwise make another model call), the
 * last response's context size — pi's own `calculateContextTokens` on its
 * usage — is compared with pi's own `shouldCompact` under the session's live
 * compaction settings. Over the threshold, bob queues a steer (the checkpoint)
 * and ends the low-level loop; pi's post-run handler then runs its threshold
 * compaction on that same message and, because a message is queued, continues
 * the run with it.
 *
 * Fails SAFE, i.e. toward pi's unchanged behaviour: if the steer cannot be
 * queued, or the hook itself throws, the loop is NOT stopped. If pi did not
 * compact after a checkpoint (it declined, or the compaction failed), further
 * checkpoints are off until a compaction succeeds, so a failing compaction is
 * not retried on every turn.
 */
export function installMidRunCompaction(
  session: MidRunCompactionSession,
  deps: { log?: (message: string) => void } = {},
): () => void {
  const log = deps.log ?? (() => {});
  // idle: may checkpoint; stopped: a checkpoint is waiting for pi's compaction;
  // suppressed: pi did not compact after the last checkpoint.
  let state: "idle" | "stopped" | "suppressed" = "idle";
  const unsubscribe = session.subscribe(((event: { type?: string; result?: unknown }) => {
    if (event?.type !== "compaction_end") return;
    if (event.result !== undefined) {
      state = "idle";
    } else if (state === "stopped") {
      state = "suppressed";
      log(
        "bob: the compaction after a context checkpoint did not complete; mid-run checkpoints are off until a compaction succeeds",
      );
    }
  }) as never);

  const previous = session.agent.shouldStopAfterTurn;
  session.agent.shouldStopAfterTurn = async (context, signal) => {
    if (previous && (await previous(context, signal))) return true;
    try {
      if (context.message.stopReason !== "toolUse" || context.toolResults.length === 0) {
        return false; // the loop ends here anyway; pi checks at agent end
      }
      if (state === "stopped") {
        // No compaction_end since the last checkpoint: pi declined to compact.
        state = "suppressed";
        log(
          "bob: pi did not compact after a context checkpoint; mid-run checkpoints are off until a compaction succeeds",
        );
        return false;
      }
      if (state === "suppressed") return false;
      const settings = session.settingsManager.getCompactionSettings();
      const contextWindow = session.model?.contextWindow ?? 0;
      const usage = context.message.usage;
      if (!settings.enabled || contextWindow <= 0 || usage === undefined) return false;
      const contextTokens = calculateContextTokens(usage as never);
      if (contextTokens <= 0 || !shouldCompact(contextTokens, contextWindow, settings)) {
        return false;
      }
      const thresholdTokens = contextWindow - settings.reserveTokens;
      // Queue the continuation FIRST: a stop without a queued message would end
      // the run after pi's compaction. A steer that cannot be queued means no stop.
      await session.steer(checkpointText({ contextTokens, thresholdTokens, contextWindow }));
      state = "stopped";
      log(
        `bob: context ${contextTokens} tokens is over the compaction threshold (${thresholdTokens} of ${contextWindow}); compacting between model calls`,
      );
      return true;
    } catch (err) {
      log(
        `bob: the mid-run compaction check failed (${err instanceof Error ? err.message : String(err)}); the run continues and pi checks again when it ends`,
      );
      return false;
    }
  };
  return () => {
    unsubscribe();
    session.agent.shouldStopAfterTurn = previous;
  };
}

// ─── Output cap enforcement ────────────────────────────────────────────────

/** pi's stream-function shape (pi-agent-core StreamFn), derived from the
 *  session so bob does not import pi-agent-core directly. */
export type StreamFunction = AgentSession["agent"]["streamFunction"];

/** Marker bob sets on a message whose stream it ended at the output cap. */
export const OUTPUT_CAP_MARK = "bobOutputCap";

/** Delta events that carry generated output. */
function isOutputDelta(
  event: AssistantMessageEvent,
): event is Extract<AssistantMessageEvent, { delta: string }> {
  return (
    (event.type === "text_delta" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_delta") &&
    typeof event.delta === "string" &&
    event.delta.length > 0
  );
}

/**
 * The output cap pi sends for this request: the caller's `maxTokens`, else the
 * model's, clamped to the room left in the window — pi-ai's own
 * `clampMaxTokensToContext`, applied to the same inputs its providers use.
 * Undefined when no positive cap applies (then pi sends none and bob enforces
 * none).
 */
export function effectiveOutputCap(
  model: Parameters<StreamFunction>[0],
  context: Parameters<StreamFunction>[1],
  options: Parameters<StreamFunction>[2],
): number | undefined {
  const requested = options?.maxTokens ?? model.maxTokens;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return undefined;
  }
  const cap = clampMaxTokensToContext(model, context, requested);
  return Number.isFinite(cap) && cap > 0 ? cap : undefined;
}

/**
 * Enforce the output cap on the stream itself. pi sends the cap
 * (`max_completion_tokens`/`max_tokens` on the OpenAI-compatible path); a
 * server that ignores it keeps streaming. bob counts the streamed output deltas
 * (text, thinking and tool-call deltas with content) and, once more than `cap`
 * of them have arrived, aborts the request and ends the message with
 * stopReason "length" — the same outcome as a server that honoured the cap.
 *
 * Each streamed delta carries at least one token, so the count is a LOWER
 * bound on the tokens generated: a stream is cut only once it has provably
 * exceeded the cap, never early. (A server that packs several tokens into one
 * chunk is cut later than its cap — at most at `cap` chunks.)
 *
 * The cut message is a copy of the stream's last partial, without the one
 * delta that crossed the cap, with `usage.output` set to the cap (the tokens
 * delivered) and OUTPUT_CAP_MARK set, so the run log can say bob cut it.
 */
export function capOutputStream(
  inner: StreamFunction,
  deps: { log?: (message: string) => void } = {},
): StreamFunction {
  const log = deps.log ?? (() => {});
  const wrapped = async (
    model: Parameters<StreamFunction>[0],
    context: Parameters<StreamFunction>[1],
    options?: Parameters<StreamFunction>[2],
  ): Promise<AssistantMessageEventStream> => {
    const cap = effectiveOutputCap(model, context, options);
    if (cap === undefined) return await inner(model, context, options);

    // bob's own abort, linked to the caller's: the caller aborting still aborts
    // the request, and the cap can abort it without touching the caller's signal.
    const controller = new AbortController();
    const upstream = options?.signal;
    if (upstream) {
      if (upstream.aborted) controller.abort(upstream.reason);
      else
        upstream.addEventListener("abort", () => controller.abort(upstream.reason), { once: true });
    }
    const source = await inner(model, context, { ...options, signal: controller.signal });
    const out = createAssistantMessageEventStream();

    void (async () => {
      let deltas = 0;
      try {
        for await (const event of source) {
          if (isOutputDelta(event)) {
            deltas += 1;
            if (deltas > cap) {
              const message = cutMessage(event, cap);
              controller.abort(new Error(`bob: output cap of ${cap} tokens reached`));
              log(
                `bob: the provider streamed past the ${cap}-token output cap it was sent; bob ended the stream (stopReason "length")`,
              );
              out.push({ type: "done", reason: "length", message });
              out.end(message);
              return;
            }
          }
          out.push(event);
          if (event.type === "done") {
            out.end(event.message);
            return;
          }
          if (event.type === "error") {
            out.end(event.error);
            return;
          }
        }
        out.end(await source.result());
      } catch (err) {
        // The source failed outside its own event contract: end with an error
        // message rather than leaving the caller waiting.
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        out.push({ type: "error", reason: "error", error: message });
        out.end(message);
      }
    })();
    return out;
  };
  return wrapped as StreamFunction;
}

/** The message a cut stream ends with: a copy of the last partial, minus the
 *  delta that crossed the cap (text and thinking blocks; a tool call cut by a
 *  length stop is failed by pi anyway). */
function cutMessage(
  event: Extract<AssistantMessageEvent, { delta: string }>,
  cap: number,
): AssistantMessage {
  const partial = event.partial;
  const content = partial.content.map((block, index) => {
    if (index !== event.contentIndex) return { ...block };
    if (block.type === "text" && block.text.endsWith(event.delta)) {
      return { ...block, text: block.text.slice(0, block.text.length - event.delta.length) };
    }
    if (block.type === "thinking" && block.thinking.endsWith(event.delta)) {
      return {
        ...block,
        thinking: block.thinking.slice(0, block.thinking.length - event.delta.length),
      };
    }
    return { ...block };
  });
  const usage = { ...partial.usage, cost: { ...partial.usage.cost } };
  usage.output = cap;
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return {
    ...partial,
    content,
    usage,
    stopReason: "length",
    [OUTPUT_CAP_MARK]: true,
  } as AssistantMessage;
}
