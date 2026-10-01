// The extractor (bob#245 — web spec v3, slice R1b): the content types the fetch
// core accepts, the text it returns for each, and the text limit.
//
// TYPES. HTML, plain text, Markdown, JSON, XML and the RSS/Atom types. Anything
// else is refused by the caller, naming the type (fetch.ts).
//
// TEXT. HTML is parsed with htmlparser2 (exactly pinned in package.json) and
// walked: script, style, noscript, template, head, iframe, svg, canvas, object
// and embed subtrees are dropped, an element that is hidden (the `hidden`
// attribute, `display: none`, `visibility: hidden`, `aria-hidden="true"`) is
// dropped with its subtree, block elements become line breaks, and a link is
// kept inline as `text (resolved url)` with its href resolved against the page
// URL. Every other allowed type is returned as it arrived, trimmed: the core
// does not restructure JSON, XML, RSS or Markdown.
//
// LIMIT. truncateText cuts to the character limit the caller resolved (the
// operator's ceiling, or a lower value the model asked for) and says whether it
// cut. It never ends on half of a surrogate pair.

import { ElementType, parseDocument } from "htmlparser2";

// The subset of htmlparser2's parsed node shape this file walks. Declared here
// rather than imported from domhandler (htmlparser2's own dependency, which
// this package does not depend on directly): the walker reads only these
// fields, and the parse is cast to this shape once.
interface HtmlNode {
  type: string;
  name: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
}

// The allowed media types, lowercased, without parameters.
export const ALLOWED_CONTENT_TYPES: readonly string[] = Object.freeze([
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
]);

// The media type of a content-type header value: lowercased, parameters
// (charset and the rest) dropped. Undefined when the value is absent or empty.
export function mediaTypeOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const media = value.split(";")[0].trim().toLowerCase();
  return media === "" ? undefined : media;
}

export function allowedContentType(media: string): boolean {
  return ALLOWED_CONTENT_TYPES.includes(media);
}

// Subtrees whose text is never returned.
const DROPPED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "iframe",
  "svg",
  "canvas",
  "object",
  "embed",
]);

// Elements that end the line they are on.
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function isHidden(element: HtmlNode): boolean {
  const attribs = element.attribs ?? {};
  if ("hidden" in attribs) return true;
  if (attribs["aria-hidden"] === "true") return true;
  const style = (attribs.style ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function textOf(element: HtmlNode): string {
  const parts: string[] = [];
  const walk = (node: HtmlNode): void => {
    for (const child of node.children ?? []) {
      if (child.type === ElementType.Text || child.type === ElementType.CDATA) {
        parts.push(child.data ?? "");
        continue;
      }
      if (child.type !== ElementType.Tag) continue;
      if (DROPPED_TAGS.has(child.name.toLowerCase()) || isHidden(child)) continue;
      walk(child);
    }
  };
  walk(element);
  return parts.join("");
}

// Resolve a link against the page it appeared on. A link that cannot be
// resolved is dropped (the text stays).
function resolveLink(href: string | undefined, baseUrl: string): string | undefined {
  if (href === undefined) return undefined;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return undefined;
  }
}

function htmlToText(html: string, baseUrl: string): string {
  const document = parseDocument(html) as unknown as HtmlNode;
  const parts: string[] = [];

  const walk = (element: HtmlNode): void => {
    for (const child of element.children ?? []) {
      if (child.type === ElementType.Text || child.type === ElementType.CDATA) {
        parts.push(child.data ?? "");
        continue;
      }
      if (child.type !== ElementType.Tag) continue;
      const tag = child.name.toLowerCase();
      if (DROPPED_TAGS.has(tag) || isHidden(child)) continue;
      if (tag === "a") {
        const text = textOf(child);
        const resolved = resolveLink(child.attribs?.href, baseUrl);
        parts.push(resolved === undefined ? text : `${text} (${resolved})`);
        continue;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) parts.push("\n");
      walk(child);
      if (block) parts.push("\n");
    }
  };
  walk(document);

  // Join, then trim every line and collapse the blank ones.
  const lines = parts
    .join("")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim());
  const kept: string[] = [];
  for (const line of lines) {
    if (line === "" && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

// The text of an allowed body. `media` has already passed allowedContentType.
export function extractText(media: string, body: string, baseUrl: string): string {
  if (media === "text/html") return htmlToText(body, baseUrl);
  return body.trim();
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

// Cut to `maxChars` characters, saying whether anything was cut. Never ends on
// the high half of a surrogate pair.
export function truncateText(text: string, maxChars: number): TruncatedText {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}
