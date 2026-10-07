import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installBaseUrlTransport } from "../../src/shell/base-url-transport.js";
import { initAgent } from "../../src/shell/init.js";
import { PROVIDER_RECORDS, ProviderRegistry } from "../../src/shell/provider-registry.js";

const CONTEXT = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

/** A 127.0.0.1 server that stalls each request, then drops the socket. */
function stallingServer(
  resetAfterMs: number,
): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, _res) => {
    requests += 1;
    const socket = req.socket;
    sockets.add(socket);
    setTimeout(() => {
      sockets.delete(socket);
      socket.destroy();
    }, resetAfterMs).unref();
  });
  server.setTimeout(5_000);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the stub server bound no TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        requests: () => requests,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

describe("bob#313 — the total cap spans retries", () => {
  let root: string;
  let keysRoot: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-313-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-313-keys-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  async function transportFor(endpoint: string, request: Record<string, number>) {
    const row = {
      id: "fake-local",
      aliases: [],
      runtime: "fake-local",
      auth: { kind: "none" as const },
      endpoint,
      api: "openai-completions" as const,
      override: {},
    };
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row as never]);
    const result = initAgent({
      name: "fakebot",
      role: "ea",
      provider: "fake-local",
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
    installBaseUrlTransport(runtime, row.runtime, row.endpoint, request as never);
    const model = runtime.getModel(row.runtime, "m");
    if (model === undefined) throw new Error("no model");
    return { runtime, model };
  }

  it("reports the total timeout after a retryable connection error", async () => {
    const totalTimeoutMs = 500;
    const server = await stallingServer(100);
    try {
      const { runtime, model } = await transportFor(server.url, {
        idleTimeoutMs: 60_000,
        totalTimeoutMs,
        maxRetries: 2,
      });
      const started = Date.now();
      const reply = await runtime.streamSimple(model as never, CONTEXT as never, {}).result();
      const elapsed = Date.now() - started;
      expect(reply.stopReason).toBe("error");
      expect(reply.errorMessage).toContain("ProviderRequestTimeoutError");
      expect(reply.errorMessage).toContain('provider "fake-local"');
      expect(elapsed).toBeLessThan(totalTimeoutMs + 500);
    } finally {
      await server.close();
    }
  }, 15_000);

  it("a 0-retry row fails at the server's reset, before the total cap", async () => {
    const totalTimeoutMs = 500;
    const server = await stallingServer(100);
    try {
      const { runtime, model } = await transportFor(server.url, {
        idleTimeoutMs: 60_000,
        totalTimeoutMs,
        maxRetries: 0,
      });
      const started = Date.now();
      const reply = await runtime.streamSimple(model as never, CONTEXT as never, {}).result();
      const elapsed = Date.now() - started;
      expect(reply.stopReason).toBe("error");
      expect(reply.errorMessage).not.toContain("ProviderRequestTimeoutError");
      expect(server.requests()).toBe(1);
      expect(elapsed).toBeLessThan(totalTimeoutMs);
    } finally {
      await server.close();
    }
  }, 15_000);

  it("reports the total timeout during a server-requested retry delay", async () => {
    const totalTimeoutMs = 500;
    let requests = 0;
    const server: Server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(503, { "content-type": "application/json", "retry-after-ms": "2000" });
      res.end(JSON.stringify({ error: { message: "unavailable" } }));
    });
    server.setTimeout(5_000);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const { runtime, model } = await transportFor(`http://127.0.0.1:${address.port}/v1`, {
        idleTimeoutMs: 60_000,
        totalTimeoutMs,
        maxRetries: 2,
      });
      const started = Date.now();
      const reply = await runtime.streamSimple(model as never, CONTEXT as never, {}).result();
      const elapsed = Date.now() - started;
      expect(reply.stopReason).toBe("error");
      expect(reply.errorMessage).toContain("ProviderRequestTimeoutError");
      expect(requests).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(totalTimeoutMs + 500);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 15_000);
});
