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
//      request that does not carry the contract block fails the turn exactly
//      like a failed audit — dispose the session, end the process, and name the
//      reason. A capability can still replace the prompt per turn
//      (`before_agent_start` returning `systemPrompt`) or rewrite the outgoing
//      provider payload (`before_provider_request`), both AFTER the factory's
//      creation/reload audit, so the request itself is the last place the
//      guarantee can be checked.
//
//      What the guard proves is that EVERY AGENT REQUEST CARRIES THE CONTRACT
//      BLOCK. The system prompt is where bob PUTS it — the mechanism above, and
//      it is tested — while the guard proves it is still SENT. A capability that
//      copies the block into a user message and replaces the system field
//      passes, deliberately: the block still reaches the model in that request.
//      The erasure #145 is about is a request that goes out WITHOUT it.
//
//      The check does NOT parse provider payload shapes: layouts differ per API
//      and change between pi releases, and a reader that knows a few of them
//      fails a legitimate request the moment a provider differs. It does not
//      search a SERIALIZATION either (round 3): it walks the payload's DECODED
//      string values and asks whether any of them contains the block. A
//      substring of a JSON text is not the text a provider sends — a client that
//      writes a character escaped (`é` as `\u00e9`) or an adapter that sanitizes
//      the system prompt makes the bytes differ from the block while the value
//      the model receives is the block, and a serialized search false-fails
//      that request. The block itself is built from WELL-FORMED text (unpaired
//      surrogates removed the way pi-ai's adapters remove them,
//      `utils/sanitize-unicode.ts`), so an adapter's own sanitizing is a no-op
//      on it and the block the guard compares IS the block the provider sends;
//   3. there is NO exemption (round 3), because this hook never sees pi's own
//      calls: in pi 0.84.3 the agent turn's `onPayload` — the seam pi routes to
//      `before_provider_request` — is attached to the agent's own requests,
//      while pi's compaction and branch-summary calls pass the stream function
//      their OWN options (apiKey/headers/…, no onPayload), so pi's summaries
//      never reach this hook at all — proven live, and the live test fails if a
//      future pi routes them here. Round 2's exemption on pi's
//      `AgentSession.isCompacting` flag is not safe insurance for that day: the
//      flag is ALSO true during branch summarization (`navigateTree`), where a
//      capability's `sendMessage` with `triggerTurn` can start an agent turn
//      (`sendMessage`, agent-session.js) — so the flag could exempt a REAL
//      agent request that carries no block. With the exemption gone there is
//      nothing to borrow: every request that reaches this hook must carry the
//      block.

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
// Never end a cut inside a surrogate pair: a lone high surrogate is not a
// character a provider is ever sent (pi-ai's adapters strip it), so a block cut
// mid-emoji would differ from the block in the payload and the guard would
// refuse a legitimate request.
function codePointSafeEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return Math.max(0, end);
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

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
  if (keep <= 0) return text.slice(0, codePointSafeEnd(text, cap));
  keep = codePointSafeEnd(text, keep);
  return text.slice(0, keep) + markerFor(text.length - keep);
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

/** Unpaired surrogates removed, exactly as pi-ai's adapters do it — the same
 *  regex as `utils/sanitize-unicode.ts` `sanitizeSurrogates` (pi-ai 0.84.3),
 *  which every payload builder applies to the system prompt and to message
 *  content before it builds a request (api/openai-completions.js,
 *  anthropic-messages.js, google-*.js, bedrock-converse-stream.js, …).
 *
 *  An unpaired surrogate is not a character a provider ever receives, so a
 *  block that carried one would differ from the block in the payload and the
 *  guard would refuse a legitimate request. Mirroring the adapters here is what
 *  makes the block the guard compares and the block the provider sends the SAME
 *  text. */
export function wellFormedContractText(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
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
  const what = opts.label === "TASK" ? "task" : "standing contract";
  // Well-formed FIRST, then refuse a blank: a task that is nothing but
  // unpaired surrogates says nothing once they are gone, and the block is built
  // from the text the provider will actually be sent.
  const text = assertContractText(wellFormedContractText(opts.text ?? ""), what);
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

/** A payload that cannot be serialized cannot be sent either; the guard treats
 *  it as unreadable. */
const UNSERIALIZABLE = Symbol("unserializable request payload");

/** The payload's DECODED value, as it will be SENT. Some adapters hand the guard
 *  a body that is already a string (a serialization): parse it. An object is
 *  put through the same round trip the client performs before it sends
 *  (JSON.stringify, which applies any toJSON(), then JSON.parse), so the guard
 *  reads what goes on the wire, not an object whose serialization differs from
 *  its fields. A string that is not JSON is its own value. */
export function decodedRequestPayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  try {
    const wire = JSON.stringify(payload);
    return wire === undefined ? UNSERIALIZABLE : JSON.parse(wire);
  } catch {
    return UNSERIALIZABLE;
  }
}

