// The #145 guarantee at the REQUEST boundary, against a REAL pi session.
//
// The unit tests pin the pieces; this file stands up pi's own session (through
// bob's ONE factory) with a STUB model and proves the three claims that only a
// real session can prove:
//
//   1. the contract is in the SYSTEM PROMPT of every agent request — including
//      the request after a real pi compaction, which rewrites the message
//      history and nothing else;
//   2. a capability that takes the contract away — by replacing the prompt in
//      `before_agent_start`, or by rewriting the outgoing provider payload in
//      `before_provider_request` — fails the turn exactly like a failed audit
//      (the session is disposed, the process is ended, the reason is named);
//   3. pi's own summarization request is EXCLUDED by name: it carries pi's
//      summarization prompt and must not fail the guard.
//
// The stub provider is bob's own: it builds an Anthropic-shaped payload, calls
// `options.onPayload` like every real provider API does (the compaction summary
// request included), records what the guard would see, and then streams a
// scripted assistant message. A provider that skips `onPayload` would never
// reach `before_provider_request` at all — which is exactly why the guard lives
// there and why this stub calls it.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import type { RunSession } from "../../src/shell/run.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";
import { PI_SUMMARIZATION_MARKER } from "../../src/shell/system-prompt-contract.js";

const STUB_PROVIDER = "bob-stub";
const STUB_MODEL = "stub-1";

interface RecordedRequest {
  call: number;
  /** The system prompt pi handed the provider (the context). */
  contextSystemPrompt: string;
  /** The system prompt in the FINAL payload, after every extension handler. */
  payloadSystemPrompt: string;
  /** True when this was pi's own summarization call. */
  summarization: boolean;
}

/** Every request the stub provider saw, in order. */
let requests: RecordedRequest[] = [];

/** The system prompt text of a payload, read the same way for every shape. */
function payloadSystemText(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as { system?: unknown; messages?: unknown };
  const system = record.system;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof (entry as { text?: unknown })?.text === "string"
            ? ((entry as { text: string }).text as string)
            : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * A stub provider that behaves like a real API client: it builds a payload,
 * awaits `onPayload` (so `before_provider_request` runs, guard included), and
 * streams one assistant message. `scripted(call)` decides the reply text.
 */
function stubProvider(scripted: (call: number, systemPrompt: string) => string) {
  const state = { callCount: 0 };
  const streamSimple = (
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const call = state.callCount + 1;
    state.callCount = call;
    queueMicrotask(async () => {
      const contextSystemPrompt = context.systemPrompt ?? "";
      let payload: Record<string, unknown> = {
        model: model.id,
        system: [{ type: "text", text: contextSystemPrompt }],
        messages: context.messages,
      };
      try {
        // Every real provider API calls this hook (pi-ai 0.84.3: anthropic,
        // openai, google, bedrock …), and pi routes it to
        // before_provider_request. It is the seam the guard exists for.
        const next = await options?.onPayload?.(payload, model);
        if (next !== undefined) payload = next as Record<string, unknown>;
        const payloadSystemPrompt = payloadSystemText(payload);
        const summarization = payloadSystemPrompt.includes(PI_SUMMARIZATION_MARKER);
        requests.push({ call, contextSystemPrompt, payloadSystemPrompt, summarization });
        const text = summarization
          ? "Summary: the conversation so far, condensed."
          : scripted(call, contextSystemPrompt);
        const message = {
          role: "assistant" as const,
          content: text.length > 0 ? [{ type: "text" as const, text }] : [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        const partial = { ...message, content: [] as typeof message.content };
        stream.push({ type: "start", partial: partial as never });
        stream.push({ type: "text_start", contentIndex: 0, partial: partial as never });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: text,
          partial: partial as never,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: text,
          partial: partial as never,
        });
        stream.push({ type: "done", reason: "stop", message: message as never });
        stream.end(message as never);
      } catch (err) {
        const message = {
          role: "assistant" as const,
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error" as const,
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: message as never });
        stream.end(message as never);
      }
    });
    return stream;
  };
  return { state, streamSimple };
}

