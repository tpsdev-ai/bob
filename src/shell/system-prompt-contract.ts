// The #145 contract, living in the SYSTEM PROMPT.
//
// A bob run that hit pi's threshold compaction used to lose its own plan: the
// task lived in the message history, compaction rewrote that history, and the
// run then settled `exitCode 0` with the work uncommitted and no final message
// — indistinguishable from a clean completion. Rounds 8-11 of #150 each gated
// one more of pi's turn paths from the outside (a rejected steer, a late
// rejection, an await before the act, Discord intake, pi's sendMessage with
// triggerTurn, streaming steer/followUp, a compaction inside an admitted
// prompt) and pi kept having more paths.
//
// The root cause was WHERE the contract lived. This module puts it where
// compaction cannot reach it: the system prompt. pi rebuilds the agent's system
// prompt from the resource loader (its appendSystemPrompt) when it creates the
// session, on every reload, and whenever the ACTIVE TOOL SET changes — a
// capability's `setActiveTools` in a `session_start` handler, or the resource
// paths a capability discovers on a bind or a reload (pi 0.84.3:
// core/agent-session.js `_rebuildSystemPrompt`, called from `_buildRuntime`
// (creation and reload), from `setActiveToolsByName`, and from
// `extendResourcesFromExtensions`). A bind is not a rebuild of its own: it
// rebuilds only through one of those. Rebuilds read the loader's append text as
// it is configured now, so the appended block is IDENTICAL across every rebuild
// of a session — the loader override that returns it is the same one. And
// compaction replaces only the message history (core/compaction/* rewrites
// session entries, never the loader).
//
// So:
//
//   1. the one-shot task (bob run) or the persistent runtime's standing contract
//      (role + duties) is appended to the system prompt as LITERAL TEXT through
//      the loader's `appendSystemPromptOverride` — NEVER as an `appendSystemPrompt`
//      source (pi reads a source string that matches an existing path as a FILE:
//      core/resource-loader.js `resolvePromptInput`), bounded by a cap with a
//      visible truncation marker;
//   2. bob's guard is registered LAST on `before_provider_request`, so it sees
//      the payload after every other capability has had its turn: an agent
//      response request whose payload does not carry the contract fails the
//      turn exactly like a failed audit — dispose the session, end the
//      process, and name the reason. A capability can still replace the prompt
//      per turn (`before_agent_start` returning `systemPrompt`) or rewrite the
//      outgoing provider payload (`before_provider_request`), both AFTER the
//      factory's creation/reload audit, so the request itself is the last
//      place the guarantee can be checked. The check does NOT parse provider
//      payload shapes: layouts differ per API and change between pi releases,
//      and a reader that knows a few of them fails a legitimate request the
//      moment a provider differs. It asks whether the SERIALIZED payload
//      contains the block verbatim (systemPromptFromRequestPayload used to read
//      a few shapes and missed the Responses APIs' `input` and Google's
//      `config.systemInstruction` outright — round 2);
//   3. the guarantee is stated for AGENT RESPONSE requests, and in pi 0.84.3
//      that is also all the hook sees: the agent turn's `onPayload` is attached
//      to the agent's own requests, while pi's compaction and branch-summary
//      calls pass the stream function their OWN options (apiKey/headers/…, no
//      onPayload), so pi's summaries never reach `before_provider_request` at
//      all — proven live. They are excluded anyway, on pi's own
//      `AgentSession.isCompacting` flag, as insurance for a pi that DOES route
//      them through the hook: without it such a request (which carries pi's
//      summarization prompt, never the contract) would dispose the session and
//      end the process. The exemption is the FLAG and never a string in the
//      payload — an exemption keyed on a marker in the prompt can be borrowed by
//      anything that pastes the marker in while dropping the contract (round
//      2's defect), and pi's full summarization prompt is no better, since it is
//      still text a capability can reproduce. pi refuses a new prompt while a
//      compaction is running, so no agent request can enter that window.

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** Cap on the appended contract block, in characters. It bounds the block's
 *  SIZE — a per-run system prompt is sent with every request, so the contract
 *  is a real token cost, and the cap is what keeps that cost bounded and
 *  visible (the header names it). */
export const DEFAULT_CONTRACT_CAP_CHARS = 6000;

/** The smallest cap the block may be given: below this it cannot carry its
 *  skeleton plus any of the contract, so a smaller cap is REFUSED rather than
 *  silently producing a block with no contract in it. */
export const MIN_CONTRACT_CAP_CHARS = 512;

/** The literal text that marks the appended contract block. It is part of the
 *  block's fixed skeleton, so it is never the part a cap truncates — which is
 *  what lets the guard and the tests look for ONE stable string. */
export const CONTRACT_SENTINEL_PREFIX = "[BOB ";

export type ContractLabel = "TASK" | "STANDING CONTRACT";

/** A cap is a finite number of characters and at least MIN_CONTRACT_CAP_CHARS.
 *  There is no "no cap": an uncapped contract is an unbounded prompt. */
