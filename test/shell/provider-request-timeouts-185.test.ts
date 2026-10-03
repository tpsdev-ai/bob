import { describe, expect, it } from "bun:test";
import {
  ProviderRequestTimeoutError,
  ProviderStreamIdleTimeoutError,
  withStreamTimeouts,
} from "../../src/shell/provider-request-policy.js";
import { memoryServer, sleep } from "./provider-timeout-fixture.js";

describe("bob#185 item 1 — the request-timeout mechanism", () => {
  it("allows successive body reads shorter than the idle timeout", async () => {
    const server = memoryServer({ chunks: 8, chunkDelayMs: 25 });
    const guarded = withStreamTimeouts(
      server.fetch,
      {
        idleTimeoutMs: 150,
        totalTimeoutMs: 0,
        maxRetries: 0,
      },
      "fake-local",
    );
    const response = await guarded("http://fake.local/v1/chat/completions");
    expect(await response.text()).toContain("tok7");
    expect(server.requests).toBe(1);
  });

  it.each([false, true])(
    "excludes consumer pauses while chunks arrive, with a chunk already read=%s",
    async (readFirst) => {
      const server = memoryServer({ chunks: 10, chunkDelayMs: 200 });
      const timeouts: Error[] = [];
      const guarded = withStreamTimeouts(
        server.fetch,
        { idleTimeoutMs: 1_000, totalTimeoutMs: 0, maxRetries: 0 },
        "fake-local",
        undefined,
        (error) => timeouts.push(error),
      );
      const response = await guarded("http://fake.local/v1/chat/completions");
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("no response body");
      let text = "";
      const decoder = new TextDecoder();
      if (readFirst) {
        const first = await reader.read();
        expect(first.done).toBe(false);
        text += decoder.decode(first.value);
      }
      await sleep(1_500);
      expect(timeouts).toEqual([]);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      expect(text).toContain("tok0");
      expect(text).toContain("tok9");
      expect(timeouts).toEqual([]);
    },
  );

  it("starts the idle clock when a paused consumer resumes a stalled read", async () => {
    const server = memoryServer({ stall: true });
    const timeouts: Error[] = [];
    const guarded = withStreamTimeouts(
      server.fetch,
      { idleTimeoutMs: 50, totalTimeoutMs: 0, maxRetries: 0 },
      "fake-local",
      undefined,
      (error) => timeouts.push(error),
    );
    const response = await guarded("http://fake.local/v1/chat/completions");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no response body");
    expect((await reader.read()).done).toBe(false);
    await sleep(150);
    expect(timeouts).toEqual([]);
    await expect(reader.read()).rejects.toBeInstanceOf(ProviderStreamIdleTimeoutError);
    expect(timeouts).toHaveLength(1);
  });

  it("reports an idle stream with the named idle error", async () => {
    const server = memoryServer({ stall: true });
    const guarded = withStreamTimeouts(
      server.fetch,
      {
        idleTimeoutMs: 50,
        totalTimeoutMs: 0,
        maxRetries: 5,
      },
      "fake-local",
    );
    const response = await guarded("http://fake.local/v1/chat/completions");
    const text = response.text();
    await expect(text).rejects.toBeInstanceOf(ProviderStreamIdleTimeoutError);
    await expect(text).rejects.toThrow(
      'provider "fake-local": waiting for response headers or a body chunk exceeded 50 ms',
    );
    expect(server.requests).toBe(1);
  });

  it("reports a request past its total cap with the named total error", async () => {
    const server = memoryServer({ chunks: 100, chunkDelayMs: 20 });
    const guarded = withStreamTimeouts(
      server.fetch,
      {
        idleTimeoutMs: 150,
        totalTimeoutMs: 100,
        maxRetries: 0,
      },
      "fake-local",
    );
    const response = await guarded("http://fake.local/v1/chat/completions");
    await expect(response.text()).rejects.toBeInstanceOf(ProviderRequestTimeoutError);
  });

  it("preserves a pre-aborted Request signal", async () => {
    const caller = new AbortController();
    const reason = new Error("caller cancelled");
    caller.abort(reason);
    let seen: AbortSignal | null | undefined;
    const base = (async (_input: unknown, init?: RequestInit) => {
      seen = init?.signal;
      seen?.throwIfAborted();
      return new Response();
    }) as typeof globalThis.fetch;
    const guarded = withStreamTimeouts(
      base,
      {
        idleTimeoutMs: 1000,
        totalTimeoutMs: 0,
        maxRetries: 0,
      },
      "fake-local",
    );
    await expect(
      guarded(new Request("http://fake.local/", { signal: caller.signal })),
    ).rejects.toBe(reason);
    expect(seen?.aborted).toBe(true);
  });
});
