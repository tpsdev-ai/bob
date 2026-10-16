// A web fetch refusal (bob#245 — web spec v3, slice R1b; extended by R1c). One
// error type for the refusals the fetch core, the URL provenance and the
// admission budgets raise, so a caller can report one and a test can pin its
// code. Each refusal names the rule (code) and the specific thing it saw
// (detail). Nothing here carries a response body, a request header or a URL the
// caller did not already hold.

export type WebFetchRefusalCode =
  // The URL could not be parsed, or is not http/https on an allowed port.
  | "url-invalid"
  | "userinfo"
  | "zone-identifier"
  | "scheme"
  | "port"
  | "http-not-allowed"
  | "downgrade"
  // A DNS answer, or the canonical literal, is refused by the address policy.
  | "address"
  // More than five redirects.
  | "redirect-limit"
  // The response's content type is not one the core extracts.
  | "content-type"
  // The response's content-encoding is not one the core decodes.
  | "content-encoding"
  // The encoded or the decoded body is over 5 MB.
  | "too-large"
  // The 15-second total deadline elapsed.
  | "deadline"
  // The connection failed (DNS, refused, TLS, reset).
  | "network"
  // The tool ran outside an admitted prompt: no state was seeded.
  | "no-admission"
  // The running admission does not match the state's seeded admission.
  | "admission-mismatch"
  // The candidate URL was not recorded from the message or a fetched page.
  | "url-unrecorded"
  // The prompt's fetch-attempt budget is spent.
  | "budget-fetch"
  // The shared fetch/search text allowance would be exceeded.
  | "budget-text";

export interface WebFetchRefusal {
  code: WebFetchRefusalCode;
  detail: string;
}

export class WebFetchError extends Error implements WebFetchRefusal {
  readonly code: WebFetchRefusalCode;
  readonly detail: string;

  constructor(code: WebFetchRefusalCode, detail: string) {
    super(`web fetch refused (${code}): ${detail}`);
    this.name = "WebFetchError";
    this.code = code;
    this.detail = detail;
  }
}

// True when `error` is one of this module's refusals, so a caller can tell a
// refusal it made from a failure it did not expect.
export function isWebFetchError(error: unknown): error is WebFetchError {
  return error instanceof WebFetchError;
}
