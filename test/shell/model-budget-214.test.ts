// bob#214 — the model budget, against REAL pi sessions built by bob's ONE
// factory with fake providers (no network, no real model):
//
//   1. compaction triggers at the configured threshold MID-RUN, between model
//      calls — not only when the run ends;
//   2. the configured context window reaches the runtime (the session's model,
//      the provider's request model, pi's registry lookup);
//   3. a stream that ignores the output cap it was sent is cut at that cap;
//   4. the run log carries one usage record per request (prompt, cached-prompt,
//      completion and thinking tokens, time to first token, model);
//   5. the thinking level reaches the provider's request.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as openaiCompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { readProviderLimits, readSessionBudget } from "../../src/shell/bob-yaml.js";
import { initAgent } from "../../src/shell/init.js";
import { checkpointText } from "../../src/shell/model-budget.js";
import { createRequestUsageTracker } from "../../src/shell/request-usage.js";
import type { RunSession, RunSessionConfig } from "../../src/shell/run.js";
import { resolveRunConfig, runAgent } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

const STUB_PROVIDER = "bob-stub-214";
const STUB_MODEL = "stub-214";
const STUB_API = "bob-stub-214-api";

let root: string;
let agentsRoot: string;
let cwd: string;
let piAgentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-214-"));
  agentsRoot = join(root, "agents");
  const res = initAgent({
    name: "budgetbot",
    role: "ea",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextWindow: 200_000,
    agentsRoot,
    skipFlair: true,
  });
  cwd = join(res.agentDir, "work");
  piAgentDir = join(res.agentDir, ".pi-agent");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function usage(input: number, output = 0) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type Scripted = { text?: string; toolRead?: string; inputTokens: number };

interface StubRequest {
  call: number;
  summarization: boolean;
  model: Model<string>;
  options?: SimpleStreamOptions;
  messagesJson: string;
}

/** A stub provider that answers each AGENT request from `script` (by agent
 *  call number) and pi's own summarization request with a fixed summary. */
function stubProvider(script: Scripted[]) {
  const requests: StubRequest[] = [];
  let agentCalls = 0;
  const streamSimple = (
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const summarization = (context.systemPrompt ?? "").includes("context summarization assistant");
    const call = summarization ? 0 : ++agentCalls;
    requests.push({
      call,
      summarization,
      model,
      ...(options !== undefined ? { options } : {}),
      messagesJson: JSON.stringify(context.messages),
    });
    const step: Scripted = summarization
      ? { text: "Summary of the earlier work.", inputTokens: 1_000 }
      : (script[call - 1] ?? { text: "out of script", inputTokens: 100 });
    queueMicrotask(() => {
      const content: AssistantMessage["content"] = [];
      if (step.text !== undefined) content.push({ type: "text", text: step.text });
      if (step.toolRead !== undefined) {
        content.push({
          type: "toolCall",
          id: `call-${call}`,
          name: "read",
          arguments: { path: step.toolRead },
        });
      }
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        // `inputTokens` is the context size the response reports (its totalTokens).
        usage: usage(step.inputTokens - 10, 10),
        stopReason: step.toolRead !== undefined ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({
        type: "done",
        reason: step.toolRead !== undefined ? "toolUse" : "stop",
        message,
      });
      stream.end(message);
    });
    return stream;
  };
  return { requests, streamSimple };
}

async function stubRuntime(
  streamSimple: ReturnType<typeof stubProvider>["streamSimple"],
  registry: { contextWindow: number; maxTokens: number },
) {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider(STUB_PROVIDER, {
    name: "Bob Stub 214",
    apiKey: "stub-key",
    api: STUB_API,
    baseUrl: "http://localhost:0",
    streamSimple,
    models: [
      {
        id: STUB_MODEL,
        name: "Stub",
        api: STUB_API,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: registry.contextWindow,
        maxTokens: registry.maxTokens,
      },
    ],
  });
  return runtime;
}

type LiveSession = RunSession & {
  model?: Model<string>;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
};

async function liveSession(input: {
  runtime: unknown;
  config: Partial<RunSessionConfig>;
  logs?: string[];
}): Promise<LiveSession> {
  const base = resolveRunConfig({ name: "budgetbot", agentsRoot }).config;
  const factory = createBobRuntimeFactory({
    config: {
      ...base,
      extensionSources: [],
      capabilityBySource: {},
      ...input.config,
    } as RunSessionConfig,
    policy: { tools: ["read"], excludeTools: [], resident: false, allowResidentShell: false },
    deps: { log: (m) => input.logs?.push(m), exit: () => {} },
    modelRuntime: input.runtime,
  });
  const result = await factory({
    cwd,
    agentDir: piAgentDir,
    sessionManager: SessionManager.inMemory(cwd) as never,
  });
  return result.session as unknown as LiveSession;
}

