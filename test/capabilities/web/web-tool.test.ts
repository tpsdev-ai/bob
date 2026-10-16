// The `web_fetch` tool's provenance, budget and refusal rules (bob#152, spec
// v3, slice R1c), driven through the real tool with an injected fetch core.

import { describe, expect, it } from "bun:test";
import { newTurnState, type WebTurnState } from "../../../src/capabilities/web/admission.js";
import type { WebSettings } from "../../../src/capabilities/web/core.js";
import { isWebFetchError } from "../../../src/capabilities/web/errors.js";
import type { FetchResult } from "../../../src/capabilities/web/fetch.js";
import { createWebFetchTool, type WebFetchFn } from "../../../src/capabilities/web/tool.js";
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

function result(over: Partial<FetchResult> = {}): FetchResult {
  return {
    finalUrl: "https://host.test/a",
    status: 200,
    contentType: "text/plain",
    text: "hello",
    truncated: false,
    links: [],
    ...over,
  };
}

interface Calls {
  urls: string[];
  maxChars: number[];
}

function toolFor(
  state: WebTurnState | undefined,
  cfg: WebSettings,
  origin: () => TurnOrigin | undefined,
  fetch: WebFetchFn,
): ReturnType<typeof createWebFetchTool> & { calls: Calls } {
  const calls: Calls = { urls: [], maxChars: [] };
  const wrapped: WebFetchFn = (url, options) => {
    calls.urls.push(url);
    calls.maxChars.push(options.maxChars);
    return fetch(url, options);
  };
  const tool = createWebFetchTool({
    settings: cfg,
    currentState: () => state,
    currentOrigin: origin,
    fetch: wrapped,
  });
  return Object.assign(tool, { calls });
}

async function run(tool: ReturnType<typeof createWebFetchTool>, url: string, maxChars?: number) {
  const params = maxChars === undefined ? { url } : { url, maxChars };
  return tool.execute("call-1", params as never);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isWebFetchError(error)) return error.code;
    throw error;
  }
  throw new Error("expected a refusal, got a result");
}

describe("web_fetch — the success path", () => {
  it("fetches a recorded URL and returns its text, final URL, status and type", async () => {
    const state = newTurnState("go to https://host.test/a", RUN);
    let captured: FetchResult = result();
    const tool = toolFor(
      state,
      settings(),
      () => RUN,
      async (url, options) => {
        captured = result({ finalUrl: url, text: "hello world", contentType: "text/html" });
        void options;
        return captured;
      },
    );
    const out = (await run(tool, "https://host.test/a")) as {
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    };
    expect(tool.calls.urls).toEqual(["https://host.test/a"]);
    expect(out.details).toEqual({
      finalUrl: "https://host.test/a",
      status: 200,
      contentType: "text/html",
      truncated: false,
    });
    expect(out.content[0].text).toBe(
      "fetched https://host.test/a — HTTP 200 text/html\n\nhello world",
    );
  });

  it("records the complete links on the fetched page so a later call can follow them", async () => {
    const state = newTurnState("go to https://host.test/a", RUN);
    const tool = toolFor(
      state,
      settings(),
      () => RUN,
      async () => result({ finalUrl: "https://host.test/a", links: ["https://host.test/next"] }),
    );
    await run(tool, "https://host.test/a");
    // The recorded link is now fetchable without a second seed.
    const follow = toolFor(
      state,
      settings(),
      () => RUN,
      async (url) => result({ finalUrl: url, text: "second" }),
    );
    await run(follow, "https://host.test/next");
    expect(follow.calls.urls).toEqual(["https://host.test/next"]);
  });

  it("vets every redirect target against provenance before it is followed", async () => {
    const state = newTurnState("go to https://host.test/a", RUN);
    const tool = toolFor(
      state,
      settings(),
      () => RUN,
      async (url, options) => {
        // The injected core plays a redirect to an unrecorded destination: it
        // must pass the target through onRedirect, which refuses it.
        options.onRedirect?.(new URL("https://host.test/elsewhere"));
        return result({ finalUrl: url });
      },
    );
    expect(await codeOf(run(tool, "https://host.test/a"))).toBe("url-unrecorded");
  });

  it("accounts for the extracted document text, not the metadata line, in the allowance", async () => {
    // The advertised ceiling covers the extracted document text; the metadata
    // line the tool renders alongside it is not charged (blocker 5).
    const state = newTurnState("https://host.test/a", RUN);
    const cfg = settings({ textPerTurn: 5 });
    const tool = toolFor(
      state,
      cfg,
      () => RUN,
      async () => result({ text: "abcde", finalUrl: "https://host.test/a" }),
    );
    const out = (await run(tool, "https://host.test/a")) as {
      content: Array<{ text: string }>;
    };
    expect(state.textChars).toBe(5);
    // The returned content is the metadata line plus the five document
    // characters: the ceiling did not cover the metadata.
    expect(out.content[0].text.endsWith("\n\nabcde")).toBe(true);
    expect(out.content[0].text.length).toBeGreaterThan(5);
  });

  it("reports truncation in the meta line", async () => {
    const state = newTurnState("https://host.test/a", RUN);
    const tool = toolFor(
      state,
      settings(),
      () => RUN,
      async () => result({ text: "cut", truncated: true }),
    );
    const out = (await run(tool, "https://host.test/a")) as { content: Array<{ text: string }> };
    expect(out.content[0].text).toContain("; text truncated");
  });

  it("caps the text to the shared allowance remaining, and refuses when it is spent", async () => {
    const state = newTurnState("https://host.test/a", RUN);
    const cfg = settings({ textPerTurn: 5 });
    const tool = toolFor(
      state,
      cfg,
      () => RUN,
      async () => result({ text: "abcde" }),
    );
    // The tool lowers the core's limit to the allowance left (5 here).
    await run(tool, "https://host.test/a");
    expect(tool.calls.maxChars).toEqual([5]);
    expect(state.textChars).toBe(5);
    const second = toolFor(
      state,
      cfg,
      () => RUN,
      async () => result({ text: "x" }),
    );
    expect(await codeOf(run(second, "https://host.test/a"))).toBe("budget-text");
    expect(second.calls.urls).toEqual([]);
  });

  it("allows a caller to lower the limit but never above the operator ceiling", async () => {
    const state = newTurnState("https://host.test/a", RUN);
    const cfg = settings({ fetchMaxChars: 100 });
    const tool = toolFor(
      state,
      cfg,
      () => RUN,
      async () => result({ text: "z" }),
    );
    await run(tool, "https://host.test/a", 50);
    await run(tool, "https://host.test/a", 5_000);
    expect(tool.calls.maxChars).toEqual([50, 100]);
  });
});

