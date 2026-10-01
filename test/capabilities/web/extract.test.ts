// The web fetch core's extractor and text limit (bob#245 — web spec v3, slice
// R1b). Pure: no sockets, no runtime-specific transport — the extractor runs
// wherever bob's code runs.

import { describe, expect, it } from "bun:test";
import {
  ALLOWED_CONTENT_TYPES,
  allowedContentType,
  extractText,
  mediaTypeOf,
  truncateText,
} from "../../../src/capabilities/web/index.js";

const BASE = "https://page.test/docs/index.html";

const RICH_HTML = [
  "<html>",
  "<head><title>Dropped title</title><meta charset='utf-8'></head>",
  "<body>",
  "<script>alert('dropped')</script>",
  "<style>p{color:red}</style>",
  "<h1>Heading</h1>",
  '<p>Hello &amp; welcome <a href="/rel">relative</a> and <a href="https://other.test/abs">absolute</a>.</p>',
  "<div hidden>hidden attribute</div>",
  '<div style="display: none">display none</div>',
  '<div style="visibility:hidden">visibility hidden</div>',
  '<div aria-hidden="true">aria hidden</div>',
  "<noscript>noscript text</noscript>",
  "<ul><li>one</li><li>two</li></ul>",
  "<p>tail &lt;kept&gt;</p>",
  "</body>",
  "</html>",
].join("");

describe("content types", () => {
  it("reads the media type out of a header value", () => {
    expect(mediaTypeOf("text/html; charset=utf-8")).toBe("text/html");
    expect(mediaTypeOf("  APPLICATION/JSON  ")).toBe("application/json");
    expect(mediaTypeOf("text/plain")).toBe("text/plain");
    expect(mediaTypeOf("")).toBeUndefined();
    expect(mediaTypeOf(undefined)).toBeUndefined();
    expect(mediaTypeOf(" ; charset=utf-8")).toBeUndefined();
  });

  it("allows exactly the documented types", () => {
    expect([...ALLOWED_CONTENT_TYPES]).toEqual([
      "text/html",
      "text/plain",
      "text/markdown",
      "application/json",
      "application/xml",
      "text/xml",
      "application/rss+xml",
      "application/atom+xml",
    ]);
    for (const allowed of ALLOWED_CONTENT_TYPES) expect(allowedContentType(allowed)).toBe(true);
    for (const refused of [
      "application/pdf",
      "image/png",
      "application/octet-stream",
      "application/javascript",
      "text/css",
      "text/htmlx",
    ]) {
      expect(allowedContentType(refused)).toBe(false);
    }
  });
});

describe("extraction", () => {
  it("drops scripts, styles, the head and hidden elements, and keeps links inline", () => {
    expect(extractText("text/html", RICH_HTML, BASE)).toBe(
      [
        "Heading",
        "",
        "Hello & welcome relative (https://page.test/rel) and absolute (https://other.test/abs).",
        "",
        "one",
        "",
        "two",
        "",
        "tail <kept>",
      ].join("\n"),
    );
  });

  it("keeps a link whose href cannot be resolved as its text", () => {
    expect(extractText("text/html", '<p>see <a href="http://[bad">this</a></p>', BASE)).toBe(
      "see this",
    );
  });

  it("returns every other allowed type as it arrived, trimmed", () => {
    expect(extractText("text/plain", "  plain text \n", BASE)).toBe("plain text");
    expect(extractText("text/markdown", "# heading\n\n- item\n", BASE)).toBe("# heading\n\n- item");
    expect(extractText("application/json", ' {"a":1} ', BASE)).toBe('{"a":1}');
    expect(extractText("application/xml", " <a>1</a> ", BASE)).toBe("<a>1</a>");
    expect(extractText("text/xml", "<b>2</b>", BASE)).toBe("<b>2</b>");
    expect(extractText("application/rss+xml", "<rss/>", BASE)).toBe("<rss/>");
    expect(extractText("application/atom+xml", "<feed/>", BASE)).toBe("<feed/>");
  });
});

describe("the text limit", () => {
  it("cuts to the limit and says so", () => {
    expect(truncateText("abc", 5)).toEqual({ text: "abc", truncated: false });
    expect(truncateText("abcde", 5)).toEqual({ text: "abcde", truncated: false });
    expect(truncateText("abcdef", 5)).toEqual({ text: "abcde", truncated: true });
    expect(truncateText("", 0)).toEqual({ text: "", truncated: false });
  });

  it("never ends on half of a surrogate pair", () => {
    // "😀" is two code units; a limit inside it drops the high half.
    expect(truncateText("a😀b", 2)).toEqual({ text: "a", truncated: true });
    expect(truncateText("a😀b", 3)).toEqual({ text: "a😀", truncated: true });
  });
});