// ─── 1. Compaction between model calls ─────────────────────────────────────

describe("bob#214 — compaction triggers at the configured threshold MID-RUN", () => {
  // window 100000, threshold 0.5 → pi compacts when the context is OVER 50000.
  const WINDOW = 100_000;
  const runWith = async (thirdCallTokens: number) => {
    for (const n of [1, 2, 3]) {
      writeFileSync(join(cwd, `big${n}.txt`), `BIG${n}-MARKER ${"x".repeat(40_000)}`);
    }
    const stub = stubProvider([
      { toolRead: "big1.txt", inputTokens: 10_000 },
      { toolRead: "big2.txt", inputTokens: 20_000 },
      { toolRead: "big3.txt", inputTokens: thirdCallTokens },
      { text: "all done", inputTokens: 1_000 },
    ]);
    const runtime = await stubRuntime(stub.streamSimple, {
      contextWindow: WINDOW,
      maxTokens: 4_096,
    });
    const logs: string[] = [];
    const session = await liveSession({
      runtime,
      logs,
      config: {
        provider: STUB_PROVIDER,
        model: STUB_MODEL,
        modelLimits: { provider: STUB_PROVIDER, model: STUB_MODEL, contextWindow: WINDOW },
        compactionThreshold: 0.5,
      },
    });
    const events: string[] = [];
    session.subscribe((event) => {
      const e = event as {
        type?: string;
        reason?: string;
        result?: unknown;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (e.type === "compaction_start") events.push(`compaction_start:${e.reason}`);
      if (e.type === "compaction_end") events.push(`compaction_end:${e.result ? "ok" : "none"}`);
      if (e.type === "message_end" && e.message?.role === "assistant") {
        const text = (e.message.content ?? []).find((c) => c.type === "text")?.text;
        const tool = (e.message.content ?? []).some((c) => c.type === "toolCall");
        events.push(tool ? "assistant:tool" : `assistant:${text}`);
      }
      if (e.type === "agent_settled") events.push("settled");
    });
    try {
      await session.prompt("do the work", { expandPromptTemplates: false });
    } finally {
      session.dispose();
    }
    return { stub, events, logs };
  };

  it("compacts between the third and the fourth model call once the context is OVER the threshold", async () => {
    const { stub, events } = await runWith(50_001);
    // One prompt, one settle — and the compaction sits BETWEEN model calls.
    expect(events).toEqual([
      "assistant:tool",
      "assistant:tool",
      "assistant:tool",
      "compaction_start:threshold",
      "compaction_end:ok",
      "assistant:all done",
      "settled",
    ]);
    const agentRequests = stub.requests.filter((r) => !r.summarization);
    expect(agentRequests.map((r) => r.call)).toEqual([1, 2, 3, 4]);
    expect(stub.requests.filter((r) => r.summarization).length).toBeGreaterThanOrEqual(1);
    // The fourth request is the continuation: it carries bob's checkpoint steer,
    // and the earliest tool output was compacted out of it.
    const fourth = agentRequests[3]?.messagesJson ?? "";
    expect(fourth).toContain("[BOB CONTEXT CHECKPOINT");
    expect(fourth).not.toContain("BIG1-MARKER");
    expect(agentRequests[2]?.messagesJson).toContain("BIG1-MARKER");
  });

  it("does NOT compact at exactly the threshold (pi's own strict comparison)", async () => {
    const { stub, events } = await runWith(50_000);
    expect(events).toEqual([
      "assistant:tool",
      "assistant:tool",
      "assistant:tool",
      "assistant:all done",
      "settled",
    ]);
    expect(stub.requests.some((r) => r.summarization)).toBe(false);
    expect(stub.requests.at(-1)?.messagesJson).not.toContain("[BOB CONTEXT CHECKPOINT");
  });

  it("the checkpoint text names the numbers it acted on", () => {
    const text = checkpointText({
      contextTokens: 50_001,
      thresholdTokens: 50_000,
      contextWindow: 100_000,
    });
    expect(text).toContain("50001");
    expect(text).toContain("50000 of a 100000-token context window");
    expect(text).toContain("not the end of the task");
  });
});

// ─── 2. The configured window reaches the runtime ──────────────────────────

describe("bob#214 — the configured context window reaches the runtime", () => {
  it("the session's model, the provider's request model and pi's registry lookup all carry bob.yaml's window, not the registry's", async () => {
    const stub = stubProvider([{ text: "hi", inputTokens: 10 }]);
    // pi's registry (models.json / catalog) says 131072 — the value that
    // disagreed with the server.
    const runtime = await stubRuntime(stub.streamSimple, {
      contextWindow: 131_072,
      maxTokens: 32_000,
    });
    const session = await liveSession({
      runtime,
      config: {
        provider: STUB_PROVIDER,
        model: STUB_MODEL,
        modelLimits: {
          provider: STUB_PROVIDER,
          model: STUB_MODEL,
          contextWindow: 262_144,
          maxOutputTokens: 16_000,
        },
      },
    });
    try {
      expect(session.model?.contextWindow).toBe(262_144);
      expect(session.model?.maxTokens).toBe(16_000);
      // pi re-reads the model from the registry when it refreshes the session's
      // model; that lookup returns the configured numbers too.
      const fromRegistry = runtime.getModel(STUB_PROVIDER, STUB_MODEL);
      expect(fromRegistry?.contextWindow).toBe(262_144);
      expect(fromRegistry?.maxTokens).toBe(16_000);
      await session.prompt("hello", { expandPromptTemplates: false });
      expect(stub.requests[0]?.model.contextWindow).toBe(262_144);
      expect(stub.requests[0]?.model.maxTokens).toBe(16_000);
    } finally {
      session.dispose();
    }
  });

  it("resolveRunConfig carries bob.yaml's provider.context_window, bound to its model", () => {
    const { config } = resolveRunConfig({ name: "budgetbot", agentsRoot });
    expect(config.modelLimits).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextWindow: 200_000,
    });
  });

  it("a per-call --model uses that model's provider.models entry, and has NO window without one", () => {
    const yamlPath = join(agentsRoot, "budgetbot", "bob.yaml");
    const yaml = readFileSync(yamlPath, "utf8").replace(
      "  context_window: 200000\n",
      [
        "  context_window: 200000",
        "  models:",
        "    - id: claude-opus-4-7",
        "      context_window: 1000000",
        "      max_output_tokens: 64000",
        "",
      ].join("\n"),
    );
    writeFileSync(yamlPath, yaml);
    const declared = resolveRunConfig({ name: "budgetbot", agentsRoot, model: "claude-opus-4-7" });
    expect(declared.config.modelLimits).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
    });
    const undeclared = resolveRunConfig({ name: "budgetbot", agentsRoot, model: "some-other" });
    expect(undeclared.config.modelLimits).toBeUndefined();
  });

  it("REFUSES a session with no declared window, naming bob.yaml and the remedy", async () => {
    const stub = stubProvider([]);
    const runtime = await stubRuntime(stub.streamSimple, {
      contextWindow: 131_072,
      maxTokens: 4096,
    });
    await expect(
      liveSession({
        runtime,
        config: { provider: STUB_PROVIDER, model: STUB_MODEL, modelLimits: undefined },
      }),
    ).rejects.toThrow(
      /without a declared context window[\s\S]*context_window: <tokens>[\s\S]*bob\.yaml/,
    );
    expect(stub.requests.length).toBe(0);
  });

  it("REFUSES a session whose declared window describes a different model", async () => {
    const stub = stubProvider([]);
    const runtime = await stubRuntime(stub.streamSimple, {
      contextWindow: 131_072,
      maxTokens: 4096,
    });
    await expect(
      liveSession({
        runtime,
        config: {
          provider: STUB_PROVIDER,
          model: STUB_MODEL,
          modelLimits: { provider: STUB_PROVIDER, model: "another-model", contextWindow: 262_144 },
        },
      }),
    ).rejects.toThrow(
      /describes bob-stub-214\/another-model, but this session runs bob-stub-214\/stub-214/,
    );
  });

  it("REFUSES an output cap at or above the window, and a threshold that could not shrink the context", async () => {
    const stub = stubProvider([]);
    const runtime = await stubRuntime(stub.streamSimple, {
      contextWindow: 131_072,
      maxTokens: 4096,
    });
    const limits = { provider: STUB_PROVIDER, model: STUB_MODEL, contextWindow: 100_000 };
    await expect(
      liveSession({
        runtime,
        config: {
          provider: STUB_PROVIDER,
          model: STUB_MODEL,
          modelLimits: { ...limits, maxOutputTokens: 100_000 },
        },
      }),
    ).rejects.toThrow(/max_output_tokens \(100000\) must be smaller than provider\.context_window/);
    await expect(
      liveSession({
        runtime,
        config: {
          provider: STUB_PROVIDER,
          model: STUB_MODEL,
          modelLimits: limits,
          compactionThreshold: 0.2,
        },
      }),
    ).rejects.toThrow(/at or below the 20000 tokens pi keeps verbatim/);
  });
});