describe("web_fetch — refusals", () => {
  it("refuses an unrecorded URL, suggesting search or asking for the link", async () => {
    const state = newTurnState("https://host.test/a", RUN);
    const tool = toolFor(
      state,
      settings(),
      () => RUN,
      async () => result(),
    );
    let detail = "";
    try {
      await run(tool, "https://host.test/b");
    } catch (error) {
      if (isWebFetchError(error)) detail = error.detail;
    }
    expect(detail).toContain("search for it or ask for the link");
    expect(tool.calls.urls).toEqual([]);
  });

  it("refuses a candidate that is not an absolute http(s) URL", async () => {
    const state = newTurnState("https://host.test/a", RUN);
    const tool = toolFor(
      state,
      settings(),
      () => RUN,
      async () => result(),
    );
    expect(await codeOf(run(tool, "example.test/a"))).toBe("url-invalid");
  });

  it("refuses absent state (no admitted prompt)", async () => {
    const tool = toolFor(
      undefined,
      settings(),
      () => RUN,
      async () => result(),
    );
    expect(await codeOf(run(tool, "https://host.test/a"))).toBe("no-admission");
  });

  it("refuses when the running admission does not match the seeded one", async () => {
    const state = newTurnState("https://host.test/a", { kind: "cron", job: "brief" });
    const tool = toolFor(
      state,
      settings(),
      () => RUN,
      async () => result(),
    );
    expect(await codeOf(run(tool, "https://host.test/a"))).toBe("admission-mismatch");
  });

  it("refuses absent admission origin even with state present", async () => {
    const state = newTurnState("https://host.test/a", RUN);
    const tool = toolFor(
      state,
      settings(),
      () => undefined,
      async () => result(),
    );
    expect(await codeOf(run(tool, "https://host.test/a"))).toBe("admission-mismatch");
  });
});

describe("web_fetch — budgets charge before I/O", () => {
  it("charges a failed call (the attempt still counts)", async () => {
    const state = newTurnState("https://host.test/a", RUN);
    const tool = toolFor(
      state,
      settings({ fetchPerTurn: 3 }),
      () => RUN,
      async () => {
        throw new Error("network blew up");
      },
    );
    await expect(run(tool, "https://host.test/a")).rejects.toThrow("network blew up");
    expect(state.fetchAttempts).toBe(1);
  });

  it("refuses the call after the attempt budget is spent", async () => {
    const state = newTurnState("https://host.test/a", RUN);
    const cfg = settings({ fetchPerTurn: 1 });
    const tool = toolFor(
      state,
      cfg,
      () => RUN,
      async () => result({ text: "x" }),
    );
    await run(tool, "https://host.test/a");
    expect(await codeOf(run(tool, "https://host.test/a"))).toBe("budget-fetch");
    expect(tool.calls.urls).toEqual(["https://host.test/a"]);
  });

  it("keeps the same budgets across calls in one admitted prompt (retries/continuations)", async () => {
    const state = newTurnState("https://host.test/a", RUN);
    const cfg = settings({ fetchPerTurn: 2 });
    const tool = toolFor(
      state,
      cfg,
      () => RUN,
      async () => result({ text: "x" }),
    );
    await run(tool, "https://host.test/a");
    await run(tool, "https://host.test/a");
    expect(state.fetchAttempts).toBe(2);
    expect(await codeOf(run(tool, "https://host.test/a"))).toBe("budget-fetch");
  });
});
