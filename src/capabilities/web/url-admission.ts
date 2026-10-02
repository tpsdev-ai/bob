// URL admission for the fetch core (bob#245 — web spec v3, slice R1b). Every
// URL the core will dispatch — the one it is given, and every redirect target
// — goes through admitUrl. The core passes its canonical `href` to undici for
// dispatch.
//
// WHAT IS CHECKED, in order: a zone identifier in a bracketed authority host
// (WHATWG URL refuses that form itself, so this runs first); a parse with WHATWG
// URL; userinfo, including an empty userinfo delimiter; the scheme (http/https
// only); the port (443 and 80); a downgrade
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

// The authority of an absolute URL or a scheme-relative redirect, before
// WHATWG URL can erase empty userinfo. This also handles short scheme forms
// when no same-scheme base makes them relative. Match special-scheme backslashes:
// WHATWG treats them as authority separators. Its input preprocessing strips
// edge C0/space and removes tabs and newlines.
function authorityOf(raw: string, from?: URL): string {
  let start = 0;
  let end = raw.length;
  while (start < end && raw.charCodeAt(start) <= 32) start++;
  while (end > start && raw.charCodeAt(end - 1) <= 32) end--;
  const input = raw
    .slice(start, end)
    .replaceAll("\t", "")
    .replaceAll("\n", "")
    .replaceAll("\r", "")
    .replaceAll("\\", "/");
  const match = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/+([^/?#]*)/.exec(input);
  if (match !== null) return match[1];
  // Without a same-scheme base, WHATWG also reads `https:@host` and
  // `https:/@host` as authorities. With one, they are relative paths.
  const short = /^(https?):\/?([^/?#]*)/i.exec(input);
  if (short !== null && (from === undefined || from.protocol !== `${short[1].toLowerCase()}:`)) {
    return short[2];
  }
  return "";
}

// A zone identifier belongs inside a bracketed IPv6 host, not in a percent-
// escaped DNS name, userinfo, path or query. WHATWG rejects IPv6 zones itself,
// so inspect the raw host before parsing to give the specific refusal.
export function hasZoneIdentifier(raw: string, from?: URL): boolean {
  const authority = authorityOf(raw, from);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return /^\[[^\]]*:[^\]]*%[^\]]*\]/.test(host);
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
  if (hasZoneIdentifier(raw, options.from)) {
    throw refuse("zone-identifier", "the URL's host carries a zone identifier");
  }

  let url: URL;
  try {
    url = new URL(raw, options.from);
  } catch {
    // Never echo the raw string: it is model-supplied and may be long.
    throw refuse("url-invalid", "the URL could not be parsed");
  }

  if (authorityOf(raw, options.from).includes("@") || url.username !== "" || url.password !== "") {
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
