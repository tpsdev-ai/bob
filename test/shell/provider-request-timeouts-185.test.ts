import { describe, expect, it } from "bun:test";
import {
  ProviderRequestTimeoutError,
  ProviderStreamIdleTimeoutError,
  withStreamTimeouts,
} from "../../src/shell/provider-request-policy.js";
import { memoryServer } from "./provider-timeout-fixture.js";

describe("bob#185 item 1 — the request-timeout mechanism", () => {
  it("resets idle timeout between received chunks", async () => {
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
    await expect(response.text()).rejects.toBeInstanceOf(ProviderStreamIdleTimeoutError);
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
