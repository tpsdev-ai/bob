import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import {
  type ProviderRequestPolicy,
  ProviderRequestTimeoutError,
  ProviderStreamIdleTimeoutError,
  withStreamTimeouts,
} from "../../src/shell/provider-request-policy.js";

const SSE_CHUNK = (content: string, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "1",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  })}\n\n`;
const SSE_DONE = "data: [DONE]\n\n";

interface FakeServer {
  url: string;
  requests: number;
  close: () => Promise<void>;
}

/** A fake OpenAI-compatible SSE server on loopback. No network leaves the host. */
async function startFakeServer(
  handler: (res: import("node:http").ServerResponse, signal: AbortSignal) => void | Promise<void>,
): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  let requests = 0;
  const server: Server = createServer((req, res) => {
    requests += 1;
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    void handler(res, controller.signal);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return requests;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections?.();
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("bob#185 item 1 — the request-timeout mechanism", () => {
  let servers: FakeServer[];
  beforeEach(() => {
    servers = [];
  });
  afterEach(async () => {
    for (const server of servers) await server.close();
  });

  it("a stream that keeps sending is not cut off by the idle timeout", async () => {
    const server = await startFakeServer(async (res, signal) => {
      for (let i = 0; i < 8; i++) {
        if (signal.aborted) return;
        res.write(SSE_CHUNK(`tok${i}`, null));
        await sleep(25);
      }
      res.write(SSE_CHUNK("", "stop"));
      res.write(SSE_DONE);
      res.end();
    });
    servers.push(server);
    const policy: ProviderRequestPolicy = {
      idleTimeoutMs: 150,
      totalTimeoutMs: 0,
      maxRetries: 0,
    };
    const guarded = withStreamTimeouts(globalThis.fetch, policy, "fake-local");
    const response = await guarded(`${server.url}/chat/completions`);
    const text = await response.text();
    expect(text).toContain("tok7");
    expect(text).toContain("[DONE]");
    expect(server.requests).toBe(1);
  }, 10_000);

  it("an idle stream fails with the named idle error and makes one request", async () => {
    const server = await startFakeServer(async (res, signal) => {
      res.write(SSE_CHUNK("start", null));
      // Then go silent: the idle timer must fire.
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    servers.push(server);
    const policy: ProviderRequestPolicy = {
      idleTimeoutMs: 200,
      totalTimeoutMs: 0,
      maxRetries: 5,
    };
    const guarded = withStreamTimeouts(globalThis.fetch, policy, "fake-local");
    const response = await guarded(`${server.url}/chat/completions`);
    const failure = await response.text().then(
      () => "accepted",
      (err: Error) => err,
    );
    expect(failure).toBeInstanceOf(ProviderStreamIdleTimeoutError);
    expect((failure as Error).name).toBe("ProviderStreamIdleTimeoutError");
    expect((failure as Error).message).toContain('provider "fake-local"');
    expect((failure as Error).message).toContain("idle timeout");
    expect(server.requests).toBe(1);
  }, 10_000);

  it("a request past the total cap fails with the named total error", async () => {
    const server = await startFakeServer(async (res, signal) => {
      while (!signal.aborted) {
        res.write(SSE_CHUNK("x", null));
        await sleep(20);
      }
    });
    servers.push(server);
    const policy: ProviderRequestPolicy = {
      idleTimeoutMs: 0,
      totalTimeoutMs: 300,
      maxRetries: 0,
    };
    const guarded = withStreamTimeouts(globalThis.fetch, policy, "fake-local");
    const response = await guarded(`${server.url}/chat/completions`);
    const failure = await response.text().then(
      () => "accepted",
      (err: Error) => err,
    );
    expect(failure).toBeInstanceOf(ProviderRequestTimeoutError);
    expect((failure as Error).name).toBe("ProviderRequestTimeoutError");
    expect((failure as Error).message).toContain("total request cap");
  }, 10_000);
});
