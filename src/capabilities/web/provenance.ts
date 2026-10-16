// URL provenance for the `web_fetch` tool (bob#152, spec v3, slice R1c).
//
// This is a NAVIGATION rule, not an egress control: it stops the model from
// composing a URL. A URL is recorded only after it has been resolved against
// the page it came from and parsed with WHATWG URL; fragments are stripped from
// both the recorded URL and the candidate. A candidate matches when its
// serialized scheme, host, effective port, path and complete query equal a
// recorded URL's — nothing is decoded, reordered, dropped or appended during
// the comparison, and there is no host-only grant. The caller dispatches the
// parsed candidate itself.

// The serialized form that is compared and dispatched: `scheme://host path
// query`, where `host` carries the effective port (WHATWG URL omits a default
// port) and `search` is the complete query, `?` included. The fragment is not
// part of it.
export function urlKey(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
}

// A candidate absolute http(s) URL, parsed with WHATWG URL and with its
// fragment stripped. Undefined when the string is not an absolute http(s) URL:
// a relative string, another scheme, or an unparseable one.
export function parseAbsolute(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  return url;
}

// URLs that appear verbatim in text. The fetched-page extractor renders a link
// as `text (url)` with the url already resolved against the page, so this reads
// that form back. A trailing run of prose punctuation (`.`, `,`, `)`, a quote)
// is not part of the URL: the extractor wraps the url in parentheses, so `)`
// must not be absorbed. A url that legitimately ends in one of those characters
// is therefore not matched, and the fetch of it is refused.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;

export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const raw = match[0].replace(/[.,;:!?)\]}>'"]+$/, "");
    if (raw !== "") out.push(raw);
  }
  return out;
}

// Record one URL into a provenance map, resolved against `base` when it is not
// already absolute. A string that does not resolve to an http(s) URL, or does
// not parse, records nothing. The map is keyed by the serialized form above, so
// a fragment grants nothing and two spellings of the same URL collapse.
export function recordUrl(recorded: Map<string, string>, raw: string, base?: string): void {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  url.hash = "";
  recorded.set(urlKey(url), url.href);
}

// Record every URL that appears in text, resolved against `base` when given.
export function recordUrls(recorded: Map<string, string>, text: string, base?: string): void {
  for (const raw of extractUrls(text)) recordUrl(recorded, raw, base);
}