export function assertContractCap(cap: unknown): number {
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap < MIN_CONTRACT_CAP_CHARS) {
    throw new Error(
      `bob: the system-prompt contract cap must be a finite number of characters and at least ${MIN_CONTRACT_CAP_CHARS} (got ${String(cap)}) — a smaller block cannot carry the contract, and there is no "no cap"`,
    );
  }
  return cap;
}

/** Truncate `text` to at most `cap` characters, marking the cut with HOW MANY
 *  characters were elided. The marker's own length moves the elided count and
 *  vice versa, so a few passes settle it (the digit count stabilises) and the
 *  result IS at most `cap` long. A cap too small for the marker cuts hard —
 *  there is no room to state anything. */
export function capContractText(text: string, cap: number): string {
  if (!Number.isFinite(cap) || cap <= 0) return "";
  if (text.length <= cap) return text;
  const markerFor = (elided: number): string => `\n… [truncated: ${elided} chars elided]`;
  let keep = Math.max(0, cap - markerFor(text.length).length);
  for (let i = 0; i < 4; i += 1) {
    const next = Math.max(0, cap - markerFor(text.length - keep).length);
    if (next === keep) break;
    keep = next;
  }
  const marker = markerFor(text.length - keep);
  if (keep <= 0) return text.slice(0, cap);
  return text.slice(0, keep) + marker;
}

/** Refuse a contract that says nothing. A blank task is not a task: the session
 *  would run with a contract block whose body is empty and whose guarantee is
 *  therefore meaningless. Refused HERE, before the block is built, so it cannot
 *  reach a session — and `bob run` refuses a blank prompt at its own boundary
 *  for the same reason. */
export function assertContractText(text: string | undefined, what: string): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error(
      `bob: refusing to start a session with a blank ${what} — the ${what} is carried in the system prompt for the whole session, and an empty one guarantees nothing`,
    );
  }
  return text as string;
}

/**
 * The literal block appended to the system prompt.
 *
 * The skeleton (heading, the sentence that says where this text lives, the
 * closing instruction) is FIXED and never the part a cap truncates; only the
 * contract text itself is budgeted, so a long task is cut with a visible marker
 * that says how much was elided — "the contract is present" stays decidable by
 * the sentinel even when the body was cut.
 */
export function buildContractBlock(opts: {
  label: ContractLabel;
  text: string;
  capChars?: number;
}): string {
  const cap = assertContractCap(opts.capChars ?? DEFAULT_CONTRACT_CAP_CHARS);
  const text = assertContractText(opts.text, opts.label === "TASK" ? "task" : "standing contract");
  const heading = `${CONTRACT_SENTINEL_PREFIX}${opts.label} — carried in the system prompt; a context compaction never removes it; cap ${cap} chars]`;
  const intro =
    opts.label === "TASK"
      ? "This is the task you were started with. It stays open until you end with a final message saying what you did: a context compaction is not completion."
      : "This is your standing contract. It stays in force for as long as you serve: a context compaction is not the end of your shift.";
  const footer =
    opts.label === "TASK"
      ? "Finish the task, then end with a final message describing the outcome (including any commit/push the task asked for)."
      : "Keep working your duties, and end a turn with a final message describing what you did.";
  // The variable body is budgeted against what the skeleton leaves, so the
  // whole block is at most `cap` and the heading is never the part that is cut.
  const skeleton = [heading, intro, "", "", "", footer].join("\n");
  const body = capContractText(text, Math.max(0, cap - skeleton.length));
  return [heading, intro, "", body, "", footer].join("\n");
}

/**
 * The loader override: append the contract block to whatever append-sources pi
 * resolved. It is called AFTER pi has turned its sources into text
 * (core/resource-loader.js: `this.appendSystemPromptOverride(baseAppend)`), so
 * the block returns as literal text and can never be re-read as a path.
 */
export function appendContractOverride(block: string): (base: string[]) => string[] {
  return (base: string[]) => [...base, block];
}

/**
 * The payload as the provider will send it: JSON text. Some adapters hand the
 * guard a body that is already a string, and then that text IS the
 * serialization. undefined when the payload cannot be serialized at all (a
 * cycle, a BigInt) — a payload the guard cannot read is a check it cannot
 * vouch for, never a pass.
 */
export function serializeRequestPayload(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload;
  if (payload === undefined) return undefined;
  try {
    return JSON.stringify(payload);
  } catch {
    return undefined;
  }
}

/** `text` as it appears INSIDE a JSON payload: `JSON.stringify` with its
 *  surrounding quotes removed. A block carried in a provider payload is escaped
 *  exactly this way, whatever the provider's layout. */
