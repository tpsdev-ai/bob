// A fetch refusal (bob#245 — web spec v3, slice R1b). One error type for every
// rule the fetch core enforces: each refusal names the rule (code) and the
// specific thing it saw (detail), so a caller can report it and a test can pin
// it. Nothing here carries a response body, a request header or a URL the
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
  | "network";

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
