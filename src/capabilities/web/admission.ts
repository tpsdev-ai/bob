// Admission state for the `web_fetch` tool (bob#152, spec v3, slice R1c).
//
// The unit of state is one ADMITTED PROMPT, including its retries and automatic
// continuations: the extension seeds one state at `before_agent_start` (which
// pi fires once per prompt, after expansion) and clears it on a full
// `agent_settled` and on session close. A tool call outside that window finds no
// state and is refused. Budgets are charged before any I/O, so a call that
// throws or aborts still consumes. The seed REPLACES the state with a fresh
// object, so a missed clear cannot carry state forward into the next prompt.
//
// This module owns URLs (provenance.ts) and the two budgets: fetch attempts and
// the shared fetch/search text allowance.

import type { TurnOrigin } from "../../shell/turn-origin.js";
import type { WebSettings } from "./core.js";
import { WebFetchError } from "./errors.js";
import { parseAbsolute, recordUrls, urlKey } from "./provenance.js";

export interface WebTurnState {
  // A fresh counter per seeded prompt, so two states are never confused.
  readonly id: number;
  // The admission origin recorded when the state was seeded. A tool call whose
  // current origin differs is running in a different admission.
  readonly origin: TurnOrigin;
  // Recorded URLs, keyed by their serialized form (provenance.ts), value the
  // canonical href recorded.
  readonly recorded: Map<string, string>;
  // Fetch attempts charged for this prompt.
  fetchAttempts: number;
  // Characters of text returned by web calls in this prompt.
  textChars: number;
}

let nextStateId = 1;

// A fresh state for one admitted prompt: the URLs in the triggering message are
// recorded, and both budgets start spent at zero.
export function newTurnState(prompt: string, origin: TurnOrigin): WebTurnState {
  const recorded = new Map<string, string>();
  recordUrls(recorded, prompt);
  return { id: nextStateId++, origin, recorded, fetchAttempts: 0, textChars: 0 };
}

// Record the links on a fetched page, resolved against the page they came from.
export function recordPageLinks(state: WebTurnState, text: string, pageUrl?: string): void {
  recordUrls(state.recorded, text, pageUrl);
}

// A stable key for an origin, so two origins compare by value.
export function originKey(origin: TurnOrigin): string {
  switch (origin.kind) {
    case "mail":
      return `mail:${origin.from}`;
    case "cron":
      return `cron:${origin.job}`;
    case "discord":
      return `discord:${origin.channelId}`;
    default:
      return "run";
  }
}

// The URL to dispatch, or a refusal. The candidate is parsed with WHATWG URL
// and its fragment stripped; it must match a recorded URL by the exact rule in
// provenance.ts. The parsed candidate is returned, and the caller dispatches it.
export function admitCandidate(state: WebTurnState, candidate: string): URL {
  const url = parseAbsolute(candidate);
  if (url === undefined) {
    // Never echo the raw string: it is model-supplied and may be long.
    throw new WebFetchError(
      "url-invalid",
      "the URL could not be parsed as an absolute http(s) URL",
    );
  }
  if (!state.recorded.has(urlKey(url))) {
    throw new WebFetchError(
      "url-unrecorded",
      "this URL did not appear in the message or on a fetched page; search for it or ask for the link",
    );
  }
  return url;
}

// Charge one fetch attempt. Refused once the prompt's attempt budget is spent.
// Called before any I/O, so a call that fails still counts.
export function chargeFetchAttempt(state: WebTurnState, settings: WebSettings): void {
  if (state.fetchAttempts >= settings.fetchPerTurn) {
    throw new WebFetchError(
      "budget-fetch",
      `the fetch budget for this prompt (${settings.fetchPerTurn}) is spent`,
    );
  }
  state.fetchAttempts += 1;
}

// The characters of text the prompt may still return.
export function textAllowanceRemaining(state: WebTurnState, settings: WebSettings): number {
  return Math.max(0, settings.textPerTurn - state.textChars);
}

// Charge returned text against the shared allowance. Refused when it would
// exceed the allowance; the caller caps the text to what remains first.
export function chargeText(state: WebTurnState, settings: WebSettings, chars: number): void {
  if (chars > textAllowanceRemaining(state, settings)) {
    throw new WebFetchError(
      "budget-text",
      `this call would return more text than the prompt's remaining allowance (${textAllowanceRemaining(
        state,
        settings,
      )} characters)`,
    );
  }
  state.textChars += chars;
}
