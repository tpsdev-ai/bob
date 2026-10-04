// bob#306 — a keyless row's budget bounds the configured model's maxTokens and
// the output cap of requests sent to that row; pi may request less.
//
// Each case runs a real factory session against a fake OpenAI-compatible server
// on loopback (no network leaves the host).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { OUTPUT_CAP_MARK } from "../../src/shell/model-budget.js";
import { PROVIDER_RECORDS, ProviderRegistry } from "../../src/shell/provider-registry.js";
import type { ProviderTurnBudget } from "../../src/shell/provider-turn-budget.js";
import { resolveRunConfig, runAgent } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

const piece = (i: number) => `t${i} `;
const pieces = (n: number) => Array.from({ length: n }, (_, i) => piece(i)).join("");
const sse = (payload: unknown) =>
  `data: ${JSON.stringify({ id: "1", ...(payload as object) })}\n\n`;

interface CapServer {
  url: string;
  bodies: Record<string, unknown>[];
  close(): Promise<void>;
}

/** A fake OpenAI-compatible SSE server on loopback. Each request streams up to
 *  `total` content pieces. "ignore" streams them whatever the request's cap,
 *  until the client closes the connection. "obey" streams at most the request's
 *  cap and reports that many completion tokens, ending with finish_reason
 *  "length" when the cap stopped it before `total`. With `longFirst`, the first
 *  request instead gets 200 long pieces ending "stop", so the session has
 *  context that pi could compact. */
async function capServer(
  mode: "ignore" | "obey",
  total: number,
  opts: { longFirst?: boolean } = {},
): Promise<CapServer> {
  const sockets = new Set<Socket>();
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      bodies.push(body);
      const long = opts.longFirst === true && bodies.length === 1;
      const requested = body.max_tokens ?? body.max_completion_tokens;
      const cap = typeof requested === "number" ? requested : total;
      const n = long ? 200 : mode === "obey" ? Math.min(total, cap) : total;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < n; i++) {
        if (res.destroyed) return;
        const content = long ? `${piece(i)}${"x".repeat(600)} ` : piece(i);
        res.write(sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }));
        if (i % 50 === 49) await new Promise((r) => setTimeout(r, 1));
      }
      if (res.destroyed) return;
      res.write(
        sse({
          choices: [
            { index: 0, delta: {}, finish_reason: long || n === total ? "stop" : "length" },
          ],
          usage: { prompt_tokens: 7, completion_tokens: n, total_tokens: n + 7 },
        }),
      );
      res.write("data: [DONE]\n\n");
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

interface Setup {
  budget?: ProviderTurnBudget;
  /** bob.yaml provider.max_output_tokens. */
  maxOutputTokens?: number;
  /** models.json maxTokens (the scaffold writes 16384). */
  modelMaxTokens?: number;
  /** models.json samplingParams. */
  samplingParams?: Record<string, unknown>;
  /** The body of a before_provider_request handler, loaded as an extension. */
  hook?: string;
  /** bob.yaml provider.context_window (default 262144). */
  contextWindow?: number;
}

interface AssistantLike {
  role: string;
  stopReason?: string;
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

const text = (message: AssistantLike | undefined) =>
  (message?.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

describe("bob#306 — a keyless row's budget bounds every output cap in its session", () => {
  let root: string;
  let servers: CapServer[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-306-"));
    servers = [];
  });
  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function serve(
    mode: "ignore" | "obey",
    total: number,
    opts: { longFirst?: boolean } = {},
  ): Promise<CapServer> {
    const server = await capServer(mode, total, opts);
    servers.push(server);
    return server;
  }

  function scaffold(endpoint: string, setup: Setup) {
    const row = {
      id: "fake-local",
      aliases: [],
      runtime: "fake-local",
      auth: { kind: "none" as const },
      endpoint,
      api: "openai-completions" as const,
      override: {},
      ...(setup.budget !== undefined ? { budget: setup.budget } : {}),
    };
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row]);
    const agentsRoot = join(root, "agents");
    const { agentDir } = initAgent({
      name: "agent-a",
      role: "ea",
      provider: "fake-local",
      model: "m",
      contextWindow: setup.contextWindow ?? 262_144,
      agentsRoot,
      flairKeysDir: join(root, "keys"),
      skipFlair: true,
      registry,
    });
    // No capabilities (so no Flair call), no tools, and the output cap under test.
    const yamlPath = join(agentDir, "bob.yaml");
    const yaml = readFileSync(yamlPath, "utf8");
    const tools = yaml.indexOf("\ntools:\n");
    const window = `  context_window: ${setup.contextWindow ?? 262_144}\n`;
    if (tools < 0 || !yaml.includes(window)) throw new Error("unexpected scaffolded bob.yaml");
    const cap =
      setup.maxOutputTokens !== undefined ? `  max_output_tokens: ${setup.maxOutputTokens}\n` : "";
    writeFileSync(
      yamlPath,
      `${yaml.slice(0, tools).replace(window, `${window}${cap}`)}\ntools:\n  allow: []\n`,
    );
    if (setup.modelMaxTokens !== undefined || setup.samplingParams !== undefined) {
      const modelsPath = join(agentDir, ".pi-agent", "models.json");
      const models = JSON.parse(readFileSync(modelsPath, "utf8"));
      const model = models.providers["fake-local"].models[0];
      if (setup.modelMaxTokens !== undefined) model.maxTokens = setup.modelMaxTokens;
      if (setup.samplingParams !== undefined) model.samplingParams = setup.samplingParams;
      writeFileSync(modelsPath, `${JSON.stringify(models)}\n`);
    }
    // As provider-timeouts-185.test.ts does: a placeholder for pi's prompt-time
    // auth check. The keyless transport never sends it.
    writeFileSync(
      join(agentDir, ".pi-agent", "auth.json"),
      JSON.stringify({ "fake-local": { type: "api_key", key: "fixture-placeholder" } }),
    );
    return { registry, agentsRoot, agentDir };
  }

