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
//     window) on every request, from the model's `maxTokens`. That token count,
//     sent to the server, is the cap.
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
//   * a BACKSTOP for a provider that ignores the output cap. bob wraps the
//     agent's stream function and ends a stream after more streamed pieces than
//     the token cap pi sent (`capOutputStream`). It counts pieces, not tokens:
//     never early, possibly late (see there).

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  parseStreamingJson,
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
 *
 * The remedy names the key that would declare THIS pair, from bob.yaml's own
 * provider/model (`yamlModel`, pi's provider id): `provider.context_window` for
 * bob.yaml's provider.model; a `provider.models` entry with the model's id for
 * any other model on that provider (a `--model` override); and, for a different
 * provider, that bob.yaml declares windows for its own provider only.
 */
export function requireModelLimits(input: {
  provider: string;
  model: string;
  limits: ModelLimits | undefined;
  bobYamlPath: string;
  /** bob.yaml's own provider (pi's id) and provider.model, when known. */
  yamlModel?: { provider: string; model: string };
}): ModelLimits {
  const { limits, yamlModel } = input;
  const pair = `${input.provider}/${input.model}`;
  if (limits === undefined) {
    const refusal = `bob: refusing to start a session for ${pair} without a declared context window — bob does not guess it (a model default can disagree with the server).`;
    const window = `set to the context length the server enforces for ${input.model}`;
    let remedy: string;
    if (yamlModel !== undefined && yamlModel.provider !== input.provider) {
      remedy = `${input.bobYamlPath} declares context windows only for its own provider, ${yamlModel.provider} (provider.name); this session runs ${input.provider}. Run on bob.yaml's provider, or set provider.name, provider.model and provider.context_window in bob.yaml to the pair this session runs.`;
    } else if (yamlModel !== undefined && yamlModel.model !== input.model) {
      remedy = `${input.model} is not bob.yaml's provider.model (${yamlModel.model}), so its window is a provider.models entry. Add one under "provider:" in ${input.bobYamlPath}: "models:", then "- id: ${input.model}" with "context_window: <tokens>", ${window}.`;
    } else if (yamlModel !== undefined) {
      remedy = `add "context_window: <tokens>" under "provider:" in ${input.bobYamlPath}, ${window}.`;
    } else {
      remedy = `in ${input.bobYamlPath}, add "context_window: <tokens>" under "provider:" when ${input.model} is provider.model, otherwise a provider.models entry ("- id: ${input.model}" with "context_window: <tokens>"), ${window}.`;
    }
    throw new ModelBudgetError(`${refusal} Remedy: ${remedy}`);
  }
  if (limits.provider !== input.provider || limits.model !== input.model) {
    // Unreachable from bob's entry paths, which resolve the limits for the pair
    // they run; a caller that changes provider/model after resolving is refused.
    throw new ModelBudgetError(
      `bob: the declared context window this session was given describes ${limits.provider}/${limits.model}, but this session runs ${pair}. Remedy: resolve the session's config for the model it runs (the way \`bob run --model\` does) instead of changing provider or model afterwards.`,
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
 *
 * After a checkpoint, the check does not checkpoint again for the same
 * threshold until it sees the context at or below that threshold. A compaction
 * can succeed yet leave the context over the threshold; without this rule, each
 * following tool turn whose usage is still over the threshold would queue
 * another checkpoint, and pi would compact again after each one. Two things
 * re-arm the check: a tool turn evaluated here whose reported usage is at or
 * below the threshold, and a successful compaction whose `estimatedTokensAfter`
 * is at or below the current threshold. A compaction result with no usable
 * estimate, or an estimate above the threshold, leaves the check suppressed.
 *
 * Limits: pi's estimate counts the session's messages, not the system prompt or
 * the tool definitions, so a compaction estimated at or below the threshold can
 * be followed by a tool turn whose reported usage is over it; that turn
 * checkpoints again. While the check is suppressed, the context can keep growing
 * past the threshold until pi's own compaction check when the run ends (or its
 * overflow recovery).
 */
export function installMidRunCompaction(
  session: MidRunCompactionSession,
  deps: { log?: (message: string) => void } = {},
): () => void {
  const log = deps.log ?? (() => {});
  // idle: may checkpoint; stopped: a checkpoint is waiting for pi's compaction;
  // suppressed: pi did not compact after the last checkpoint.
  let state: "idle" | "stopped" | "suppressed" = "idle";
  // The threshold the last checkpoint fired for, until the check sees the
  // context at or below it (see the note above). While it is set, a tool turn
  // over that same threshold does not checkpoint again.
  let checkpointedThreshold: number | null = null;
  let suppressLogged = false;
  // Whether a successful compaction's result puts the context at or below the
  // CURRENT threshold, by pi's own post-compaction estimate
  // (`estimatedTokensAfter`). An estimate above the threshold, a missing or
  // non-numeric one, or a threshold that cannot be computed is "not known to be
  // below": the suppression stays.
  const compactedAtOrBelowThreshold = (result: unknown): boolean => {
    try {
      const after =
        result !== null && typeof result === "object"
          ? (result as { estimatedTokensAfter?: unknown }).estimatedTokensAfter
          : undefined;
      if (typeof after !== "number" || !Number.isFinite(after) || after < 0) return false;
      const contextWindow = session.model?.contextWindow ?? 0;
      if (contextWindow <= 0) return false;
      const { reserveTokens } = session.settingsManager.getCompactionSettings();
      return after <= contextWindow - reserveTokens;
    } catch {
      return false;
    }
  };
  const unsubscribe = session.subscribe(((event: { type?: string; result?: unknown }) => {
    if (event?.type !== "compaction_end") return;
    if (event.result !== undefined) {
      state = "idle";
      if (compactedAtOrBelowThreshold(event.result)) {
        // pi's estimate of the compacted context is at or below the threshold:
        // the compaction itself brought the context under it, so re-arm.
        checkpointedThreshold = null;
        suppressLogged = false;
      }
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
      const thresholdTokens = contextWindow - settings.reserveTokens;
      if (contextTokens <= 0 || !shouldCompact(contextTokens, contextWindow, settings)) {
        // At or below the threshold: re-arm, so a later tool turn over it may
        // checkpoint again.
        checkpointedThreshold = null;
        suppressLogged = false;
        return false;
      }
      if (checkpointedThreshold === thresholdTokens) {
        // A checkpoint already fired for this threshold. Reaching here means a
        // compaction succeeded since (a failed or declined one returns above),
        // but neither its estimate nor a later tool turn's usage has been at or
        // below the threshold. Do not checkpoint again yet.
        if (!suppressLogged) {
          suppressLogged = true;
          log(
            `bob: the context is still over the compaction threshold (${thresholdTokens} of ${contextWindow}) after a checkpoint and a compaction; not checkpointing again until a tool turn's usage or a compaction's estimate is at or below it (pi still checks when the run ends)`,
          );
        }
        return false;
      }
      // Queue the continuation FIRST: a stop without a queued message would end
      // the run after pi's compaction. A steer that cannot be queued means no stop.
      await session.steer(checkpointText({ contextTokens, thresholdTokens, contextWindow }));
      checkpointedThreshold = thresholdTokens;
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

// ─── Output cap backstop ────────────────────────────────────────────────────

/** pi's stream-function shape (pi-agent-core StreamFn), derived from the
 *  session so bob does not import pi-agent-core directly. */
export type StreamFunction = AgentSession["agent"]["streamFunction"];

/** Marker bob sets on a message whose stream its backstop ended. */
export const OUTPUT_CAP_MARK = "bobOutputCap";

/** A delta event that carries generated output: one streamed PIECE. */
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
 * The output cap pi sends for this request, in tokens: the caller's
 * `maxTokens`, else the model's, clamped to the room left in the window —
 * pi-ai's own `clampMaxTokensToContext`, applied to the same inputs its
 * providers use. Undefined when no positive cap applies (then pi sends none and
 * bob's backstop does nothing).
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
 * A BACKSTOP for a server that ignores the output cap it was sent. The cap is
 * the token count pi SENDS (`max_completion_tokens`/`max_tokens` on the
 * OpenAI-compatible path); a server that honours it stops there, and this never
 * fires. bob cannot count tokens in a stream, so the backstop counts streamed
 * PIECES (text, thinking and tool-call deltas with content) and, once more
 * pieces than the token cap have arrived, aborts the request and ends the
 * message with stopReason "length".
 *
 * Pieces are not tokens. A streaming server sends a piece only after it has
 * generated at least one token, so the backstop is never early: more pieces
 * than the cap means more tokens than the cap. It can be late: a piece that
 * carries several tokens counts once, so a server that packs tokens into pieces
 * is ended past its cap, or not at all when its whole answer arrives in no more
 * pieces than the cap. (A server or proxy that split one token across pieces
 * would break the "never early" premise; bob does not tokenize, so it cannot
 * detect that.)
 *
 * What the wrapper forwards is built from the pieces it accepted, never copied
 * from pi-ai's shared partial: pi-ai emits every event with ONE mutable partial
 * message, and events queue ahead of their reader, so by the time an event is
 * read the partial can already hold output from later events — past the cut.
 * The wrapper therefore keeps its own message (`acceptedMessage`), forwards it
 * as each event's `partial`, and ends a cut stream with a copy of it: text and
 * thinking from accepted pieces, tool-call arguments parsed from accepted
 * pieces. OUTPUT_CAP_MARK is set so the run log can say bob cut it.
 *
 * The cut message's usage is ASSIGNED, not measured: the server's final count
 * never arrives, and bob does not count tokens. `usage.output` is the cap — by
 * the premise above a lower bound on the tokens the kept pieces carry — because
 * pi reads it to tell a length stop AT the requested cap (kept, as from a server
 * that honoured it) from one cut short by context pressure, which pi answers by
 * dropping the message, compacting and retrying (`isRecoverableLength`). The
 * prompt counts are 0 (unknown).
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
    // the request, and the backstop can abort it without touching the caller's
    // signal.
    const controller = new AbortController();
    const upstream = options?.signal;
    if (upstream) {
      if (upstream.aborted) controller.abort(upstream.reason);
      else
        upstream.addEventListener("abort", () => controller.abort(upstream.reason), { once: true });
    }
    const source = await inner(model, context, { ...options, signal: controller.signal });
    const out = createAssistantMessageEventStream();
    const accepted = acceptedMessage(model);

    void (async () => {
      let pieces = 0;
      try {
        for await (const event of source) {
          if (isOutputDelta(event)) {
            pieces += 1;
            if (pieces > cap) {
              // The piece that crossed the cap is neither applied nor forwarded.
              const message = accepted.cut(cap);
              controller.abort(new Error(`bob: output backstop: more than ${cap} streamed pieces`));
              log(
                `bob: the provider streamed more than ${cap} pieces against the ${cap}-token output cap it was sent; bob ended the stream (stopReason "length")`,
              );
              out.push({ type: "done", reason: "length", message });
              out.end(message);
              return;
            }
          }
          out.push(accepted.forward(event));
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
          usage: noUsage(),
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

function noUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type Block = AssistantMessage["content"][number];

/** A block's IDENTITY — the fields that name it, never its generated output —
 *  whitelisted per type. */
function identityOf(live: unknown, type: Block["type"]): Record<string, unknown> {
  const b = (live ?? {}) as Record<string, unknown>;
  const keys =
    type === "text"
      ? ["textSignature"]
      : type === "thinking"
        ? ["thinkingSignature", "redacted"]
        : ["id", "name", "thoughtSignature", "namespace"];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

/**
 * The message the backstop owns: the output it has ACCEPTED, and nothing else.
 *
 * Built only from each event's own values — a delta string, a `*_end` event's
 * final text, a finished tool call — in the order the wrapper forwards them.
 * The only reads of pi-ai's shared partial are a block's IDENTITY when an event
 * introduces or ends that block (a tool call's id and name, a signature), and
 * the request's start time on `start`; never its text, thinking or arguments.
 * The one object is forwarded as every event's `partial`, as pi-ai does with its
 * own, so a listener can be ahead of the event it handles but never sees a piece
 * the wrapper did not forward.
 */
function acceptedMessage(model: Parameters<StreamFunction>[0]): {
  forward(event: AssistantMessageEvent): AssistantMessageEvent;
  cut(cap: number): AssistantMessage;
} {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: noUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  // The accepted argument text of each tool call, by content index.
  const toolArgs = new Map<number, string>();
  const liveBlock = (event: { partial: AssistantMessage; contentIndex: number }): unknown =>
    event.partial?.content?.[event.contentIndex];

  const at = <T extends Block["type"]>(
    index: number,
    type: T,
  ): Extract<Block, { type: T }> | undefined => {
    const b = message.content[index];
    return b?.type === type ? (b as Extract<Block, { type: T }>) : undefined;
  };
  const text = (index: number, live: unknown) => {
    const existing = at(index, "text");
    if (existing) return existing;
    const block = { ...identityOf(live, "text"), type: "text", text: "" } as Extract<
      Block,
      { type: "text" }
    >;
    message.content[index] = block;
    return block;
  };
  const thinking = (index: number, live: unknown) => {
    const existing = at(index, "thinking");
    if (existing) return existing;
    const block = { ...identityOf(live, "thinking"), type: "thinking", thinking: "" } as Extract<
      Block,
      { type: "thinking" }
    >;
    message.content[index] = block;
    return block;
  };
  const toolCall = (index: number, live: unknown) => {
    const existing = at(index, "toolCall");
    if (existing) {
      // A call's id and name can arrive after its first piece; identity only.
      const id = identityOf(live, "toolCall");
      if (!existing.id && typeof id.id === "string") existing.id = id.id;
      if (!existing.name && typeof id.name === "string") existing.name = id.name;
      return existing;
    }
    toolArgs.set(index, "");
    const block = {
      id: "",
      name: "",
      ...identityOf(live, "toolCall"),
      type: "toolCall",
      arguments: {},
    } as Extract<Block, { type: "toolCall" }>;
    message.content[index] = block;
    return block;
  };

  return {
    forward(event) {
      switch (event.type) {
        case "start":
          // The request's start time, stamped once by the provider when it
          // creates the message (the usage record measures from it).
          if (typeof event.partial?.timestamp === "number") {
            message.timestamp = event.partial.timestamp;
          }
          break;
        case "text_start":
          text(event.contentIndex, liveBlock(event));
          break;
        case "text_delta":
          text(event.contentIndex, liveBlock(event)).text += event.delta;
          break;
        case "text_end":
          message.content[event.contentIndex] = {
            ...identityOf(liveBlock(event), "text"),
            type: "text",
            text: event.content,
          } as Block;
          break;
        case "thinking_start":
          thinking(event.contentIndex, liveBlock(event));
          break;
        case "thinking_delta":
          thinking(event.contentIndex, liveBlock(event)).thinking += event.delta;
          break;
        case "thinking_end":
          message.content[event.contentIndex] = {
            ...identityOf(liveBlock(event), "thinking"),
            type: "thinking",
            thinking: event.content,
          } as Block;
          break;
        case "toolcall_start":
          toolCall(event.contentIndex, liveBlock(event));
          break;
        case "toolcall_delta": {
          const block = toolCall(event.contentIndex, liveBlock(event));
          const args = (toolArgs.get(event.contentIndex) ?? "") + event.delta;
          toolArgs.set(event.contentIndex, args);
          block.arguments = parseStreamingJson(args);
          break;
        }
        case "toolcall_end":
          // The finished call, as the event itself carries it.
          message.content[event.contentIndex] = {
            ...identityOf(event.toolCall, "toolCall"),
            type: "toolCall",
            arguments: structuredClone(event.toolCall.arguments ?? {}),
          } as Block;
          break;
        default:
          // done / error carry the provider's own final message: forwarded as is.
          return event;
      }
      return { ...event, partial: message };
    },
    cut(cap) {
      // A copy, so the final message shares nothing with the forwarded partial.
      const content = structuredClone(message.content.filter((b) => b !== undefined));
      // Assigned, not measured: see capOutputStream.
      return {
        ...message,
        content,
        usage: { ...noUsage(), output: cap, totalTokens: cap },
        stopReason: "length",
        [OUTPUT_CAP_MARK]: true,
      } as AssistantMessage;
    },
  };
}
