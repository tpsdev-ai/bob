// Admission state for the `web_fetch` tool (bob#152, spec v3, slice R1c).
//
// The unit of state is one ADMITTED OPERATION — a single runtime turn
// admission, including its retries and automatic continuations. The extension
// seeds one state on the operation's first prompt and reuses it for
// every later prompt the operation sends (pi fires `before_agent_start` once per
// prompt, so a continuation must NOT reseed). The runtime's admission token
// tells those apart: the same token continues, a new one replaces, and no token
// at all (a bare prompt outside any admission, or any call once the operation's
// prompt chain has settled) seeds nothing. A call outside a live admitted
// operation finds no state and is refused. An attempt is charged for a
// RECORDED candidate before its fetch (so a failed fetch still counts); the
// extracted document text is charged after the response, against the operation's
// allowance.
//
// This module owns URLs (provenance.ts) and the two budgets: fetch attempts and
// the shared fetch/search text allowance.

import type { TurnOrigin } from "../../shell/turn-origin.js";
import type { WebSettings } from "./core.js";
import { WebFetchError } from "./errors.js";
import { parseAbsolute, recordLinks, recordUrls, urlKey } from "./provenance.js";

export interface WebTurnState {
  // A fresh counter per seeded operation, so two states are never confused.
  readonly id: number;
  // The admission origin recorded when the state was seeded. A tool call whose
  // current origin differs is running in a different admission.
  readonly origin: TurnOrigin;
  // Recorded URLs, keyed by their serialized form (provenance.ts), value the
  // canonical href recorded.
  readonly recorded: Map<string, string>;
  // Fetch attempts charged for this operation.
  fetchAttempts: number;
  // Characters of extracted document text returned by web calls in this
  // operation.
  textChars: number;
}

let nextStateId = 1;

// A fresh state for one admitted operation: the URLs in the triggering message
// are recorded, and both budgets start spent at zero.
export function newTurnState(prompt: string, origin: TurnOrigin): WebTurnState {
  const recorded = new Map<string, string>();
  recordUrls(recorded, prompt);
  return { id: nextStateId++, origin, recorded, fetchAttempts: 0, textChars: 0 };
}

// Record extractor results: retained, resolvable HTTP(S) anchors for HTML,
// scanned absolute URLs for other media.
export function recordPageLinks(state: WebTurnState, links: readonly string[]): void {
  recordLinks(state.recorded, links);
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
      "this URL was not recorded from the message or a fetched page; search for it or ask for the link",
    );
  }
  return url;
}

// Charge one fetch attempt for a recorded candidate. Refused once the
// operation's attempt budget is spent. Called before the fetch begins, so a
// fetch that then fails still counts; a candidate refused by provenance first
// charges nothing.
export function chargeFetchAttempt(state: WebTurnState, settings: WebSettings): void {
  if (state.fetchAttempts >= settings.fetchPerTurn) {
    throw new WebFetchError(
      "budget-fetch",
      `the fetch budget for this operation (${settings.fetchPerTurn}) is spent`,
    );
  }
  state.fetchAttempts += 1;
}

// The characters of extracted document text the operation may still return.
export function textAllowanceRemaining(state: WebTurnState, settings: WebSettings): number {
  return Math.max(0, settings.textPerTurn - state.textChars);
}

// Charge extracted document text against the shared allowance. Refused when it would
// exceed the allowance; the caller caps the text to what remains first.
export function chargeText(state: WebTurnState, settings: WebSettings, chars: number): void {
  if (chars > textAllowanceRemaining(state, settings)) {
    throw new WebFetchError(
      "budget-text",
      `this call would return more text than the operation's remaining allowance (${textAllowanceRemaining(
        state,
        settings,
      )} characters)`,
    );
  }
  state.textChars += chars;
}