let root: string;
let agentsRoot: string;
let agentDir: string;
let cwd: string;
let piAgentDir: string;
let extDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-contract-live-"));
  agentsRoot = join(root, "agents");
  extDir = mkdtempSync(join(tmpdir(), "bob-contract-ext-"));
  requests = [];
  const res = initAgent({
    name: "testbot",
    role: "ea",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    agentsRoot,
    flairKeysDir: join(root, ".flair", "keys"),
    skipFlair: true,
  });
  agentDir = res.agentDir;
  cwd = join(agentDir, "work");
  piAgentDir = join(agentDir, ".pi-agent");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
});

async function stubRuntime(contextWindow = 200_000) {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  const stub = stubProvider((call) => (call === 1 ? "first turn done" : "later turn done"));
  runtime.registerProvider(STUB_PROVIDER, {
    name: "Bob Stub",
    apiKey: "stub-key",
    api: "bob-stub-api",
    baseUrl: "http://localhost:0",
    streamSimple: stub.streamSimple,
    models: [
      {
        id: STUB_MODEL,
        name: "Stub",
        api: "bob-stub-api",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 4096,
      },
    ],
  });
  return { runtime, stub };
}

/** Build a REAL pi session through bob's factory, with the stub model. */
async function contractSession(opts: {
  /** A capability extension source written to disk (order: before the guard). */
  capabilityText?: string;
  contextWindow?: number;
  taskContract?: string;
  standingContract?: string;
  contractCapChars?: number;
}) {
  const { runtime, stub } = await stubRuntime(opts.contextWindow);
  const extensionSources: string[] = [];
  if (opts.capabilityText !== undefined) {
    const extPath = join(extDir, `cap-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(extPath, opts.capabilityText);
    extensionSources.push(extPath);
  }
  const { config } = resolveRunConfig({ name: "testbot", agentsRoot });
  const logs: string[] = [];
  const exits: number[] = [];
  let disposals = 0;
  const factory = createBobRuntimeFactory({
    config: {
      ...config,
      provider: STUB_PROVIDER,
      model: STUB_MODEL,
      extensionSources,
      ...(opts.taskContract !== undefined ? { taskContract: opts.taskContract } : {}),
      ...(opts.standingContract !== undefined ? { standingContract: opts.standingContract } : {}),
      ...(opts.contractCapChars !== undefined ? { contractCapChars: opts.contractCapChars } : {}),
    },
    // The test agent declares the flair capability; this session loads none, so
    // the effective policy is only what pi itself provides (the audit would
    // otherwise refuse the session for the missing capability tools).
    policy: { tools: ["read"], excludeTools: [], resident: false, allowResidentShell: false },
    deps: { log: (m) => logs.push(m), exit: (code) => exits.push(code) },
    modelRuntime: runtime,
  });
  const result = await factory({
    cwd,
    agentDir: piAgentDir,
    sessionManager: SessionManager.inMemory(cwd) as never,
  });
  const session = result.session as unknown as {
    prompt(text: string, options?: unknown): Promise<void>;
    subscribe(listener: (event: unknown) => void): () => void;
    dispose(): void;
  };
  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    disposals += 1;
    dispose();
  };
  return {
    session: session as unknown as RunSession & {
      prompt(text: string, options?: unknown): Promise<void>;
      subscribe(listener: (event: unknown) => void): () => void;
    },
    loader: result.services.resourceLoader,
    logs,
    exits,
    disposals: () => disposals,
    stub,
  };
}

// A marker at the very START of the task: pi's compaction keeps the RECENT part
// of the history and summarizes the rest, so this is the text that is actually
// dropped. It survives in the system prompt (the contract block is capped at its
// head), which is the whole shape change.
const HEAD_MARKER = "bob-contract-head-marker-9c1f";
// Enough content that pi has something to compact: it keeps the recent
// `keepRecentTokens` (20000) and summarizes what came before, so the history
// must be larger than that — three turns of ~40k chars ≈ 30k tokens. Only the
// FIRST turn carries the head marker: it is the content the compaction drops.
const headTask = () => `${HEAD_MARKER} ${"w".repeat(40_000)}`;
const laterTask = (n: number) => `turn ${n} ${"v".repeat(40_000)}`;
const runThreeTurns = async (session: { prompt(text: string): Promise<void> }) => {
  await session.prompt(headTask());
  await session.prompt(laterTask(2));
  await session.prompt(laterTask(3));
};

describe("#145 — the contract survives a real pi compaction (stub model)", () => {
  it("carries the TASK in the system prompt of an agent request after a real compaction (pi's own threshold path, MID-TURN)", async () => {
    // A context window whose threshold (window − reserveTokens 16384) is crossed
    // by the third turn's content, so pi compacts during that turn.
    const live = await contractSession({ taskContract: headTask(), contextWindow: 40_000 });
    try {
      const compactions: number[] = [];
      live.session.subscribe((event) => {
        const e = event as { type?: string; aborted?: boolean };
        if (e.type === "compaction_end" && !e.aborted) compactions.push(1);
      });

      await runThreeTurns(live.session);
      expect(compactions.length, "pi compacted during the turn").toBeGreaterThanOrEqual(1);

      // The task text is in every AGENT request's system prompt — the requests
      // made after the compaction included.
      const after = requests.filter((r) => !r.summarization && r.call > 1);
      expect(after.length, "the post-compaction request(s)").toBeGreaterThanOrEqual(1);
      for (const request of requests.filter((r) => !r.summarization)) {
        expect(request.payloadSystemPrompt).toContain("TASK");
        expect(request.contextSystemPrompt).toContain(HEAD_MARKER);
      }

      // And the proof it is the SYSTEM PROMPT carrying it: compaction removed
      // the head of the task from the message history, and the (post-compaction)
      // requests still carry it.
      const messages = (live.session as unknown as { messages?: ReadonlyArray<unknown> }).messages;
      expect(JSON.stringify(messages ?? [])).not.toContain(HEAD_MARKER);
      expect(
        (live.session as unknown as { messages?: ReadonlyArray<unknown> }).messages?.length,
      ).toBeGreaterThan(0);
    } finally {
      live.session.dispose();
    }
  });

  it("appends the contract as LITERAL text through the loader override — never as a path source", async () => {
    // The contract text IS an existing file path. If the block were handed to pi
    // as an `appendSystemPrompt` SOURCE, pi would read that FILE
    // (core/resource-loader.js `resolvePromptInput`) and the session would
    // carry the file's contents instead of the task. The override runs after pi
    // has turned its sources into text, so the path stays a path.
    const filePath = join(agentDir, "soul.md");
    const fileContents = "SOUL FILE CONTENT THAT MUST NOT BECOME THE CONTRACT";
    writeFileSync(filePath, fileContents);
    const live = await contractSession({ taskContract: filePath });
    try {
      const entries = live.loader.getAppendSystemPrompt();
      // The override appends the contract LAST; that entry must be the literal
      // path text, not the file's contents. (The agent's own append source —
      // its soul — is untouched and still comes first.)
      const contractEntry = entries.at(-1) ?? "";
      expect(contractEntry).toContain(filePath);
      expect(contractEntry).not.toContain(fileContents);
      // And pi recorded NO append-system-prompt SOURCE at all: the contract is
      // text, so there is nothing on disk for a reload to re-read.
      const sources =
        (live.loader as unknown as { appendSystemPromptSourcePaths?: string[] })
          .appendSystemPromptSourcePaths ?? [];
      expect(sources).toEqual([]);
    } finally {
      live.session.dispose();
    }
  });

  it("carries the STANDING CONTRACT (persistent) in the system prompt of every agent request", async () => {
    const STANDING = "You are testbot, on duty as ea. Standing duties: sweep the inbox.";
    const live = await contractSession({ standingContract: STANDING });
    try {
      await live.session.prompt("a discord message arrives");
      expect(requests.length).toBeGreaterThanOrEqual(1);
      for (const request of requests) {
        expect(request.payloadSystemPrompt).toContain("on duty as ea");
        expect(request.payloadSystemPrompt).toContain("sweep the inbox");
      }
    } finally {
      live.session.dispose();
    }
  });

  it("carries it across a MANUAL pi compaction too, and on the request after it", async () => {
    const live = await contractSession({ taskContract: headTask() });
    try {
      await runThreeTurns(live.session);
      const beforeManual = requests.length;

      // pi's manual compaction entry point (/compact, RPC, extensions). Real
      // pi machinery, the same summarization model, the same history rewrite.
      const session = live.session as unknown as { compact(): Promise<void> };
      await session.compact();

      await live.session.prompt("continue");
      const after = requests.slice(beforeManual).filter((r) => !r.summarization);
      expect(after.length, "the post-compaction turn made a request").toBeGreaterThanOrEqual(1);
      for (const request of after) expect(request.payloadSystemPrompt).toContain("TASK");
      expect(
        JSON.stringify((live.session as unknown as { messages?: unknown }).messages ?? {}),
      ).not.toContain(HEAD_MARKER);
    } finally {
      live.session.dispose();
    }
  });
});

describe("#145 — the guard fails a turn whose request lost the contract", () => {
  it("fails when a capability REPLACES the prompt in before_agent_start", async () => {
    const live = await contractSession({
      taskContract: "the one-shot task",
      capabilityText: `export default function (pi) {
  pi.on("before_agent_start", () => ({ systemPrompt: "a capability replaced the whole prompt" }));
}
`,
    });
    try {
      await live.session.prompt("do the task").catch(() => {});
      expect(live.disposals(), "the session is disposed").toBeGreaterThanOrEqual(1);
      expect(live.exits, "the process is ended").toEqual([1]);
      expect(live.logs.join("\n")).toContain("contract_missing_from_system_prompt");
    } finally {
      live.session.dispose();
    }
  });

  it("fails when a capability REWRITES the outgoing provider payload in before_provider_request", async () => {
    const live = await contractSession({
      taskContract: "the one-shot task",
      capabilityText: `export default function (pi) {
  pi.on("before_provider_request", (event) => ({
    ...event.payload,
    system: [{ type: "text", text: "a capability rewrote the payload" }],
  }));
}
`,
    });
    try {
      await live.session.prompt("do the task").catch(() => {});
      expect(live.disposals(), "the session is disposed").toBeGreaterThanOrEqual(1);
      expect(live.exits, "the process is ended").toEqual([1]);
      expect(live.logs.join("\n")).toContain("contract_missing_from_system_prompt");
    } finally {
      live.session.dispose();
    }
  });

  it("does NOT fail pi's own summarization request (excluded by name)", async () => {
    const live = await contractSession({ taskContract: headTask() });
    try {
      await runThreeTurns(live.session);
      const session = live.session as unknown as { compact(): Promise<void> };
      await session.compact();
      const summarization = requests.filter((r) => r.summarization);
      expect(summarization.length, "pi made its summarization request").toBeGreaterThanOrEqual(1);
      // The summarization request does NOT carry the contract (it carries pi's
      // summarization prompt by design), and the guard — which saw it — did not
      // fail the turn: no exit, no dispose.
      for (const request of summarization) {
        expect(request.payloadSystemPrompt).toContain(PI_SUMMARIZATION_MARKER);
      }
      expect(live.exits).toEqual([]);
      expect(live.disposals()).toBe(0);
    } finally {
      live.session.dispose();
    }
  });
});
