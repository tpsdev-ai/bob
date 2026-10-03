import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installBaseUrlTransport } from "../../src/shell/base-url-transport.js";
import { initAgent } from "../../src/shell/init.js";
import {
  loadProviderRegistry,
  PROVIDER_RECORDS,
  ProviderRegistry,
} from "../../src/shell/provider-registry.js";

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

// ── The row owns the policy ──────────────────────────────────────────────────

describe("bob#185 item 1 — the selected provider row carries the policy", () => {
  it("every local row declares an idle timeout, a generous total cap and no blind retry", () => {
    const registry = new ProviderRegistry();
    for (const id of ["ollama", "ollama-newton", "omlx"]) {
      const row = registry.find(id);
      expect(row?.request).toEqual({
        idleTimeoutMs: 120_000,
        totalTimeoutMs: 1_800_000,
        maxRetries: 0,
      });
      expect(row?.request?.totalTimeoutMs ?? 0).toBeGreaterThanOrEqual(900_000);
      expect(row?.request?.maxRetries).toBe(0);
    }
  });

  it("a cloud row declares no policy, so its timeout and retry behaviour is unchanged", () => {
    const registry = new ProviderRegistry();
    for (const id of ["ollama-cloud", "anthropic", "openai", "openrouter"]) {
      expect(registry.find(id)?.request).toBeUndefined();
    }
    expect(PROVIDER_RECORDS.find((row) => row.id === "ollama-cloud")?.request).toBeUndefined();
  });

  it("the row's policy is frozen with the record", () => {
    const policy = new ProviderRegistry().find("ollama")?.request;
    expect(policy).toBeDefined();
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each([
    {
      name: "a nonzero total cap below the minimum",
      request: "request: {idleTimeoutMs: 2000, totalTimeoutMs: 60000, maxRetries: 0}",
      message: /totalTimeoutMs must be 0 or an integer within/,
    },
    {
      name: "an idle timeout below the minimum",
      request: "request: {idleTimeoutMs: 100, totalTimeoutMs: 1800000, maxRetries: 0}",
      message: /idleTimeoutMs must be an integer within/,
    },
    {
      name: "a retry count above the maximum",
      request: "request: {idleTimeoutMs: 2000, totalTimeoutMs: 1800000, maxRetries: 9}",
      message: /maxRetries must be an integer within/,
    },
    {
      name: "a non-integer field",
      request: "request: {idleTimeoutMs: 2000.5, totalTimeoutMs: 1800000, maxRetries: 0}",
      message: /idleTimeoutMs must be an integer within/,
    },
    {
      name: "a missing field",
      request: "request: {idleTimeoutMs: 2000, maxRetries: 0}",
      message: /must declare idleTimeoutMs, totalTimeoutMs and maxRetries/,
    },
    {
      name: "an unknown field",
      request: "request: {idleTimeoutMs: 2000, totalTimeoutMs: 1800000, maxRetries: 0, extra: 1}",
      message: /request has an unknown field/,
    },
  ])("an operator row with $name refuses at load by name", ({ request, message }) => {
    const dir = mkdtempSync(join(tmpdir(), "bob-185t-"));
    try {
      const path = join(dir, "providers.yaml");
      writeFileSync(
        path,
        `version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\n    ${request}\n`,
      );
      expect(() => loadProviderRegistry({ path })).toThrow(message);
      expect(() => loadProviderRegistry({ path })).toThrow(/row "acme"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an operator row may declare a policy within bounds", () => {
    const dir = mkdtempSync(join(tmpdir(), "bob-185t-"));
    try {
      const path = join(dir, "providers.yaml");
      writeFileSync(
        path,
        "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\n    request: {idleTimeoutMs: 1000, totalTimeoutMs: 900000, maxRetries: 0}\n",
      );
      const registry = loadProviderRegistry({ path });
      expect(registry.find("acme")?.request).toEqual({
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 900_000,
        maxRetries: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The real request path uses the row's policy ──────────────────────────────

describe("bob#185 item 1 — a keyless session request uses its row's policy", () => {
  let root: string;
  let keysRoot: string;
  let servers: FakeServer[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-185t-e2e-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-185t-keys-"));
    servers = [];
  });
  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  function scaffold(endpoint: string) {
    const row = {
      id: "fake-local",
      aliases: [],
      runtime: "fake-local",
      auth: { kind: "none" as const },
      endpoint,
      api: "openai-completions" as const,
      override: {},
      request: { idleTimeoutMs: 1_000, totalTimeoutMs: 1_800_000, maxRetries: 5 },
    };
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row]);
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
    return { registry, row, agentDir: result.agentDir };
  }

  async function runtimeFor(agentDir: string) {
    return ModelRuntime.create({
      authPath: join(agentDir, ".pi-agent", "auth.json"),
      modelsPath: join(agentDir, ".pi-agent", "models.json"),
    });
  }

  const context = {
    messages: [{ role: "user" as const, content: "hi", timestamp: 0 }],
  };

  it("a steady stream from a local row is not cut off by the old total timeout", async () => {
    const server = await startFakeServer(async (res, signal) => {
      for (let i = 0; i < 8; i++) {
        if (signal.aborted) return;
        res.write(SSE_CHUNK(`tok${i}`, null));
        await sleep(80);
      }
      res.write(SSE_CHUNK("", "stop"));
      res.write(SSE_DONE);
      res.end();
    });
    servers.push(server);
    const { registry, row, agentDir } = scaffold(server.url);
    const runtime = await runtimeFor(agentDir);
    installBaseUrlTransport(runtime, row.runtime, server.url, registry.find(row.id)?.request);
    const model = runtime.getModel(row.runtime, "m");
    if (model === undefined) throw new Error("model not found");
    const reply = await runtime.streamSimple(model, context as never, {} as never).result();
    expect(reply.stopReason).not.toBe("error");
    expect(server.requests).toBe(1);
  }, 15_000);

  it("an idle stream from a local row fails by name and is not retried", async () => {
    const server = await startFakeServer(async (res, signal) => {
      res.write(SSE_CHUNK("start", null));
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    servers.push(server);
    const { registry, row, agentDir } = scaffold(server.url);
    const runtime = await runtimeFor(agentDir);
    installBaseUrlTransport(runtime, row.runtime, server.url, registry.find(row.id)?.request);
    const model = runtime.getModel(row.runtime, "m");
    if (model === undefined) throw new Error("model not found");
    const reply = await runtime.streamSimple(model, context as never, {} as never).result();
    expect(reply.stopReason).toBe("error");
    expect(String(reply.errorMessage)).toContain("provider stream idle timeout");
    // maxRetries is 5 on the row, yet a timed-out generation is never retried.
    expect(server.requests).toBe(1);
  }, 15_000);
});
