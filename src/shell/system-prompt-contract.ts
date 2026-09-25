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
// prompt from the resource loader (its appendSystemPrompt) at session creation,
// at bindExtensions, on every reload and after every tool change, and compaction
// replaces only the message history (pi 0.84.3: core/agent-session.js
// `_rebuildSystemPrompt`, core/system-prompt.js `buildSystemPrompt`, and
// core/compaction/* which rewrites session entries, never the loader).
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
//      response request whose system prompt does not carry the contract fails
//      the turn exactly like a failed audit — dispose the session, end the
//      process, and name the reason. A capability can still replace the prompt
//      per turn (`before_agent_start` returning `systemPrompt`) or rewrite the
//      outgoing provider payload (`before_provider_request`), both AFTER the
//      factory's creation/bind/reload audit, so the request itself is the last
//      place the guarantee can be checked;
//   3. the guarantee is stated for AGENT RESPONSE requests. pi's own compaction
//      and branch-summary calls carry pi's summarization prompt instead
//      (`SUMMARIZATION_SYSTEM_PROMPT`, core/compaction/utils.js) and are
//      excluded BY NAME — they are pi talking to the model about the
//      conversation, not the agent answering the operator.

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

/** pi's own summarization system prompt, verbatim (pi 0.84.3,
 *  core/compaction/utils.js `SUMMARIZATION_SYSTEM_PROMPT`). A provider request
 *  that carries it is pi summarizing a conversation, not the agent answering an
 *  operator, so it is excluded from the guarantee by name. Exported so the test
 *  that pins the exclusion reads it from the same place the guard does. */
export const PI_SUMMARIZATION_MARKER = "You are a context summarization assistant.";

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
 * The system prompt carried by an outgoing provider request payload, or
 * undefined when the payload has none. Payload shapes differ per provider API
 * (pi-ai 0.84.3): Anthropic sends `system: [{type:"text",text}]`, OpenAI
 * chat-completions sends the messages array itself with a `system`/`developer`
 * entry, Google sends `systemInstruction`, and the Responses APIs use
 * `instructions`.
 */
export function systemPromptFromRequestPayload(payload: unknown): string | undefined {
  if (payload === null || payload === undefined) return undefined;
  if (Array.isArray(payload)) return systemMessageFrom(payload);
  if (typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;

  const system = record.system;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const entry of system) {
      if (typeof entry === "string") parts.push(entry);
      else if (entry && typeof entry === "object") {
        const text = (entry as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }

  const instruction = record.systemInstruction ?? record.instructions;
  if (typeof instruction === "string") return instruction;

  const messages = record.messages;
  if (Array.isArray(messages)) return systemMessageFrom(messages);
  return undefined;
}

function systemMessageFrom(messages: ReadonlyArray<unknown>): string | undefined {
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") continue;
    const message = entry as { role?: unknown; content?: unknown };
    if (message.role !== "system" && message.role !== "developer") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (typeof block === "string") parts.push(block);
        else if (block && typeof block === "object") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") parts.push(text);
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
    return undefined;
  }
  return undefined;
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
 * Order matters: pi's summarization requests are checked FIRST and passed, so
 * the guard cannot fail a turn over pi's own summarization call (which carries
 * pi's summarization prompt by design, never the agent's contract).
 */
export function contractVerdictForRequest(payload: unknown, contract: string): ContractVerdict {
  const systemPrompt = systemPromptFromRequestPayload(payload);
  if (systemPrompt === undefined) {
    // No system prompt we can read: the request is not a shape bob can vouch
    // for. Treated as a FAILED check — "I could not see it" is not "it is there".
    return {
      allowed: false,
      reason: "contract_missing_from_system_prompt",
      detail: "the outgoing provider request carries no readable system prompt",
    };
  }
  if (systemPrompt.includes(PI_SUMMARIZATION_MARKER)) {
    return { allowed: true, kind: "pi-summarization" };
  }
  if (systemPrompt.includes(contract)) return { allowed: true, kind: "carries-contract" };
  return {
    allowed: false,
    reason: "contract_missing_from_system_prompt",
    detail: `the request's system prompt (${systemPrompt.length} chars) does not carry the session's contract block (${contract.length} chars)`,
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
}): InlineExtension {
  const factory = (pi: {
    on(event: "before_provider_request", handler: (event: { payload: unknown }) => unknown): void;
  }): void => {
    pi.on("before_provider_request", (event) => {
      const verdict = contractVerdictForRequest(event.payload, input.contract);
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
        `${verdict.detail}. The contract is appended to the system prompt through the resource loader; a capability ` +
        `that replaces the prompt (before_agent_start) or rewrites the outgoing provider payload ` +
        `(before_provider_request) takes it away, and no turn may run without it.`;
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