describe("bob#214 — bob.yaml and role.json validation", () => {
  const yaml = (provider: string[], session: string[] = []) =>
    ["agent:", "  role: builder-local", "", "provider:", ...provider, "", ...session].join("\n");

  it("reads context_window / max_output_tokens and refuses unknown or malformed provider keys", () => {
    expect(
      readProviderLimits(
        yaml([
          "  name: ollama",
          "  model: m",
          "  context_window: 262144",
          "  max_output_tokens: 32000",
        ]),
      ),
    ).toEqual({ contextWindow: 262_144, maxOutputTokens: 32_000, models: {} });
    expect(() =>
      readProviderLimits(yaml(["  name: ollama", "  model: m", "  context_windw: 262144"])),
    ).toThrow(/unknown key "context_windw"/);
    expect(() =>
      readProviderLimits(yaml(["  name: ollama", "  model: m", "  context_window: 262k"])),
    ).toThrow(/"context_window" must be a positive whole number/);
    expect(() =>
      readProviderLimits(yaml(["  name: ollama", "  model: m", "  context_window: 0"])),
    ).toThrow(/positive whole number/);
    expect(() =>
      readProviderLimits(
        yaml(["  name: ollama", "  model: m", "  models:", "    - id: a", "      window: 5"]),
      ),
    ).toThrow(/unknown key "window" in a "models" entry/);
  });

  it("reads the session block and refuses unknown keys, bad levels and out-of-range thresholds", () => {
    const provider = ["  name: ollama", "  model: m"];
    expect(
      readSessionBudget(
        yaml(provider, ["session:", "  compaction_threshold: 0.4", "  thinking: high"]),
      ),
    ).toEqual({ compactionThreshold: 0.4, thinking: "high" });
    expect(() => readSessionBudget(yaml(provider, ["session:", "  thinkng: low"]))).toThrow(
      /unknown key "thinkng"/,
    );
    expect(() => readSessionBudget(yaml(provider, ["session:", "  thinking: medium"]))).toThrow(
      /"thinking" must be one of off, low, high/,
    );
    for (const bad of ["1", "1.0", "0", "50%", "-0.5"]) {
      expect(
        () => readSessionBudget(yaml(provider, ["session:", `  compaction_threshold: ${bad}`])),
        bad,
      ).toThrow(/strictly between 0 and 1/);
    }
    expect(() => readSessionBudget(yaml(provider, ["session: {thinking: low}"]))).toThrow(
      /inline form is not supported/,
    );
  });

  it("bob.yaml's session block overrides the role's budget key by key", () => {
    const yamlPath = join(agentsRoot, "budgetbot", "bob.yaml");
    const text = readFileSync(yamlPath, "utf8").replace("role: ea", "role: builder-local");
    writeFileSync(yamlPath, `${text}\nsession:\n  thinking: high\n`);
    // The allowlist must still fit builder-local's ceiling for resolution.
    const fitted = readFileSync(yamlPath, "utf8").replace(
      /tools:\n {2}allow:\n(?: {4}- .*\n)+/,
      "tools:\n  allow:\n    - read_lines\n",
    );
    writeFileSync(yamlPath, fitted.replace(/capabilities:\n(?: {2}- .*\n)+/, "capabilities:\n"));
    const { config } = resolveRunConfig({ name: "budgetbot", agentsRoot });
    expect(config.thinking).toBe("high"); // bob.yaml
    expect(config.compactionThreshold).toBe(0.5); // the builder-local role
  });
});

