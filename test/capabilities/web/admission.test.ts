// URL provenance and the admission budgets (bob#152, spec v3, slice R1c).
// Units: the exact URL rule, the recording sources, and the two budgets.

import { describe, expect, it } from "bun:test";
import {
  admitCandidate,
  chargeFetchAttempt,
  chargeText,
  newTurnState,
  originKey,
  recordPageLinks,
  textAllowanceRemaining,
  type WebTurnState,
} from "../../../src/capabilities/web/admission.js";
import type { WebSettings } from "../../../src/capabilities/web/core.js";
import { isWebFetchError } from "../../../src/capabilities/web/errors.js";
import { extractDocument } from "../../../src/capabilities/web/extract.js";
import {
  extractUrls,
  parseAbsolute,
  recordUrl,
  urlKey,
} from "../../../src/capabilities/web/provenance.js";
import type { TurnOrigin } from "../../../src/shell/turn-origin.js";

const RUN: TurnOrigin = { kind: "run" };

function settings(over: Partial<WebSettings> = {}): WebSettings {
  return {
    allowHttp: false,
    fetchMaxChars: 20_000,
    fetchPerTurn: 10,
    textPerTurn: 100_000,
    ...over,
  };
}

function stateFor(prompt: string, origin: TurnOrigin = RUN): WebTurnState {
  return newTurnState(prompt, origin);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isWebFetchError(error)) return error.code;
    throw error;
  }
  throw new Error("expected a refusal, got none");
}

describe("URL provenance — the exact rule", () => {
  it("compares scheme, host, effective port, path and the complete query; a fragment grants nothing", () => {
    const state = stateFor("link https://Example.COM:443/a/b?x=1&y=2#frag");
    // The recorded URL's fragment is stripped; the candidate's is too.
    const admitted = admitCandidate(state, "https://example.com/a/b?x=1&y=2");
    expect(admitted.href).toBe("https://example.com/a/b?x=1&y=2");
    expect(admitCandidate(state, "https://example.com/a/b?x=1&y=2#other").href).toBe(
      "https://example.com/a/b?x=1&y=2",
    );
  });

  it("dispatches the parsed candidate with its fragment stripped", () => {
    const state = stateFor("https://host.test/p?q=1");
    expect(admitCandidate(state, "https://host.test/p?q=1#top").hash).toBe("");
  });

  it("refuses query bytes the message did not carry (no decoding or reordering)", () => {
    const state = stateFor("https://host.test/p?b=2&a=1");
    expect(codeOf(() => admitCandidate(state, "https://host.test/p?a=1&b=2"))).toBe(
      "url-unrecorded",
    );
    expect(codeOf(() => admitCandidate(state, "https://host.test/p?b=%32&a=1"))).toBe(
      "url-unrecorded",
    );
  });

  it("grants no host-only access: a different path on a recorded host is refused", () => {
    const state = stateFor("https://host.test/a");
    expect(codeOf(() => admitCandidate(state, "https://host.test/b"))).toBe("url-unrecorded");
  });

  it("refuses a URL built by appending to a recorded one", () => {
    const state = stateFor("https://host.test/a");
    expect(codeOf(() => admitCandidate(state, "https://host.test/a?leak=1"))).toBe(
      "url-unrecorded",
    );
    expect(codeOf(() => admitCandidate(state, "https://host.test/ab"))).toBe("url-unrecorded");
  });

  it("refuses a recorded URL from a previous prompt (fresh state per admission)", () => {
    const first = stateFor("https://host.test/a");
    expect(admitCandidate(first, "https://host.test/a").href).toBe("https://host.test/a");
    const second = stateFor("nothing relevant here");
    expect(codeOf(() => admitCandidate(second, "https://host.test/a"))).toBe("url-unrecorded");
  });

  it("keeps an empty query distinct from no query (probe)", () => {
    const noQuery = stateFor("https://host.test/p");
    expect(codeOf(() => admitCandidate(noQuery, "https://host.test/p?"))).toBe("url-unrecorded");
    const emptyQuery = stateFor("https://host.test/p?");
    expect(admitCandidate(emptyQuery, "https://host.test/p?").href).toBe("https://host.test/p?");
    expect(codeOf(() => admitCandidate(emptyQuery, "https://host.test/p"))).toBe("url-unrecorded");
  });

  it("does not grant a shortened spelling of the message URL (punctuation probe)", () => {
    const state = stateFor("read https://host.test/p?x=1!");
    expect(admitCandidate(state, "https://host.test/p?x=1!").href).toBe("https://host.test/p?x=1!");
    expect(codeOf(() => admitCandidate(state, "https://host.test/p?x=1"))).toBe("url-unrecorded");
  });

  it("refuses a relative or non-http(s) candidate as unparseable", () => {
    const state = stateFor("https://host.test/a");
    expect(codeOf(() => admitCandidate(state, "/a"))).toBe("url-invalid");
    expect(codeOf(() => admitCandidate(state, "ftp://host.test/a"))).toBe("url-invalid");
  });
});

