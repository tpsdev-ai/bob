// bob#185 item 2 — the per-turn reasoning / output budget from the selected
// provider row.
//
// Three properties, each exercised against a FAKE OpenAI-compatible server on
// loopback (no network leaves the host):
//   1. a local (keyless) row's request carries the declared output cap and
//      thinking level in the form pi's OpenAI-compatible adapter sends;
//   2. a row with no budget (the cloud shape) leaves the request unchanged;
//   3. an out-of-bounds or unknown budget refuses at load by row name.
// Plus the run log's evidence that a turn hit the row's output cap.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createRequestUsageTracker } from "../../src/shell/request-usage.js";
import { type RunSession, type RunSessionFactory, runAgent } from "../../src/shell/run.js";

const SSE_CHUNK = (content: string, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "1",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  })}\n\n`;
const SSE_DONE = "data: [DONE]\n\n";

interface FakeServer {
  url: string;
  bodies: Record<string, unknown>[];
  close: () => Promise<void>;
}

/** A fake OpenAI-compatible SSE server on loopback that captures each request
 *  body. No network leaves the host. */
async function startFakeServer(): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        bodies.push({ "x-unparseable": true });
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(SSE_CHUNK("ok", "stop"));
      res.write(SSE_DONE);
      res.end();
    });
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
    bodies,
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

// ── The row owns the budget ──────────────────────────────────────────────────

describe("bob#185 item 2 — the selected provider row carries the budget", () => {
  it("the local rows declare a budget; the cloud rows declare none", () => {
    const registry = new ProviderRegistry();
    for (const id of ["ollama", "ollama-newton", "omlx"]) {
      const row = registry.find(id);
      expect(row?.budget).toEqual({ maxOutputTokens: 4_096, reasoning: "low" });
      expect(row?.budget?.maxOutputTokens ?? 0).toBeLessThan(19_000);
    }
    for (const id of ["ollama-cloud", "anthropic", "openai", "openrouter"]) {
      expect(registry.find(id)?.budget).toBeUndefined();
    }
    expect(PROVIDER_RECORDS.find((row) => row.id === "ollama-cloud")?.budget).toBeUndefined();
  });

  it("the budget is frozen with the record", () => {
    const budget = new ProviderRegistry().find("ollama")?.budget;
    expect(budget).toBeDefined();
    expect(Object.isFrozen(budget)).toBe(true);
  });

  it.each([
    {
      name: "a cap above the maximum",
      budget: "budget: {maxOutputTokens: 131073, reasoning: low}",
      message: /budget\.maxOutputTokens must be an integer within/,
    },
    {
      name: "a cap below the minimum",
      budget: "budget: {maxOutputTokens: 10, reasoning: low}",
      message: /budget\.maxOutputTokens must be an integer within/,
    },
    {
      name: "a non-integer cap",
      budget: "budget: {maxOutputTokens: 4096.5, reasoning: low}",
      message: /budget\.maxOutputTokens must be an integer within/,
    },
    {
      name: "an unknown reasoning mode",
      budget: "budget: {maxOutputTokens: 4096, reasoning: xhigh}",
      message: /budget\.reasoning must be one of/,
    },
    {
      name: "a missing field",
      budget: "budget: {maxOutputTokens: 4096}",
      message: /budget must declare maxOutputTokens and reasoning/,
    },
    {
      name: "an unknown field",
      budget: "budget: {maxOutputTokens: 4096, reasoning: low, extra: 1}",
      message: /budget has an unknown field/,
    },
  ])("an operator row with $name refuses at load by name", ({ budget, message }) => {
    const dir = mkdtempSync(join(tmpdir(), "bob-185b-"));
    try {
      const path = join(dir, "providers.yaml");
      writeFileSync(
        path,
        `version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\n    ${budget}\n`,
      );
      expect(() => loadProviderRegistry({ path })).toThrow(message);
      expect(() => loadProviderRegistry({ path })).toThrow(/row "acme"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a budget on a non-keyless row refuses, because bob does not enforce it there", () => {
    const shipped = new ProviderRegistry().find("openrouter");
    if (shipped === undefined) throw new Error("no openrouter row");
    expect(
      () =>
        new ProviderRegistry([
          { ...shipped, budget: { maxOutputTokens: 4_096, reasoning: "low" } } as never,
        ]),
    ).toThrow(/budget but bob only enforces it on a bob\/none row/);
  });

  it("an operator row may declare a budget within bounds", () => {
    const dir = mkdtempSync(join(tmpdir(), "bob-185b-"));
    try {
      const path = join(dir, "providers.yaml");
      writeFileSync(
        path,
        "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\n    budget: {maxOutputTokens: 8192, reasoning: medium}\n",
      );
      const registry = loadProviderRegistry({ path });
      expect(registry.find("acme")?.budget).toEqual({
        maxOutputTokens: 8_192,
        reasoning: "medium",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The real request path carries the budget ─────────────────────────────────

describe("bob#185 item 2 — a keyless session request carries its row's budget", () => {
  let root: string;
  let keysRoot: string;
  let servers: FakeServer[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-185b-e2e-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-185b-keys-"));
    servers = [];
  });
  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  const context = {
    messages: [{ role: "user" as const, content: "hi", timestamp: 0 }],
  };

  async function run(
    keyless: {
      id: string;
      budget?: { maxOutputTokens: number; reasoning: string };
    },
    opts: { modelMaxTokens?: number } = {},
  ): Promise<Record<string, unknown>> {
    const row = {
      id: keyless.id,
      aliases: [],
      runtime: keyless.id,
      auth: { kind: "none" as const },
      endpoint: servers[0].url,
      api: "openai-completions" as const,
      override: {},
      ...(keyless.budget !== undefined ? { budget: keyless.budget as never } : {}),
    };
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row as never]);
    const result = initAgent({
      name: `bot-${keyless.id}`,
      role: "ea",
      provider: keyless.id,
      model: "m",
      contextWindow: 262_144,
      agentsRoot: root,
      flairKeysDir: keysRoot,
      skipFlair: true,
      registry,
    });
    const modelsPath = join(result.agentDir, ".pi-agent", "models.json");
    if (opts.modelMaxTokens !== undefined) {
      const models = JSON.parse(readFileSync(modelsPath, "utf8"));
      models.providers[row.runtime].models[0].maxTokens = opts.modelMaxTokens;
      writeFileSync(modelsPath, `${JSON.stringify(models)}\n`);
    }
    const runtime = await ModelRuntime.create({
      authPath: join(result.agentDir, ".pi-agent", "auth.json"),
      modelsPath,
    });
    installBaseUrlTransport(
      runtime,
      row.runtime,
      servers[0].url,
      registry.find(row.id)?.request,
      registry.find(row.id)?.budget,
    );
    const model = runtime.getModel(row.runtime, "m");
    if (model === undefined) throw new Error("model not found");
    await runtime.streamSimple(model, context as never, {} as never).result();
    return servers[0].bodies[servers[0].bodies.length - 1];
  }

  it("a local row's request carries the declared cap and level; a row with no budget is unchanged", async () => {
    const server = await startFakeServer();
    servers.push(server);
    const budgeted = await run({
      id: "fake-local",
      budget: { maxOutputTokens: 4_096, reasoning: "low" },
    });
    const plain = await run({ id: "fake-plain" });
    // The local row's request carries the declared setting ...
    expect(budgeted.max_tokens).toBe(4_096);
    expect(budgeted.max_completion_tokens).toBeUndefined();
    expect(budgeted.reasoning_effort).toBe("low");
    // ... while a row without a budget (the cloud shape) is unchanged: no
    // reasoning directive, no lowered cap, and no field forced.
    expect(plain.max_tokens).toBeUndefined();
    expect(plain.reasoning_effort).toBeUndefined();
    expect(plain.max_completion_tokens).toBe(16_384);
  });

  it("a lower per-agent output cap still wins over the row's cap", async () => {
    const server = await startFakeServer();
    servers.push(server);
    const budgeted = await run(
      { id: "fake-small", budget: { maxOutputTokens: 4_096, reasoning: "low" } },
      { modelMaxTokens: 2_048 },
    );
    expect(budgeted.max_tokens).toBe(2_048);
  });

  it("a non-thinking local row sends no reasoning directive but still caps output", async () => {
    const server = await startFakeServer();
    servers.push(server);
    const budgeted = await run({
      id: "fake-off",
      budget: { maxOutputTokens: 2_048, reasoning: "off" },
    });
    const plain = await run({ id: "fake-plain-off" });
    expect(budgeted.max_tokens).toBe(2_048);
    expect(budgeted.reasoning_effort).toBeUndefined();
    expect(plain.reasoning_effort).toBeUndefined();
  });
});

// ── The run log's evidence ───────────────────────────────────────────────────

describe("bob#185 item 2 — a capped turn is logged", () => {
  const messageEnd = (stopReason: string, output: number) => ({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "fake-local",
      model: "m",
      timestamp: 1_000,
      stopReason,
      usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output },
    },
  });

  it("a request at its length limit records provider, cap and tokens; other stops do not", () => {
    const tracker = createRequestUsageTracker(() => 2_000, { outputCap: 4_096 });
    expect(
      tracker.observe({ type: "message_start", message: { role: "assistant" } }),
    ).toBeUndefined();
    const record = tracker.observe(messageEnd("length", 4_096));
    expect(record?.provider).toBe("fake-local");
    expect(record?.stopReason).toBe("length");
    expect(record?.completionTokens).toBe(4_096);
    expect(record?.outputCap).toBe(4_096);
    // A record with no row cap, and a stop that is not a length stop, carry no
    // outputCap.
    const uncapped = createRequestUsageTracker(() => 2_000);
    uncapped.observe({ type: "message_start", message: { role: "assistant" } });
    expect(uncapped.observe(messageEnd("length", 4_096))?.outputCap).toBeUndefined();
    const stopped = createRequestUsageTracker(() => 2_000, { outputCap: 4_096 });
    stopped.observe({ type: "message_start", message: { role: "assistant" } });
    expect(stopped.observe(messageEnd("stop", 123))?.outputCap).toBeUndefined();
  });

  it("the row's cap reaches the run log on a capped turn", async () => {
    const agentsRoot = mkdtempSync(join(tmpdir(), "bob-185b-log-"));
    try {
      const agentDir = join(agentsRoot, "capbot");
      mkdirSync(join(agentDir, "work"), { recursive: true });
      writeFileSync(
        join(agentDir, "bob.yaml"),
        [
          "agent:",
          "  id: capbot",
          "  name: Capbot",
          "  role: reviewer",
          "",
          "provider:",
          "  name: ollama",
          "  model: m",
          "",
          "tools:",
          "  allow:",
          "    - read",
          "",
        ].join("\n"),
      );
      const listeners: Array<(event: unknown) => void> = [];
      const session = {
        subscribe(listener: (event: unknown) => void) {
          listeners.push(listener);
          return () => {};
        },
        async prompt() {
          for (const event of [
            { type: "message_start", message: { role: "assistant" } },
            {
              type: "message_end",
              message: {
                role: "assistant",
                provider: "ollama",
                model: "m",
                timestamp: 1_000,
                content: [{ type: "text", text: "done" }],
                stopReason: "length",
                usage: { input: 10, output: 4_096 },
              },
            },
          ]) {
            for (const listener of listeners) listener(event);
          }
        },
        get messages() {
          return [];
        },
        dispose() {},
      } as unknown as RunSession;
      const factory: RunSessionFactory = async () => session;

      await runAgent({
        name: "capbot",
        prompt: "go",
        agentsRoot,
        sessionFactory: factory,
        captureStdout: true,
      });

      const runsDir = join(agentDir, "runs");
      const file = readdirSync(runsDir).find((f) => f.endsWith(".jsonl"));
      if (file === undefined) throw new Error("no run log");
      const lines = readFileSync(join(runsDir, file), "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { requestUsage?: Record<string, unknown> });
      const usage = lines.map((l) => l.requestUsage).find((r) => r?.stopReason === "length");
      expect(usage?.provider).toBe("ollama");
      expect(usage?.outputCap).toBe(4_096);
      expect(usage?.completionTokens).toBe(4_096);
    } finally {
      rmSync(agentsRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