// ─── 3 + 5. Output cap and thinking level on the OpenAI-compatible path ─────

describe("bob#214 — the OpenAI-compatible path: max_tokens is sent and enforced; thinking reaches the request", () => {
  const FAKE_PROVIDER = "fake-oai-214";
  const FAKE_MODEL = "fake-model";
  const TOTAL_CHUNKS = 200;

  /** A fake OpenAI-compatible server that IGNORES the output cap: it streams
   *  TOTAL_CHUNKS one-token chunks whatever the request asked for. */
  function ignoringServer() {
    const bodies: Array<Record<string, unknown>> = [];
    let pulled = 0;
    let aborted = false;
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      const enc = new TextEncoder();
      const chunk = (delta: Record<string, unknown>, finish: string | null, extra = "") =>
        enc.encode(
          `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"${FAKE_MODEL}","choices":[{"index":0,"delta":${JSON.stringify(delta)},"finish_reason":${finish === null ? "null" : `"${finish}"`}}]${extra}}\n\n`,
        );
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled < TOTAL_CHUNKS) {
            controller.enqueue(chunk({ content: `t${pulled} ` }, null));
            pulled += 1;
            return;
          }
          controller.enqueue(
            chunk(
              {},
              "stop",
              `,"usage":{"prompt_tokens":7,"completion_tokens":${TOTAL_CHUNKS},"total_tokens":${TOTAL_CHUNKS + 7}}`,
            ),
          );
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;
    return { bodies, fetchImpl, pulled: () => pulled, aborted: () => aborted };
  }

  async function fakeRuntime(fetchImpl: typeof globalThis.fetch) {
    const runtime = await ModelRuntime.create({ modelsPath: null });
    runtime.registerProvider(FAKE_PROVIDER, {
      name: "Fake OpenAI-compatible",
      apiKey: "fake-key",
      api: "openai-completions",
      baseUrl: "http://fake-openai.invalid/v1",
      streamSimple: ((model: unknown, context: unknown, options?: unknown) =>
        openaiCompletionsStreamSimple(
          model as never,
          context as never,
          {
            ...((options as object) ?? {}),
            fetch: fetchImpl,
          } as never,
        )) as never,
      models: [
        {
          id: FAKE_MODEL,
          name: "Fake",
          api: "openai-completions",
          reasoning: true,
          compat: { supportsReasoningEffort: true },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131_072,
          maxTokens: 32_000,
        },
      ],
    });
    return runtime;
  }

  const lastAssistant = (session: LiveSession) =>
    [...((session as unknown as { messages: AssistantMessage[] }).messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant") as
      | (AssistantMessage & { bobOutputCap?: boolean })
      | undefined;

  it("sends max_completion_tokens from provider.max_output_tokens and CUTS the stream there when the server ignores it", async () => {
    const server = ignoringServer();
    const runtime = await fakeRuntime(server.fetchImpl);
    const session = await liveSession({
      runtime,
      config: {
        provider: FAKE_PROVIDER,
        model: FAKE_MODEL,
        modelLimits: {
          provider: FAKE_PROVIDER,
          model: FAKE_MODEL,
          contextWindow: 100_000,
          maxOutputTokens: 50,
        },
      },
    });
    try {
      await session.prompt("go", { expandPromptTemplates: false });
      // Sent: the cap bob.yaml declared.
      expect(server.bodies[0]?.max_completion_tokens).toBe(50);
      // Enforced: exactly 50 tokens delivered, ended as a length stop, request aborted.
      const message = lastAssistant(session);
      expect(message?.stopReason).toBe("length");
      expect(message?.bobOutputCap).toBe(true);
      expect(message?.usage.output).toBe(50);
      const text = (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
      expect(text).toBe(Array.from({ length: 50 }, (_, i) => `t${i} `).join(""));
      expect(server.aborted()).toBe(true);
      expect(server.pulled()).toBeLessThan(TOTAL_CHUNKS);
    } finally {
      session.dispose();
    }
  });

  it("a server that HONOURS the cap is never cut: a stream at or under the cap ends as the server ended it", async () => {
    const server = ignoringServer();
    const runtime = await fakeRuntime(server.fetchImpl);
    const session = await liveSession({
      runtime,
      config: {
        provider: FAKE_PROVIDER,
        model: FAKE_MODEL,
        modelLimits: {
          provider: FAKE_PROVIDER,
          model: FAKE_MODEL,
          contextWindow: 100_000,
          maxOutputTokens: TOTAL_CHUNKS,
        },
      },
    });
    try {
      await session.prompt("go", { expandPromptTemplates: false });
      const message = lastAssistant(session);
      expect(message?.stopReason).toBe("stop");
      expect(message?.bobOutputCap).toBeUndefined();
      expect(message?.usage.output).toBe(TOTAL_CHUNKS);
      expect(server.aborted()).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it("the thinking level reaches the provider's request (reasoning_effort)", async () => {
    for (const level of ["low", "high"] as const) {
      const server = ignoringServer();
      const runtime = await fakeRuntime(server.fetchImpl);
      const session = await liveSession({
        runtime,
        config: {
          provider: FAKE_PROVIDER,
          model: FAKE_MODEL,
          modelLimits: {
            provider: FAKE_PROVIDER,
            model: FAKE_MODEL,
            contextWindow: 100_000,
            maxOutputTokens: 10,
          },
          thinking: level,
        },
      });
      try {
        await session.prompt("go", { expandPromptTemplates: false });
        expect(server.bodies[0]?.reasoning_effort, level).toBe(level);
      } finally {
        session.dispose();
      }
    }
  });
});

// ─── 4. Per-request usage in the run log ────────────────────────────────────

describe("bob#214 — the run log carries one usage record per model request", () => {
  it("records prompt, cached-prompt, completion and thinking tokens, time to first token and the model", async () => {
    const T0 = Date.parse("2026-09-29T12:00:00.000Z");
    let clock = T0;
    const listeners: Array<(event: unknown) => void> = [];
    const emit = (event: unknown) => {
      for (const l of listeners) l(event);
    };
    const session: RunSession = {
      subscribe(listener) {
        listeners.push(listener as (event: unknown) => void);
        return () => {
          const i = listeners.indexOf(listener as (event: unknown) => void);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      async prompt() {
        const base = {
          role: "assistant",
          provider: "local",
          model: "qwen-test",
          timestamp: T0,
          content: [] as unknown[],
        };
        emit({ type: "message_start", message: base });
        clock = T0 + 250; // first token 250 ms after the request started
        for (const delta of ["th", "ink", "ing"]) {
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
          });
        }
        clock = T0 + 400;
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "done" },
        });
        clock = T0 + 900;
        emit({
          type: "message_end",
          message: {
            ...base,
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50, totalTokens: 1050 },
          },
        });
      },
      dispose() {},
    };
    const result = await runAgent({
      name: "budgetbot",
      prompt: "work",
      agentsRoot,
      sessionFactory: async () => session,
      now: () => new Date(clock),
    });
    expect(result.exitCode).toBe(0);
    const runsDir = join(agentsRoot, "budgetbot", "runs");
    const logFile = readdirSync(runsDir).find((f) => f.endsWith(".jsonl")) ?? "";
    const records = readFileSync(join(runsDir, logFile), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { requestUsage?: Record<string, unknown> });
    const usageRecords = records.filter((r) => r.requestUsage !== undefined);
    expect(usageRecords.length).toBe(1);
    expect(usageRecords[0]?.requestUsage).toEqual({
      provider: "local",
      model: "qwen-test",
      promptTokens: 1000,
      cachedPromptTokens: 900,
      completionTokens: 50,
      thinkingTokens: 3,
      thinkingTokensSource: "stream-deltas",
      ttftMs: 250,
      durationMs: 900,
      stopReason: "stop",
    });
  });

  it("prefers the provider's reported thinking tokens, and marks a stream bob cut at the output cap", () => {
    let t = 1_000;
    const tracker = createRequestUsageTracker(() => t);
    tracker.observe({ type: "message_start", message: { role: "assistant", timestamp: 1_000 } });
    t = 1_100;
    tracker.observe({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "x" },
    });
    t = 1_500;
    const record = tracker.observe({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "p",
        model: "m",
        timestamp: 1_000,
        stopReason: "length",
        bobOutputCap: true,
        usage: { input: 5, cacheRead: 0, cacheWrite: 2, output: 40, reasoning: 30 },
      },
    });
    expect(record).toMatchObject({
      promptTokens: 7,
      cachedPromptTokens: 0,
      completionTokens: 40,
      thinkingTokens: 30,
      thinkingTokensSource: "provider",
      ttftMs: 100,
      durationMs: 500,
      stopReason: "length",
      outputCapped: true,
    });
  });

  it("a request that streamed nothing has a null time to first token", () => {
    const tracker = createRequestUsageTracker(() => 2_000);
    tracker.observe({ type: "message_start", message: { role: "assistant", timestamp: 1_000 } });
    const record = tracker.observe({
      type: "message_end",
      message: { role: "assistant", timestamp: 1_000, stopReason: "error", usage: {} },
    });
    expect(record?.ttftMs).toBeNull();
    expect(record?.durationMs).toBe(1_000);
  });
});