describe("URL provenance — recording sources", () => {
  it("records the triggering message and both http and https URLs", () => {
    const state = stateFor("see http://a.test/x and https://b.test/y");
    expect(admitCandidate(state, "http://a.test/x").href).toBe("http://a.test/x");
    expect(admitCandidate(state, "https://b.test/y").href).toBe("https://b.test/y");
  });

  it("records a link on a fetched page, resolved against that page (real extractor)", () => {
    // The R1b extractor renders a link as `text (resolved url)`, resolving a
    // relative href against the page URL, AND reports the resolved link itself.
    const doc = extractDocument(
      "text/html",
      '<a href="/next">next</a>',
      "https://host.test/deep/page",
    );
    expect(doc.text).toBe("next (https://host.test/next)");
    expect(doc.links).toEqual(["https://host.test/next"]);
    const state = stateFor("https://host.test/deep/page");
    recordPageLinks(state, doc.links);
    expect(admitCandidate(state, "https://host.test/next").href).toBe("https://host.test/next");
  });

  it("extractUrls takes the absolute URL whole, keeping punctuation in the reference", () => {
    expect(extractUrls("read https://host.test/p?x=1!")).toEqual(["https://host.test/p?x=1!"]);
    expect(extractUrls("see http://a.test/x and https://b.test/y")).toEqual([
      "http://a.test/x",
      "https://b.test/y",
    ]);
  });

  it("a fragment recorded from the message still matches a fragmentless candidate", () => {
    const state = stateFor("https://host.test/p#section");
    expect(admitCandidate(state, "https://host.test/p").href).toBe("https://host.test/p");
  });
});

describe("urlKey and parseAbsolute", () => {
  it("keeps an empty query delimiter and drops the default port (effective port)", () => {
    expect(urlKey(new URL("https://host.test:443/a"))).toBe("https://host.test/a");
    expect(urlKey(new URL("https://host.test:8443/a"))).toBe("https://host.test:8443/a");
    expect(urlKey(new URL("https://host.test/p?"))).toBe("https://host.test/p?");
    expect(urlKey(new URL("https://host.test/p"))).toBe("https://host.test/p");
  });

  it("parseAbsolute refuses a relative string and a non-http scheme", () => {
    expect(parseAbsolute("/a")).toBeUndefined();
    expect(parseAbsolute("mailto:x@y")).toBeUndefined();
    expect(parseAbsolute("HTTPS://Host.Test/A")?.href).toBe("https://host.test/A");
  });

  it("recordUrl ignores an unparseable or non-http(s) value", () => {
    const map = new Map<string, string>();
    recordUrl(map, "not a url");
    recordUrl(map, "ws://host.test/");
    expect(map.size).toBe(0);
  });
});

describe("admission budgets", () => {
  it("charges a fetch attempt and refuses once the budget is spent", () => {
    const state = stateFor("x");
    const cfg = settings({ fetchPerTurn: 2 });
    chargeFetchAttempt(state, cfg);
    chargeFetchAttempt(state, cfg);
    expect(state.fetchAttempts).toBe(2);
    expect(codeOf(() => chargeFetchAttempt(state, cfg))).toBe("budget-fetch");
  });

  it("charges the returned text against the shared allowance and reports what remains", () => {
    const state = stateFor("x");
    const cfg = settings({ textPerTurn: 100 });
    chargeText(state, cfg, 60);
    expect(textAllowanceRemaining(state, cfg)).toBe(40);
    expect(codeOf(() => chargeText(state, cfg, 41))).toBe("budget-text");
    chargeText(state, cfg, 40);
    expect(textAllowanceRemaining(state, cfg)).toBe(0);
  });

  it("charges text across calls so the aggregate is bounded", () => {
    const state = stateFor("x");
    const cfg = settings({ textPerTurn: 100 });
    chargeText(state, cfg, 100);
    expect(textAllowanceRemaining(state, cfg)).toBe(0);
    expect(codeOf(() => chargeText(state, cfg, 1))).toBe("budget-text");
  });
});

describe("originKey", () => {
  it("compares origins by value", () => {
    expect(originKey({ kind: "run" })).toBe("run");
    expect(originKey({ kind: "cron", job: "brief" })).toBe("cron:brief");
    expect(originKey({ kind: "cron", job: "other" })).not.toBe(
      originKey({ kind: "cron", job: "brief" }),
    );
  });
});
