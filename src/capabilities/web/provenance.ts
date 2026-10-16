// URL provenance for the `web_fetch` tool (bob#152, spec v3, slice R1c).
//
// This is a NAVIGATION rule, not an egress control: it stops the model from
// composing a URL. A URL is recorded only after it has been parsed with WHATWG
// URL (resolved against its page when it came from one), with its fragment
// stripped from both the recorded URL and the candidate. A candidate matches
// when its serialization (scheme, host, effective port, path and complete
// query) equals a recorded URL's — nothing is decoded, reordered, dropped or
// appended during the comparison, and there is no host-only grant. The caller
// dispatches the parsed candidate itself.
//
// A recorded reference is never rebuilt from display text: the fetch core
// reports the complete links a page carries (extract.ts), and a message is
// scanned for the absolute URLs it carries, recorded as their parsed
// serialization. A reference that does not parse as an absolute http(s) URL
// records nothing.

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

// Quote characters that can open a markup reference — an HTML attribute or a
// Markdown code span. Immediately before a URL they delimit it; inside a bare
// reference they are ordinary characters (a single quote or backtick in a query
// or path is not a terminator).
const QUOTE_CHARS = new Set(['"', "'", "`"]);

// The run of non-space characters that starts at an absolute http(s) URL in
// text, as it appears. Quote characters are taken as part of the run, so a bare
// reference that contains one is captured whole; `extractUrls` decides whether a
// leading quote instead delimits a markup reference.
const ABSOLUTE_URL_IN_TEXT = /https?:\/\/[^\s<>]+/gi;

// The absolute http(s) URLs that appear in text, each parsed (so an unparseable
// match is dropped) and serialized. When a quote character immediately precedes
// the URL it opens a markup reference, which ends at its matching close; a
// missing close is ambiguous and the whole token is dropped rather than cut to a
// prefix. Otherwise the run is the bare reference and any quote in it is part of
// the URL.
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(ABSOLUTE_URL_IN_TEXT)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const open = index > 0 ? text[index - 1] : "";
    let candidate = raw;
    if (QUOTE_CHARS.has(open)) {
      const close = raw.indexOf(open);
      if (close === -1) continue;
      candidate = raw.slice(0, close);
    }
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

// Record the complete links a page carried (extract.ts). Each is already an
// absolute URL, so nothing is resolved or rebuilt from display text.
export function recordLinks(recorded: Map<string, string>, links: readonly string[]): void {
  for (const link of links) recordUrl(recorded, link);
}
