// URL admission for the fetch core (bob#245 — web spec v3, slice R1b). Every
// URL the core will dispatch — the one it is given, and every redirect target
// — goes through admitUrl, and the URL it returns is the SAME parsed URL the
// core then dispatches (no second parse, so no gap between what was checked
// and what is sent).
//
// WHAT IS CHECKED, in order: a zone identifier in the authority (WHATWG URL
// refuses that form itself, so this runs first); a parse with WHATWG URL; empty
// userinfo; the scheme (http/https only); the port (443 and 80); a downgrade
// (an https URL may not be followed to http, whatever allow_http says); plain
// HTTP when allow_http is off; and, when the host is an address literal, the
// canonical literal against the address policy. A name is not resolved here:
// its answers are vetted in the connection's own lookup (fetch.ts,
// vettedLookup), which is where the address that gets connected to is decided.

import type { AddressPolicy, AddressRefusal } from "./address.js";
import { parseAddress } from "./address.js";
import { WebFetchError } from "./errors.js";

// The ports a URL may name. 443 and 80, and nothing else.
export const WEB_PORTS: readonly number[] = Object.freeze([443, 80]);

export interface UrlPolicy {
  // Plain HTTP is off unless the operator turned it on (web.allow_http).
  allowHttp: boolean;
  // The ports a URL may use. WEB_PORTS in production.
  ports: readonly number[];
  // The address policy a canonical literal is checked against.
  address: AddressPolicy;
}

// The authority of a raw URL string ("//" to the first "/", "?" or "#").
function authorityOf(raw: string): string {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(raw);
  return match?.[1] ?? "";
}

// A zone identifier (fe80::1%eth0): WHATWG URL rejects the form, so it is
// detected on the raw string. A "%" anywhere in the authority, or inside a
// bracketed host, is read as one.
export function hasZoneIdentifier(raw: string): boolean {
  if (authorityOf(raw).includes("%")) return true;
  return /\[[^\]]*%[^\]]*\]/.test(raw);
}

function refuse(code: WebFetchError["code"], detail: string): WebFetchError {
  return new WebFetchError(code, detail);
}

// The address policy's refusal for one address (a canonical literal, or one DNS
// answer), as a WebFetchError. Used here and by the connection's lookup.
export function addressRefused(refusal: AddressRefusal, address: string): WebFetchError {
  return refuse("address", `${address} is refused: ${refusal.detail}`);
}

export interface AdmitOptions {
  // The URL this one was reached from, when it is a redirect target.
  from?: URL;
}

// Admit a URL, returning the parsed URL to dispatch. Throws WebFetchError with
// the rule that refused it.
export function admitUrl(raw: string, policy: UrlPolicy, options: AdmitOptions = {}): URL {
  if (hasZoneIdentifier(raw)) {
    throw refuse("zone-identifier", "the URL's host carries a zone identifier");
  }

  let url: URL;
  try {
    url = new URL(raw, options.from);
  } catch {
    // Never echo the raw string: it is model-supplied and may be long.
    throw refuse("url-invalid", "the URL could not be parsed");
  }

  if (url.username !== "" || url.password !== "") {
    throw refuse("userinfo", "the URL carries userinfo (user@host)");
  }

  const protocol = url.protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw refuse("scheme", `scheme ${protocol.replace(/:$/, "")} is not http or https`);
  }

  const port = url.port === "" ? (protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!policy.ports.includes(port)) {
    throw refuse("port", `port ${port} is not allowed (${policy.ports.join(", ")})`);
  }

  if (options.from?.protocol === "https:" && protocol === "http:") {
    throw refuse("downgrade", "an https URL may not be followed to http");
  }

  if (protocol === "http:" && !policy.allowHttp) {
    throw refuse("http-not-allowed", "plain HTTP is off (web.allow_http is false)");
  }

  // A canonical literal is vetted here, before dispatch; WHATWG URL has
  // already rewritten every notation (hex, octal, short, 32-bit) into it.
  if (parseAddress(url.hostname) !== undefined) {
    const verdict = policy.address.classify(url.hostname);
    if (!verdict.allowed) throw addressRefused(verdict, url.hostname);
  }

  return url;
}