  async function sessionFor(endpoint: string, setup: Setup) {
    const { registry, agentsRoot } = scaffold(endpoint, setup);
    const { config, policy } = resolveRunConfig({ name: "agent-a", agentsRoot, registry });
    let extensionSources = config.extensionSources;
    if (setup.hook !== undefined) {
      const hookPath = join(root, "hook-extension.mjs");
      writeFileSync(
        hookPath,
        `export default function (pi) { pi.on("before_provider_request", (event) => { ${setup.hook} }); }\n`,
      );
      extensionSources = [...extensionSources, hookPath];
    }
    const { session } = await createBobRuntimeFactory({
      config: { ...config, extensionSources },
      policy,
      registry,
      deps: { log: () => {}, exit: () => {} },
    })({ sessionManager: SessionManager.inMemory(config.cwd) });
    const events: string[] = [];
    session.subscribe((event) => {
      events.push(event.type);
    });
    const assistants = () =>
      (session.messages as unknown as AssistantLike[]).filter((m) => m.role === "assistant");
    return { session, events, assistants };
  }

  it("a server that ignores the cap: the request carries the budget and bob ends the stream after that many pieces", async () => {
    const server = await serve("ignore", 1_000);
    const { session, assistants } = await sessionFor(server.url, {
      budget: { maxOutputTokens: 256, reasoning: "off" },
    });
    try {
      await session.prompt("go");
      expect(server.bodies.map((body) => body.max_tokens)).toEqual([256]);
      const reply = assistants().at(-1);
      expect(reply?.stopReason).toBe("length");
      expect(reply?.[OUTPUT_CAP_MARK]).toBe(true);
      expect(text(reply)).toBe(pieces(256));
      expect(session.model?.maxTokens).toBe(256);
    } finally {
      session.dispose();
    }
  }, 20_000);

