// The web extension's per-prompt state wiring (bob#152, spec v3, slice R1c),
// driven through wireWebCapability with a fake pi and an injected fetch.

import { describe, expect, it } from "bun:test";
import { type WebPiLike, wireWebCapability } from "../../../src/capabilities/web/capability.js";
import type { WebSettings } from "../../../src/capabilities/web/core.js";
import { isWebFetchError } from "../../../src/capabilities/web/errors.js";
import type { FetchResult } from "../../../src/capabilities/web/fetch.js";
import type { TurnOrigin } from "../../../src/shell/turn-origin.js";

const RUN: TurnOrigin = { kind: "run" };

function settings(): WebSettings {
  return { allowHttp: false, fetchMaxChars: 20_000, fetchPerTurn: 10, textPerTurn: 100_000 };
}

interface FakePi {
  pi: WebPiLike;
  fire: (type: string, event?: { prompt: string }) => void;
  tools: Array<{ execute: (id: string, params: unknown) => Promise<unknown> }>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event: { prompt: string }) => void>>();
  const tools: Array<{ execute: (id: string, params: unknown) => Promise<unknown> }> = [];
  const pi = {
    on(type: string, handler: (event: { prompt: string }) => void) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    registerTool(tool: { execute: (id: string, params: unknown) => Promise<unknown> }) {
      tools.push(tool);
    },
  } as unknown as WebPiLike;
  const fire = (type: string, event: { prompt: string } = { prompt: "" }): void => {
    for (const handler of handlers.get(type) ?? []) handler(event);
  };
  return { pi, fire, tools };
}

function ok(url: string, text: string): FetchResult {
  return { finalUrl: url, status: 200, contentType: "text/plain", text, truncated: false };
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

function wire(origin: () => TurnOrigin | undefined, fetchCalls: string[] = []) {
  const fake = fakePi();
  const handle = wireWebCapability({
    pi: fake.pi,
    settings: settings(),
    admission: { readOrigin: origin },
    fetch: async (url) => {
      fetchCalls.push(url);
      return ok(url, "page text");
    },
  });
  return { ...fake, handle, fetchCalls };
}

describe("web extension — per-prompt state", () => {
  it("seeds at before_agent_start and fetches a URL from the triggering message", async () => {
    const w = wire(() => RUN);
    w.fire("before_agent_start", { prompt: "read https://a.test/x" });
    expect(w.handle.currentState()).toBeDefined();
    await w.tools[0].execute("id", { url: "https://a.test/x" });
    expect(w.fetchCalls).toEqual(["https://a.test/x"]);
  });

  it("clears on a full agent_settled: the next tool call has no state", async () => {
    const w = wire(() => RUN);
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    w.fire("agent_settled");
    expect(w.handle.currentState()).toBeUndefined();
    expect(await codeOf(w.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "no-admission",
    );
  });

  it("clears on session_shutdown", async () => {
    const w = wire(() => RUN);
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    w.fire("session_shutdown");
    expect(w.handle.currentState()).toBeUndefined();
  });

  it("does NOT clear mid-prompt: agent_end and turn boundaries keep the state", async () => {
    const w = wire(() => RUN);
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    w.fire("agent_end");
    w.fire("turn_start");
    w.fire("turn_end");
    await w.tools[0].execute("id", { url: "https://a.test/x" });
    expect(w.fetchCalls).toEqual(["https://a.test/x"]);
  });

  it("starts a fresh state per prompt: a prior prompt's URL is not fetchable", async () => {
    const w = wire(() => RUN);
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    // No settle event: a repeated before_agent_start still wins.
    w.fire("before_agent_start", { prompt: "https://b.test/y" });
    expect(await codeOf(w.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "url-unrecorded",
    );
    await w.tools[0].execute("id", { url: "https://b.test/y" });
    expect(w.fetchCalls).toEqual(["https://b.test/y"]);
  });

  it("holds the budgets across calls in one prompt (retries/continuations)", async () => {
    const w = wire(() => RUN);
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    await w.tools[0].execute("id", { url: "https://a.test/x" });
    await w.tools[0].execute("id", { url: "https://a.test/x" });
    const state = w.handle.currentState();
    expect(state?.fetchAttempts).toBe(2);
  });

  it("refuses with no state before any before_agent_start (a failed preflight seeds nothing)", async () => {
    const w = wire(() => RUN);
    expect(await codeOf(w.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "no-admission",
    );
  });

  it("seeds nothing without an admission: the tool is refused even after before_agent_start", async () => {
    const fake = fakePi();
    const handle = wireWebCapability({
      pi: fake.pi,
      settings: settings(),
      fetch: async () => ok("x", "y"),
    });
    fake.fire("before_agent_start", { prompt: "https://a.test/x" });
    expect(handle.currentState()).toBeUndefined();
    expect(await codeOf(fake.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "no-admission",
    );
  });

  it("refuses a call whose running admission differs from the seeded one", async () => {
    let origin: TurnOrigin = { kind: "cron", job: "brief" };
    const w = wire(() => origin);
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    origin = RUN;
    expect(await codeOf(w.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "admission-mismatch",
    );
  });
});
