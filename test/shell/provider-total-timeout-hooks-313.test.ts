import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installBaseUrlTransport } from "../../src/shell/base-url-transport.js";
import { initAgent } from "../../src/shell/init.js";
import { PROVIDER_RECORDS, ProviderRegistry } from "../../src/shell/provider-registry.js";
import {
  type ProviderRequestPolicy,
  ProviderRequestTimeoutError,
  withStreamTimeouts,
} from "../../src/shell/provider-request-policy.js";
import { memoryServer, sleep } from "./provider-timeout-fixture.js";

const CONTEXT = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
const ENDPOINT = "http://fake.local/v1";
const originalFetch = globalThis.fetch;

describe("bob#313 — pi hooks and the transport deadline", () => {
  let root: string;
  let keysRoot: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-313-hooks-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-313-hooks-keys-"));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  async function transportFor(request: ProviderRequestPolicy) {
    const row = {
      id: "fake-local",
      aliases: [],
      runtime: "fake-local",
      auth: { kind: "none" as const },
      endpoint: ENDPOINT,
      api: "openai-completions" as const,
      override: {},
    };
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row as never]);
    const result = initAgent({
      name: "fakebot",
      role: "ea",
      provider: row.id,
      model: "m",
      contextWindow: 262_144,
      agentsRoot: root,
      flairKeysDir: keysRoot,
      skipFlair: true,
      registry,
    });
    const runtime = await ModelRuntime.create({
      authPath: join(result.agentDir, ".pi-agent", "auth.json"),
      modelsPath: join(result.agentDir, ".pi-agent", "models.json"),
    });
    installBaseUrlTransport(runtime, row.runtime, row.endpoint, request);
    const model = runtime.getModel(row.runtime, "m");
    if (model === undefined) throw new Error("no model");
    return { runtime, model };
  }

  it.each(["streamSimple", "stream"] as const)(
    "%s: zero retries start the total timer at fetch after a slow payload hook",
    async (verb) => {
      const server = memoryServer({});
      globalThis.fetch = server.fetch;
      const { runtime, model } = await transportFor({
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 100,
        maxRetries: 0,
      });
      let hookFinished = false;
      const started = Date.now();
      const reply = await runtime[verb](model as never, CONTEXT as never, {
        onPayload: async () => {
          await sleep(250);
          hookFinished = true;
        },
      }).result();
      expect(hookFinished).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(server.requests).toBe(1);
      expect(reply.stopReason).toBe("stop");
      expect(reply.errorMessage).toBeUndefined();
    },
    3_000,
  );

  it.each([
    ["streamSimple", "onPayload"],
    ["streamSimple", "onResponse"],
    ["stream", "onPayload"],
    ["stream", "onResponse"],
  ] as const)(
    "%s: emits one timeout while pi awaits %s",
    async (verb, hook) => {
      const server = memoryServer({});
      globalThis.fetch = server.fetch;
      const { runtime, model } = await transportFor({
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 100,
        maxRetries: 2,
      });
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let hookStarted = false;
      let hookFinished = false;
      const caller = new AbortController();
      const events: AssistantMessageEvent[] = [];
      const stream = runtime[verb](model as never, CONTEXT as never, {
        signal: caller.signal,
        [hook]: async () => {
          hookStarted = true;
          await pending;
          hookFinished = true;
        },
      });
      const consume = (async () => {
        for await (const event of stream) events.push(event);
      })();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const reply = await Promise.race([
          stream.result(),
          new Promise<never>((_resolve, reject) => {
            watchdog = setTimeout(() => reject(new Error("transport still awaits pi hook")), 700);
          }),
        ]);
        await consume;
        expect(hookStarted).toBe(true);
        expect(hookFinished).toBe(false);
        expect(reply.stopReason).toBe("error");
        expect(reply.errorMessage).toContain("ProviderRequestTimeoutError");
        expect(reply.errorMessage).toContain('provider "fake-local"');
        expect(caller.signal.aborted).toBe(false);
        expect(server.requests).toBe(hook === "onPayload" ? 0 : 1);
        expect(events.map((event) => event.type)).toEqual(["error"]);
        release();
        await sleep(50);
        expect(hookFinished).toBe(true);
        expect(reply.stopReason).toBe("error");
        expect(events.map((event) => event.type)).toEqual(["error"]);
      } finally {
        clearTimeout(watchdog);
        release();
        await consume;
      }
    },
    3_000,
  );

  it("an expired deadline rejects without fetch or live timers and removes the abort listener", async () => {
    const caller = new AbortController();
    const add = spyOn(caller.signal, "addEventListener");
    const remove = spyOn(caller.signal, "removeEventListener");
    let calls = 0;
    let timerCalls = 0;
    const errors: Error[] = [];
    const base = (async () => {
      calls += 1;
      return new Response();
    }) as typeof globalThis.fetch;
    const guarded = withStreamTimeouts(
      base,
      { idleTimeoutMs: 1_000, totalTimeoutMs: 100, maxRetries: 2 },
      "fake-local",
      {
        setTimeout: (callback, ms) => {
          timerCalls += 1;
          return setTimeout(callback, ms);
        },
        clearTimeout,
      },
      (error) => errors.push(error),
      Date.now() - 1,
    );
    try {
      let rejection: unknown;
      try {
        await guarded(ENDPOINT, { signal: caller.signal });
      } catch (error) {
        rejection = error;
      }
      expect(calls).toBe(0);
      expect(rejection).toBeInstanceOf(ProviderRequestTimeoutError);
      expect(timerCalls).toBe(0);
      expect(errors).toHaveLength(1);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
      expect(caller.signal.aborted).toBe(false);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  }, 3_000);
});