  it("a lower provider max_output_tokens wins in the request, the backstop and the run log", async () => {
    const server = await serve("ignore", 1_000);
    const { registry, agentsRoot, agentDir } = scaffold(server.url, {
      budget: { maxOutputTokens: 512, reasoning: "off" },
      maxOutputTokens: 300,
    });
    const result = await runAgent({
      name: "agent-a",
      prompt: "go",
      agentsRoot,
      registry,
      captureStdout: true,
    });
    expect(server.bodies.length).toBeGreaterThan(0);
    for (const body of server.bodies) expect(body.max_tokens).toBe(300);
    const runsDir = join(agentDir, "runs");
    const file = readdirSync(runsDir).find((f) => f.endsWith(".jsonl"));
    if (file === undefined) throw new Error("no run log");
    const usage = readFileSync(join(runsDir, file), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { requestUsage?: Record<string, unknown> }).requestUsage)
      .find((record) => record !== undefined);
    expect(usage?.stopReason).toBe("length");
    expect(usage?.outputCapped).toBe(true);
    expect(usage?.completionTokens).toBe(300);
    expect(usage?.outputCap).toBe(300);
    expect(result.stdout?.startsWith(pieces(300))).toBe(true);
    expect(result.stdout?.includes(piece(300))).toBe(false);
  }, 30_000);

  const budget: Setup = { budget: { maxOutputTokens: 256, reasoning: "off" } };
  const control: Setup = { modelMaxTokens: 256 };
  it.each([
    { cap: "the row's budget", setup: budget, long: false },
    { cap: "the row's budget", setup: budget, long: true },
    { cap: "the model's own maxTokens (control)", setup: control, long: false },
    { cap: "the model's own maxTokens (control)", setup: control, long: true },
  ])(
    "a server that obeys the cap from $cap (long session: $long): the length stop stays in agent state, one request per prompt, no compaction",
    async ({ setup, long }) => {
      const server = await serve("obey", 1_000, { longFirst: long });
      const { session, events, assistants } = await sessionFor(server.url, setup);
      try {
        if (long) await session.prompt("first");
        await session.prompt("go");
        expect(server.bodies.length).toBe(long ? 2 : 1);
        expect(events.filter((type) => type.startsWith("compaction"))).toEqual([]);
        expect(assistants().map((m) => m.stopReason)).toEqual(
          long ? ["stop", "length"] : ["length"],
        );
        expect(text(assistants().at(-1))).toBe(pieces(256));
      } finally {
        session.dispose();
      }
    },
    20_000,
  );

  it("a branch summary's explicit cap is bounded by the budget, and the backstop stops at it", async () => {
    const server = await serve("ignore", 1_000);
    const { session } = await sessionFor(server.url, budget);
    try {
      await session.prompt("first");
      await session.prompt("second");
      const firstReply = session.sessionManager
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (firstReply === undefined) throw new Error("no assistant entry");
      // pi's branch summarizer asks for 2048 output tokens.
      const result = await session.navigateTree(firstReply.id, { summarize: true });
      expect(server.bodies.length).toBe(3);
      expect(server.bodies.at(-1)?.max_tokens).toBe(256);
      const summary =
        result.summaryEntry?.type === "branch_summary" ? result.summaryEntry.summary : "";
      expect(summary).toContain(pieces(256));
      expect(summary).not.toContain(piece(256));
    } finally {
      session.dispose();
    }
  }, 30_000);

  it("a raw request carries the budget when it names no cap or a higher one, and keeps a lower one", async () => {
    const server = await serve("obey", 3);
    const { session } = await sessionFor(server.url, budget);
    try {
      const model = session.model;
      if (model === undefined) throw new Error("no session model");
      const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
      await session.modelRuntime.stream(model, context, {}).result();
      await session.modelRuntime.stream(model, context, { maxTokens: 2_048 }).result();
      await session.modelRuntime.streamSimple(model, context, { maxTokens: 200 }).result();
      expect(server.bodies.map((body) => body.max_tokens)).toEqual([256, 256, 200]);
    } finally {
      session.dispose();
    }
  }, 20_000);

  it.each([
    {
      name: "a models.json samplingParams max_tokens",
      setup: { samplingParams: { max_tokens: 2_048 } },
      wire: 256,
    },
    {
      name: "a payload hook that raises max_tokens",
      setup: { hook: "return { ...event.payload, max_tokens: 4096 };" },
      wire: 256,
    },
    {
      name: "a payload hook that adds max_completion_tokens",
      setup: { hook: "return { ...event.payload, max_completion_tokens: 4096 };" },
      wire: 256,
      completion: 256,
    },
    {
      // pi clamps the cap to the room left in the window; a 4100-token window
      // leaves none, and pi's floor is 1.
      name: "a payload hook that raises max_tokens near a full context window",
      setup: { contextWindow: 4_100, hook: "return { ...event.payload, max_tokens: 4096 };" },
      wire: 1,
    },
    {
      // The request's serializer calls the body's own toJSON.
      name: "a payload hook whose body's toJSON raises max_tokens",
      setup: {
        hook: "return { ...event.payload, toJSON() { const { toJSON, ...rest } = this; return { ...rest, max_tokens: 4096 }; } };",
      },
      wire: 256,
    },
    {
      name: "a payload hook that lowers max_tokens",
      setup: { hook: "return { ...event.payload, max_tokens: 100 };" },
      wire: 100,
    },
  ] as Array<{ name: string; setup: Setup; wire: number; completion?: number }>)(
    "the final request body holds the budget against $name",
    async ({ setup, wire, completion }) => {
      const server = await serve("obey", 3);
      const { session } = await sessionFor(server.url, { ...budget, ...setup });
      try {
        await session.prompt("go");
        expect(server.bodies.length).toBe(1);
        expect(server.bodies[0]?.max_tokens).toBe(wire);
        expect(server.bodies[0]?.max_completion_tokens).toBe(completion);
      } finally {
        session.dispose();
      }
    },
    20_000,
  );

  it.each([
    { name: "a string", hook: 'return "not a body";' },
    { name: "null", hook: "return null;" },
  ])(
    "a payload hook that returns $name is refused before any request",
    async ({ hook }) => {
      const server = await serve("obey", 3);
      const { session, assistants } = await sessionFor(server.url, { ...budget, hook });
      try {
        await session.prompt("go");
        expect(server.bodies.length).toBe(0);
        const reply = assistants().at(-1);
        expect(reply?.stopReason).toBe("error");
        expect(String(reply?.errorMessage)).toContain("body is not an object");
      } finally {
        session.dispose();
      }
    },
    20_000,
  );
});
