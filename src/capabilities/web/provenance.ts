// URL provenance for the `web_fetch` tool (bob#152, spec v3, slice R1c).
//
// Candidates must match a recorded WHATWG URL serialization with its fragment
// stripped. Text references are recorded from whole whitespace-delimited tokens;
// HTML uses the extractor's retained, resolvable HTTP(S) anchor hrefs.

// The serialized form that is compared and dispatched. WHATWG `search` is ""
// for both no query and an empty query (`?`), so this is the URL's own
// serialization with the fragment removed: it keeps the `?` of an empty query
// (which `search` cannot tell from none) and normalizes the scheme, host case,
// the default port and the path.
export function urlKey(url: URL): string {
  const serialized = url.href;
  const hash = serialized.indexOf("#");
  return hash === -1 ? serialized : serialized.slice(0, hash);
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

const WRAPPING_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "<": ">",
  "(": ")",
  "[": "]",
};

// Remove sentence punctuation outside one matching wrapper, then parse the
// entire remainder. No substring inside a whitespace-delimited token is scanned.
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const token of text.split(/\s+/u)) {
    if (!/https?:\/\//i.test(token)) continue;
    let candidate = token.replace(/[.,;:!?]+$/u, "");
    const close = WRAPPING_PAIRS[candidate[0]];
    if (close !== undefined && candidate.endsWith(close)) {
      const inner = candidate.slice(1, -1);
      if (inner.includes(candidate[0]) || inner.includes(close)) continue;
      candidate = inner;
    }
    if (!/^https?:\/\//i.test(candidate)) continue;
    const parsed = parseAbsolute(candidate);
    if (parsed !== undefined) out.push(parsed.href);
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

// Record the absolute http(s) URLs that appear in text, resolved against
// `base` when given. Each match is parsed, so one that does not parse records
// nothing.
export function recordUrls(recorded: Map<string, string>, text: string, base?: string): void {
  for (const raw of extractUrls(text)) recordUrl(recorded, raw, base);
}

// Record extractor results: retained, resolvable HTTP(S) anchors for HTML,
// scanned absolute URLs for other media. Each is already absolute.
export function recordLinks(recorded: Map<string, string>, links: readonly string[]): void {
  for (const link of links) recordUrl(recorded, link);
}
