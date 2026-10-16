// The `web_fetch` tool (bob#152, spec v3, slice R1c). It combines the R1b fetch
// core with URL provenance and the admission budgets: it admits the URL against
// the operation's recorded URLs, charges a fetch attempt before the fetch,
// calls the fetch core (vetting every redirect target against provenance before
// it is followed), records the complete links the returned page carried, and
// charges the extracted document text against the shared allowance.
//
// It registers nothing here; index.ts wires this definition to pi. `fetch` is a
// seam: production uses the R1b `fetchDocument`; a test can inject one.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { TurnOrigin } from "../../shell/turn-origin.js";
import {
  admitCandidate,
  chargeFetchAttempt,
  chargeText,
  originKey,
  recordPageLinks,
  textAllowanceRemaining,
  type WebTurnState,
} from "./admission.js";
import type { WebSettings } from "./core.js";
import { WebFetchError } from "./errors.js";
import { type FetchResult, fetchDocument, resolveMaxChars } from "./fetch.js";

export const WEB_FETCH_TOOL_NAME = "web_fetch";

export const WEB_FETCH_PARAMS = Type.Object({
  url: Type.String({
    minLength: 1,
    description: "The URL to fetch. It must be one recorded from the message or a fetched page.",
  }),
  maxChars: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Lower the returned text limit. It cannot exceed the operator's ceiling.",
    }),
  ),
});

type WebFetchParams = Static<typeof WEB_FETCH_PARAMS>;

export type WebFetchFn = (
  url: string,
  options: { settings: WebSettings; maxChars: number; onRedirect?: (target: URL) => void },
) => Promise<FetchResult>;

export interface WebFetchToolDeps {
  settings: WebSettings;
  // The state seeded for the admitted prompt in flight, or undefined outside it.
  currentState: () => WebTurnState | undefined;
  // The current admission's origin, or undefined outside an admission.
  currentOrigin: () => TurnOrigin | undefined;
  // The fetch core. Defaults to the R1b fetchDocument.
  fetch?: WebFetchFn;
}

function renderFetchResult(result: FetchResult): string {
  const meta = `fetched ${result.finalUrl} — HTTP ${result.status} ${result.contentType}${
    result.truncated ? "; text truncated" : ""
  }`;
  return `${meta}\n\n${result.text}`;
}

export function createWebFetchTool(
  deps: WebFetchToolDeps,
): ToolDefinition<typeof WEB_FETCH_PARAMS> {
  const fetch: WebFetchFn = deps.fetch ?? ((url, options) => fetchDocument(url, options));
  return {
    name: WEB_FETCH_TOOL_NAME,
    label: "Web Fetch",
    description:
      "Fetch a URL and return its readable text, final URL, HTTP status and content type. The URL must be one that appeared in the current message or on a page already fetched this prompt; a composed URL is refused. Plain HTTP is allowed only when the operator enables it.",
    parameters: WEB_FETCH_PARAMS,
    async execute(_toolCallId: string, params: WebFetchParams) {
      const state = deps.currentState();
      if (state === undefined) {
        throw new WebFetchError(
          "no-admission",
          "web_fetch ran outside an admitted prompt; there is no provenance or budget state",
        );
      }
      const origin = deps.currentOrigin();
      if (origin === undefined || originKey(origin) !== originKey(state.origin)) {
        throw new WebFetchError(
          "admission-mismatch",
          "the running turn's origin does not match the one this prompt's state was seeded for",
        );
      }

      const target = admitCandidate(state, params.url);
      // Charge the attempt before the fetch begins: a fetch that then fails
      // still counts.
      chargeFetchAttempt(state, deps.settings);

      const remaining = textAllowanceRemaining(state, deps.settings);
      if (remaining <= 0) {
        throw new WebFetchError(
          "budget-text",
          "the shared text allowance for this prompt is spent",
        );
      }
      const maxChars = Math.min(
        resolveMaxChars(params.maxChars, deps.settings.fetchMaxChars),
        remaining,
      );

      const result = await fetch(target.href, {
        settings: deps.settings,
        maxChars,
        // Vet every redirect target against provenance BEFORE it is followed,
        // so an unrecorded destination is never requested.
        onRedirect: (redirect) => {
          admitCandidate(state, redirect.href);
        },
      });
      recordPageLinks(state, result.links);
      // The allowance covers the extracted document text; the metadata line the
      // tool renders alongside it (final URL, status, content type) is not
      // charged.
      chargeText(state, deps.settings, result.text.length);

      return {
        content: [{ type: "text", text: renderFetchResult(result) }],
        details: {
          finalUrl: result.finalUrl,
          status: result.status,
          contentType: result.contentType,
          truncated: result.truncated,
        },
      };
    },
  };
}