export function jsonEscapedRequestText(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/**
 * Whether a request payload carries `text` — the whole of the guard's check.
 *
 * It does NOT parse provider shapes. Payload layouts differ per API (pi-ai
 * 0.84.3: Anthropic's `system` blocks, OpenAI chat-completions' `messages`, the
 * Responses APIs' `input`/`instructions`, Google's `config.systemInstruction`,
 * Bedrock's `system`, Mistral's `messages`, Codex's `instructions`) and change
 * between pi releases, so a reader that knows a few of them fails a legitimate
 * request the moment a provider differs — which is exactly what a
 * shape-reading guard did to the Responses and Google layouts. The question it
 * can answer for EVERY layout is the one asked here: does the serialized
 * payload contain this text, verbatim? A capability that replaced or dropped
 * the system prompt removes the block from the payload entirely, which is the
 * capability loss this catches.
 */
export function payloadCarriesRequestText(payload: unknown, text: string): boolean {
  const serialized = serializeRequestPayload(payload);
  if (serialized === undefined) return false;
  return serialized.includes(text) || serialized.includes(jsonEscapedRequestText(text));
}

export type ContractVerdict =
  /** The request carries the contract, or is pi's own summarization call. */
  | { allowed: true; kind: "carries-contract" | "pi-summarization" }
  /** An AGENT RESPONSE request whose system prompt does not carry it. */
  | { allowed: false; reason: "contract_missing_from_system_prompt"; detail: string };

/**
 * The guard's decision for ONE outgoing provider request. Pure, so the guard
 * itself is a thin wiring layer and the decision is testable without pi.
 *
 * Order matters, and the first check is pi's own flag. WHILE PI IS COMPACTING
 * (`AgentSession.isCompacting`: threshold and overflow recovery, a manual
 * `/compact`, and branch summarization — pi 0.84.3 core/agent-session.js), the
 * only requests on the wire are pi's summarization calls: the agent is not
 * answering, and pi refuses a new prompt for the duration
 * ("Cannot submit a prompt while compaction is in progress"). Those calls are
 * passed. The check is the FLAG and never a string in the payload: any text
 * exemption (a short marker, or pi's full summarization prompt) is text a
 * capability can paste into its own prompt while dropping the contract.
 *
 * Everything else must carry the contract in its serialized payload.
 */
export function contractVerdictForRequest(
  payload: unknown,
  contract: string,
  opts: { compacting?: () => boolean } = {},
): ContractVerdict {
  if (opts.compacting?.() === true) return { allowed: true, kind: "pi-summarization" };
  if (payloadCarriesRequestText(payload, contract)) {
    return { allowed: true, kind: "carries-contract" };
  }
  const serialized = serializeRequestPayload(payload);
  return {
    allowed: false,
    reason: "contract_missing_from_system_prompt",
    detail:
      serialized === undefined
        ? "the outgoing provider request payload could not be serialized, so the contract could not be found in it"
        : `the outgoing provider request's ${serialized.length}-char payload does not contain the session's contract block (${contract.length} chars)`,
  };
}

/** What the guard does when a request fails: exactly what a failed audit does. */
export interface ContractGuardDeps {
  /** Dispose the session the request belongs to. */
  dispose: () => void;
  /** End the process. */
  exit: (code: number) => void;
  /** Diagnostics. */
  log: (message: string) => void;
}

/**
 * bob's guard, as an INLINE pi extension. Inline extensions are appended to the
 * extension list AFTER every path-loaded one (pi 0.84.3, core/resource-loader.js
 * `loadExtensionFactories` / `loadFinalExtensionSet`), and pi runs
 * `before_provider_request` handlers in that list's order — so the handler below
 * runs LAST and sees the payload every other capability has finished with.
 *
 * A failed check does not throw: pi catches an extension handler's throw and
 * records a diagnostic (core/extensions/runner.js `emitBeforeProviderRequest`),
 * which would leave the turn running. It disposes and ends the process instead,
 * naming the reason — the same path a failed tool audit takes.
 */
export function createContractGuardExtension(input: {
  contract: string;
  /** Read lazily: the deps hold the session, which exists only after the
   *  factory has built it. */
  deps: () => ContractGuardDeps;
  /** pi's own "a compaction or branch summary is running" flag, read per
   *  request (`AgentSession.isCompacting`). Lazy for the same reason as deps:
   *  the session does not exist until the factory has built it. Omitted (or
   *  false) means the request must carry the contract. */
  compacting?: () => boolean;
}): InlineExtension {
  const factory = (pi: {
    on(event: "before_provider_request", handler: (event: { payload: unknown }) => unknown): void;
  }): void => {
    pi.on("before_provider_request", (event) => {
      const verdict = contractVerdictForRequest(event.payload, input.contract, {
        ...(input.compacting !== undefined ? { compacting: input.compacting } : {}),
      });
      if (verdict.allowed) return undefined;
      const deps = input.deps();
      // Dispose FIRST: describing the failure can itself throw, and nothing may
      // stand between a failed check and the dispose + exit below (the order
      // auditOrExit uses for the same reason).
      try {
        deps.dispose();
      } catch {
        // the failed check is the error that matters
      }
      const message =
        `bob: ${verdict.reason}; disposing the session and ending the process before another turn can run. ` +
        `${verdict.detail}. The contract is appended to the system prompt through the resource loader, so it ` +
        `reaches the model in every provider layout; a capability that replaces the prompt (before_agent_start) ` +
        `or rewrites the outgoing provider payload (before_provider_request) takes it away, and no turn may run ` +
        `without it.`;
      try {
        deps.log(message);
      } finally {
        deps.exit(1);
      }
      return undefined;
    });
  };
  return { name: "bob-contract-guard", factory, hidden: true };
}
