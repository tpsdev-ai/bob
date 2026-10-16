// The web extension's per-operation state wiring (bob#152, spec v3, slice R1c),
// driven through wireWebCapability with a fake pi and an injected fetch. The
// token-lifetime cases use the REAL turn admission.

import { describe, expect, it } from "bun:test";
import { type WebPiLike, wireWebCapability } from "../../../src/capabilities/web/capability.js";
import type { WebSettings } from "../../../src/capabilities/web/core.js";
import { isWebFetchError } from "../../../src/capabilities/web/errors.js";
import type { FetchResult } from "../../../src/capabilities/web/fetch.js";
import type { AdmissionToken } from "../../../src/shell/turn-admission.js";
import { createTurnAdmission } from "../../../src/shell/turn-admission.js";
import type { TurnOrigin } from "../../../src/shell/turn-origin.js";

const RUN: TurnOrigin = { kind: "run" };
// Two admitted operations: distinct tokens.
const ADMISSION_A: AdmissionToken = {};
const ADMISSION_B: AdmissionToken = {};

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
  return {
    finalUrl: url,
    status: 200,
    contentType: "text/plain",
    text,
    truncated: false,
    links: [],
  };
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

function wire(
  token: () => AdmissionToken | undefined,
  origin: () => TurnOrigin = () => RUN,
  fetchCalls: string[] = [],
) {
  const fake = fakePi();
  const handle = wireWebCapability({
    pi: fake.pi,
    settings: settings(),
    admission: { activeAdmission: token, readOrigin: origin },
    fetch: async (url) => {
      fetchCalls.push(url);
      return ok(url, "page text");
    },
  });
  return { ...fake, handle, fetchCalls };
}

describe("web extension — per-operation state", () => {
  it("seeds at before_agent_start for an active admission and fetches a URL from the message", async () => {
    const w = wire(() => ADMISSION_A);
    w.fire("before_agent_start", { prompt: "read https://a.test/x" });
    expect(w.handle.currentState()).toBeDefined();
    await w.tools[0].execute("id", { url: "https://a.test/x" });
    expect(w.fetchCalls).toEqual(["https://a.test/x"]);
  });

  it("keeps recorded URLs and fetch-attempt spend across a continuation", async () => {
    const w = wire(() => ADMISSION_A);
    w.fire("before_agent_start", { prompt: "read https://a.test/x" });
    await w.tools[0].execute("id", { url: "https://a.test/x" });
    // A continuation sends another prompt inside the same admission: pi fires
    // before_agent_start again, but the token is unchanged, so the state (and
    // the recorded URL) survives.
    w.fire("before_agent_start", { prompt: "continue" });
    await w.tools[0].execute("id", { url: "https://a.test/x" });
    expect(w.fetchCalls).toEqual(["https://a.test/x", "https://a.test/x"]);
    expect(w.handle.currentState()?.fetchAttempts).toBe(2);
  });

  it("seeds a fresh state for a NEW admission: a prior admission's URL is not fetchable", async () => {
    let token: AdmissionToken = ADMISSION_A;
    const w = wire(() => token);
    w.fire("before_agent_start", { prompt: "read https://a.test/x" });
    token = ADMISSION_B;
    w.fire("before_agent_start", { prompt: "read https://b.test/y" });
    expect(await codeOf(w.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "url-unrecorded",
    );
    await w.tools[0].execute("id", { url: "https://b.test/y" });
    expect(w.fetchCalls).toEqual(["https://b.test/y"]);
  });

  it("seeds nothing for a bare prompt outside any admission: the tool is refused", async () => {
    const w = wire(() => undefined);
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    expect(w.handle.currentState()).toBeUndefined();
    expect(await codeOf(w.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "no-admission",
    );
  });

  it("drops a prior admission's state when a bare prompt arrives", async () => {
    let token: AdmissionToken | undefined = ADMISSION_A;
    const w = wire(() => token);
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    token = undefined;
    w.fire("before_agent_start", { prompt: "bare" });
    expect(w.handle.currentState()).toBeUndefined();
    expect(await codeOf(w.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "no-admission",
    );
  });

  it("clears on session_shutdown", async () => {
    const w = wire(() => ADMISSION_A);
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    w.fire("session_shutdown");
    expect(w.handle.currentState()).toBeUndefined();
  });

  it("refuses before the first before_agent_start", async () => {
    const w = wire(() => ADMISSION_A);
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

  it("refuses a call whose running origin differs from the seeded one", async () => {
    let origin: TurnOrigin = { kind: "cron", job: "brief" };
    const w = wire(
      () => ADMISSION_A,
      () => origin,
    );
    w.fire("before_agent_start", { prompt: "https://a.test/x" });
    origin = RUN;
    expect(await codeOf(w.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "admission-mismatch",
    );
  });
});

describe("web extension — admission token lifetime (real turn admission)", () => {
  // The REAL turn admission drives the REAL capability wiring. The minimal
  // session fires `before_agent_start` (pi's event) from INSIDE the admitted
  // prompt and settles at once; the late calls under test start no prompt.
  function bind() {
    return createTurnAdmission({ log: () => {} });
  }

  function sessionWith(
    admission: ReturnType<typeof createTurnAdmission>,
    onPrompt: (event: { prompt: string }) => void,
  ) {
    const session = {
      subscribe: () => () => {},
      waitForIdle: async () => {},
      async prompt(text: string) {
        onPrompt({ prompt: text });
      },
    };
    admission.bind(session as never);
  }

  it("refuses a call after settlement, from outside any admission context", async () => {
    const admission = bind();
    const w = fakePi();
    sessionWith(admission, (event) => w.fire("before_agent_start", event));
    const handle = wireWebCapability({
      pi: w.pi,
      settings: settings(),
      admission,
      fetch: async (url) => ok(url, "page text"),
    });
    await admission.admitTurn({ kind: "run" }, "https://a.test/x");
    // The operation has settled. The tool is called directly, outside any
    // admission context and without starting another prompt: no state is
    // exposed, though the settled operation's state was retained.
    expect(handle.currentState()).toBeUndefined();
    expect(await codeOf(w.tools[0].execute("id", { url: "https://a.test/x" }))).toBe(
      "no-admission",
    );
  });

  it("refuses a call after settlement from a captured descendant async context", async () => {
    const admission = bind();
    const w = fakePi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Registered while the admission is live, so the continuation inherits the
    // turn's async context; it runs only after the operation settles.
    let late: Promise<unknown> | undefined;
    sessionWith(admission, (event) => {
      w.fire("before_agent_start", event);
      late = gate.then(() => w.tools[0].execute("late", { url: "https://a.test/x" }));
    });
    wireWebCapability({
      pi: w.pi,
      settings: settings(),
      admission,
      fetch: async (url) => ok(url, "page text"),
    });
    await admission.admitTurn({ kind: "run" }, "https://a.test/x");
    release();
    expect(await codeOf(late as Promise<unknown>)).toBe("no-admission");
  });
});