/** How the payload was read, for the failure message: whether it could be read
 *  at all, and how many string values it carried. */
export interface RequestPayloadScan {
  carries: boolean;
  /** String values walked. Zero on a payload that carries none. */
  stringValues: number;
  /** false for a payload that cannot be read at all (undefined). */
  readable: boolean;
}

/** Walk one value: a string leaf is the ONLY thing that can carry the block. */
function scanStringValue(
  value: unknown,
  text: string,
  seen: Set<object>,
  count: { n: number },
): boolean {
  if (typeof value === "string") {
    count.n += 1;
    return value.includes(text);
  }
  if (value === null || typeof value !== "object") return false;
  // A cycle cannot appear in a payload a provider builds; walking one would
  // loop, so a value already walked is not descended into again.
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (scanStringValue(entry, text, seen, count)) return true;
    }
    return false;
  }
  for (const entry of Object.values(value)) {
    if (scanStringValue(entry, text, seen, count)) return true;
  }
  return false;
}

/**
 * Read the payload for `text` — the whole of the guard's check.
 *
 * It asks whether a string VALUE in the payload contains the block, walking the
 * decoded object (objects and arrays), never whether a serialization of it
 * contains the block as a substring. The difference is the difference between
 * "the model is sent the block" and "some JSON text spells it": a client may
 * write a character escaped (`é` as `\u00e9`) and pi-ai's adapters sanitize the
 * system prompt, so a serialized search false-fails a legitimate request. Nor
 * does it parse provider SHAPES — layouts differ per API (pi-ai 0.84.3:
 * Anthropic's `system` blocks, chat-completions' `messages`, the Responses APIs'
 * `input`/`instructions`, Google's `config.systemInstruction`, Bedrock's
 * `system`, Mistral's `messages`, Codex's `instructions`) and change between pi
 * releases — and EVERY layout carries its text in string values, whatever its
 * keys are, which is why this needs no shape. A capability that replaced or
 * dropped the system prompt removes the block from the payload entirely, which
 * is the capability loss this catches.
 */
export function scanRequestPayload(payload: unknown, text: string): RequestPayloadScan {
  if (payload === undefined) return { carries: false, stringValues: 0, readable: false };
  const decoded = decodedRequestPayload(payload);
  if (decoded === UNSERIALIZABLE) return { carries: false, stringValues: 0, readable: false };
  const count = { n: 0 };
  const carries = scanStringValue(decoded, text, new Set<object>(), count);
  return { carries, stringValues: count.n, readable: true };
}

/** Whether the request payload carries `text` in one of its DECODED string
 *  values. */
export function payloadCarriesRequestText(payload: unknown, text: string): boolean {
  return scanRequestPayload(payload, text).carries;
}

export type ContractVerdict =
  /** The request carries the contract block — the only way it goes out. */
  | { allowed: true; kind: "carries-contract" }
  /** An AGENT REQUEST that does not carry the contract block. */
  | { allowed: false; reason: "contract_missing_from_request"; detail: string };

/**
 * The guard's decision for ONE outgoing provider request. Pure, so the guard
 * itself is a thin wiring layer and the decision is testable without pi.
 *
 * There is ONE question and NO exemption: does this request carry the contract
 * block? Every request that reaches bob's guard is an agent request — pi's own
 * summarization calls never get here (see the header) — so a request that does
 * not carry the contract fails, whatever else is true of the session. There is
 * no flag to consult and no text to match that a capability could borrow.
 */
export function contractVerdictForRequest(payload: unknown, contract: string): ContractVerdict {
  const scan = scanRequestPayload(payload, contract);
  if (scan.carries) return { allowed: true, kind: "carries-contract" };
  return {
    allowed: false,
    reason: "contract_missing_from_request",
    detail: !scan.readable
      ? "the outgoing provider request payload could not be read, so the contract could not be found in it"
      : scan.stringValues === 0
        ? `the outgoing provider request carries no string value at all, so the session's contract block (${contract.length} chars) is not in it`
        : `none of the outgoing provider request's ${scan.stringValues} string value(s) contains the session's contract block (${contract.length} chars)`,
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
      // No options and no exemption: the payload decides. pi's own summaries do
      // not reach this handler (the header, and the live test pins it), so a
      // request that lacks the contract is an agent request that lost it.
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
        `${verdict.detail}. Every agent request must carry the contract block: bob appends it to the system ` +
        `prompt through the resource loader, so it reaches the model in every provider layout, and a capability ` +
        `that replaces the prompt (before_agent_start) or rewrites the outgoing provider payload ` +
        `(before_provider_request) takes it away — no turn may run without it.`;
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
