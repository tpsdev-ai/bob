// bob#381 — an empty model response after a compaction checkpoint must not end
// the run.
//
// The run tests (a)-(d) drive `runAgent` through bob's ONE session factory
// (createBobRuntimeFactory) and pi's own AgentSession runtime, with a scripted
// PROVIDER (the fake-provider pattern of model-budget-214 / narration-turn-live:
// a real pi session, its own events, its own turn boundaries; no network).
//
// (a) one empty response right after a compaction checkpoint, then a normal
//     response: the run completes, and the provider sees the checkpoint request
//     re-issued — the same context twice, no new user message;
// (b) always empty: the named error after the retry bound; the final log record
//     carries the reason and exit code; the separate outcome record carries
//     the reason, provider, model and retries;
// (c) bob#256's reasoning-only case, unchanged: a thinking-only turn is still
//     re-prompted with a new continuation turn.
// (d) a provider error whose text contains the empty-response phrase is not
//     recorded as `empty_response` (classification reads only the typed marker).
//
// The admission tests drive `startPersistent` (and the real cron scheduler)
// over the same factory; the last block unit-tests the retry bound.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { REASONING_CONTINUE_TURN } from "../../src/shell/compaction-contract.js";
import { startCronScheduler, type TimerHandle } from "../../src/shell/cron.js";
import {
  DEFAULT_MAX_EMPTY_RESPONSE_RETRIES,
  EMPTY_RESPONSE_MARK,
  resolveMaxEmptyResponseRetries,
} from "../../src/shell/empty-response.js";
import { startPersistent } from "../../src/shell/persistent.js";
import { type RunSession, type RunSessionFactory, runAgent } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

const STUB_PROVIDER = "bob-empty-stub-381";
const STUB_API = "bob-empty-stub-381-api";
const STUB_MODEL = "claude-sonnet-4-6";
// Stop for a broken bound: a request past this ends on an error, so the suite
// fails an assertion instead of spinning.
const MAX_PROVIDER_CALLS = 20;
const CONTEXT_WINDOW = 100_000;
const OVER_THRESHOLD = 60_001;

type Reply = { inputTokens: number } & (
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "toolRead"; path: string }
  | { kind: "providerError"; message: string }
);

interface SeenRequest {
  agentCall: number;
  summarization: boolean;
  lastUserText: string;
  messagesJson: string;
}

function usage(input: number, output: number): AssistantMessage["usage"] {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function lastUser(content: Context["messages"]): string {
  const users = content.filter((m) => (m as { role?: string }).role === "user");
  const m = users[users.length - 1] as { content?: unknown } | undefined;
  if (m === undefined) return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .map((b) =>
      typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "",
    )
    .join("");
}

/**
 * A scripted provider. Each AGENT request is answered from `reply(agentCall,
 * request)`; pi's own summarization request (the compaction) is answered
 * with a fixed summary. An `empty` reply streams no content block at all and
 * reports zero output tokens — the shape the issue names.
 */
function scriptedProvider(
  reply: (agentCall: number, request: SeenRequest) => Reply,
  seen: SeenRequest[],
) {
  let agentCalls = 0;
  return (
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const summarization = (context.systemPrompt ?? "").includes("context summarization assistant");
    const agentCall = summarization ? 0 : ++agentCalls;
    const request: SeenRequest = {
      agentCall,
      summarization,
      lastUserText: lastUser(context.messages),
      messagesJson: JSON.stringify(context.messages),
    };
    seen.push(request);
    queueMicrotask(async () => {
      try {
        if (agentCall > MAX_PROVIDER_CALLS) throw new Error("stub: provider call guard exceeded");
        const step: Reply = summarization
          ? { kind: "text", text: "Summary of the earlier work.", inputTokens: 1_000 }
          : reply(agentCall, request);
        const input = step.inputTokens;
        const content: AssistantMessage["content"] = [];
        let stopReason: AssistantMessage["stopReason"] = "stop";
        if (step.kind === "providerError") {
          const failed: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: usage(0, 0),
            stopReason: "error",
            errorMessage: step.message,
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "error", error: failed as never });
          stream.end(failed);
          return;
        }
        if (step.kind === "text") content.push({ type: "text", text: step.text });
        if (step.kind === "thinking") content.push({ type: "thinking", thinking: step.thinking });
        if (step.kind === "toolRead") {
          content.push({
            type: "toolCall",
            id: `call-${agentCall}`,
            name: "read",
            arguments: { path: step.path },
          });
          stopReason = "toolUse";
        }
        const message: AssistantMessage = {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          // The empty reply is the issue's shape: no content, zero output tokens.
          usage: usage(input, step.kind === "empty" ? 0 : 10),
          stopReason,
          timestamp: Date.now(),
        };
        await options?.onPayload?.(
          {
            model: model.id,
            system: [{ type: "text", text: context.systemPrompt ?? "" }],
            messages: context.messages,
          },
          model,
        );
        const partial = { ...message, content: [] as AssistantMessage["content"] };
        stream.push({ type: "start", partial: partial as never });
        if (step.kind === "text") {
          stream.push({ type: "text_start", contentIndex: 0, partial: partial as never });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: step.text,
            partial: partial as never,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: step.text,
            partial: partial as never,
          });
        }
        stream.push({
          type: "done",
          reason: stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end(message);
      } catch (error) {
        const failed: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: usage(0, 0),
          stopReason: "error",
          errorMessage: String(error),
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: failed as never });
        stream.end(failed);
      }
    });
    return stream;
  };
}

let root: string;
const runtimes: Array<{ dispose(): Promise<void> }> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-empty-381-"));
  const agentDir = join(root, "testbot");
  mkdirSync(join(agentDir, "work"), { recursive: true });
  mkdirSync(join(agentDir, ".pi-agent"));
  writeFileSync(
    join(agentDir, "bob.yaml"),
    `agent:\n  id: testbot\n  role: reviewer\nprovider:\n  name: anthropic\n  model: ${STUB_MODEL}\n  context_window: ${CONTEXT_WINDOW}\ntools:\n  allow:\n    - read\n`,
  );
  writeFileSync(join(agentDir, "soul.md"), "You are Testbot.");
});

afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  rmSync(root, { recursive: true, force: true });
});

/** bob's ONE session factory over pi's runtime, with the scripted provider in
 *  place of the agent's own. */
async function liveFactory(
  reply: (agentCall: number, request: SeenRequest) => Reply,
  seen: SeenRequest[],
): Promise<{
  factory: RunSessionFactory;
  sessions: RunSession[];
  logs: string[];
  ended: Array<{ content: unknown; stopReason?: string }>;
  compactions: Array<{ result?: unknown; aborted?: boolean }>;
}> {
  const logs: string[] = [];
  const sessions: RunSession[] = [];
  const ended: Array<{ content: unknown; stopReason?: string }> = [];
  const compactions: Array<{ result?: unknown; aborted?: boolean }> = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "testbot", ".pi-agent", "auth.json"),
    modelsPath: null,
  });
  modelRuntime.registerProvider(STUB_PROVIDER, {
    name: "Stub",
    apiKey: "stub-key",
    api: STUB_API,
    baseUrl: "http://localhost:0",
    streamSimple: scriptedProvider(reply, seen),
    models: [
      {
        id: STUB_MODEL,
        name: "Stub",
        api: STUB_API,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: 4096,
      },
    ],
  });
  const factory: RunSessionFactory = async (config) => {
    const bobFactory = createBobRuntimeFactory({
      config: {
        ...config,
        provider: STUB_PROVIDER,
        providerRecord: undefined,
        compactionThreshold: 0.5,
        modelLimits: {
          provider: STUB_PROVIDER,
          model: config.model,
          contextWindow: CONTEXT_WINDOW,
        },
      },
      policy: {
        tools: config.tools,
        excludeTools: config.excludeTools,
        resident: false,
        allowResidentShell: false,
      },
      deps: { log: (m) => logs.push(m), exit: () => {} },
      modelRuntime,
    });
    const runtime = await createAgentSessionRuntime(bobFactory, {
      cwd: config.cwd,
      agentDir: config.piAgentDir,
      sessionManager: SessionManager.inMemory(config.cwd),
    });
    runtimes.push(runtime);
    const session = runtime.session as unknown as RunSession;
    sessions.push(session);
    // What pi's own event stream says each assistant message ended as.
    session.subscribe((event) => {
      const e = event as {
        type?: string;
        result?: unknown;
        aborted?: boolean;
        message?: { role?: string; content?: unknown; stopReason?: string };
      };
      if (e.type === "compaction_end") {
        compactions.push({ result: e.result, aborted: e.aborted });
        return;
      }
      if (e.type !== "message_end" || e.message?.role !== "assistant") return;
      ended.push({ content: e.message.content, stopReason: e.message.stopReason });
    });
    return session;
  };
  return { factory, sessions, logs, ended, compactions };
}

/** Every record of the run log this run wrote. */
function runLogRecords(): Array<Record<string, unknown>> {
  const runsDir = join(root, "testbot", "runs");
  if (!existsSync(runsDir)) return [];
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const last = files[files.length - 1];
  if (last === undefined) return [];
  return readFileSync(join(runsDir, last), "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("empty response after a compaction checkpoint (#381)", () => {
  it("a: one empty response right after the checkpoint, then a normal response, completes the run", async () => {
    const seen: SeenRequest[] = [];
    const work = join(root, "testbot", "work");
    for (const n of [1, 2, 3]) {
      writeFileSync(join(work, `big${n}.txt`), `BIG${n}-MARKER ${"x".repeat(40_000)}`);
    }
    let requestsAtCheckpoint = 0;
    const live = await liveFactory((agentCall, request) => {
      if (request.messagesJson.includes("[BOB CONTEXT CHECKPOINT")) {
        requestsAtCheckpoint += 1;
        // The empty answer, then the same request re-issued. The final answer's
        // usage is below the threshold, as a compacted context's is.
        return requestsAtCheckpoint === 1
          ? { kind: "empty", inputTokens: 1_000 }
          : { kind: "text", text: "DONE: the task is finished.", inputTokens: 1_000 };
      }
      if (agentCall === 1) return { kind: "toolRead", path: "big1.txt", inputTokens: 10_000 };
      if (agentCall === 2) return { kind: "toolRead", path: "big2.txt", inputTokens: 20_000 };
      return { kind: "toolRead", path: "big3.txt", inputTokens: OVER_THRESHOLD };
    }, seen);
    const res = await runAgent({
      name: "testbot",
      agentsRoot: root,
      prompt: "do the thing",
      captureStdout: true,
      sessionFactory: live.factory,
    });
    const agentRequests = seen.filter((r) => !r.summarization);
    // pi never saw the empty attempt: no assistant message ended with no content.
    expect(
      live.ended.filter((m) => Array.isArray(m.content) && m.content.length === 0),
    ).toHaveLength(0);
    // The checkpoint request and ITS re-issue: three tool turns, then the
    // checkpoint turn, then the same request again — identical context, so no user
    // message was added between them.
    expect(agentRequests[3]?.messagesJson).toContain("[BOB CONTEXT CHECKPOINT");
    expect(agentRequests[4]?.messagesJson).toBe(agentRequests[3]?.messagesJson);
    // The compaction that produced the checkpoint COMPLETED: the empty response
    // is answered after a successful compaction, not after a failed one.
    expect(live.compactions).toHaveLength(1);
    expect(live.compactions[0]?.aborted).toBe(false);
    expect(live.compactions[0]?.result).toBeTruthy();
    expect(live.logs.some((l) => l.includes("re-issuing the same request (1/3)"))).toBe(true);
    // The empty turn never reached the run's judge: the compaction continue turn
    // (a NEW user message) was never sent.
    expect(agentRequests.some((r) => r.lastUserText.includes("[BOB CONTINUE"))).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(res.stdout).toBe("DONE: the task is finished.");
  }, 20_000);

  it("b: always empty ends with the named error after the bound", async () => {
    const seen: SeenRequest[] = [];
    const live = await liveFactory(() => ({ kind: "empty", inputTokens: 1_000 }), seen);
    const errors: string[] = [];
    // The ending pi sees, read from the real session's own events.
    const result = await runAgent({
      name: "testbot",
      agentsRoot: root,
      prompt: "do the thing",
      sessionFactory: async (config) => {
        const session = await live.factory(config);
        session.subscribe((event) => {
          const e = event as {
            type?: string;
            message?: { role?: string; stopReason?: string; errorMessage?: string };
          };
          if (e.type !== "message_end" || e.message?.role !== "assistant") return;
          if (e.message.stopReason === "error" && e.message.errorMessage !== undefined) {
            errors.push(e.message.errorMessage);
          }
        });
        return session;
      },
    });
    const agentRequests = seen.filter((r) => !r.summarization);
    // The first request plus the bound's re-issues, each one the same request.
    expect(agentRequests).toHaveLength(DEFAULT_MAX_EMPTY_RESPONSE_RETRIES + 1);
    expect(new Set(agentRequests.map((r) => r.messagesJson)).size).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("empty_response");
    expect(result.failed).toBe(true);
    // The named error names the provider, the model and the empty response.
    const ending = errors.at(-1) ?? "";
    expect(ending).toContain(STUB_PROVIDER);
    expect(ending).toContain(STUB_MODEL);
    expect(ending).toContain(EMPTY_RESPONSE_MARK);
    const records = runLogRecords();
    expect(records.find((r) => "outcome" in r)?.outcome).toEqual({
      reason: "empty_response",
      provider: STUB_PROVIDER,
      model: STUB_MODEL,
      retries: DEFAULT_MAX_EMPTY_RESPONSE_RETRIES,
    });
    expect(records.at(-1)).toEqual({ done: true, exitCode: 1, reason: "empty_response" });
  }, 30_000);

  it("c: bob#256's reasoning-only turn is unchanged — re-prompted with a new continuation turn", async () => {
    const seen: SeenRequest[] = [];
    const live = await liveFactory(
      (agentCall) =>
        agentCall === 1
          ? { kind: "thinking", thinking: "thinking about the next step", inputTokens: 1_000 }
          : { kind: "text", text: "DONE: all good.", inputTokens: 1_000 },
      seen,
    );
    const res = await runAgent({
      name: "testbot",
      agentsRoot: root,
      prompt: "do the thing",
      captureStdout: true,
      sessionFactory: live.factory,
    });
    const agentRequests = seen.filter((r) => !r.summarization);
    expect(agentRequests.map((r) => r.lastUserText)).toEqual([
      "do the thing",
      REASONING_CONTINUE_TURN,
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("DONE: all good.");
  }, 20_000);

  it("d: a provider error whose message contains the phrase is NOT classified as empty_response", async () => {
    const seen: SeenRequest[] = [];
    const live = await liveFactory(
      () => ({ kind: "providerError", message: `upstream failed: ${EMPTY_RESPONSE_MARK}` }),
      seen,
    );
    const res = await runAgent({
      name: "testbot",
      agentsRoot: root,
      prompt: "do the thing",
      sessionFactory: live.factory,
    });
    expect(res.exitCode).toBe(1);
    // A provider sentence is not provenance: only the wrapper's own typed marker
    // may name empty_response.
    expect(res.reason).toBeDefined();
    expect(res.reason).not.toBe("empty_response");
    const records = runLogRecords();
    const outcomes = records
      .filter((record) => "outcome" in record)
      .map((record) => record.outcome as { reason?: string });
    expect(outcomes.some((outcome) => outcome.reason === "empty_response")).toBe(false);
    expect(records.at(-1)).toMatchObject({ done: true, exitCode: 1, reason: res.reason });
    // One request: no re-issue loop was entered for a provider error.
    expect(seen.filter((r) => !r.summarization)).toHaveLength(1);
  }, 20_000);
});

describe("an exhausted empty response through the persistent admission (#381)", () => {
  it("rejects an admitted cron turn, so the scheduler records a fire error", async () => {
    const seen: SeenRequest[] = [];
    const live = await liveFactory(() => ({ kind: "empty", inputTokens: 1_000 }), seen);
    const handle = await startPersistent({
      name: "testbot",
      agentsRoot: root,
      log: () => {},
      sessionFactory: live.factory,
    });
    const fireLogs: string[] = [];
    const timers: Array<() => void> = [];
    const scheduler = startCronScheduler({
      entries: [{ name: "nightly", schedule: "* * * * *", prompt: "do the thing" }],
      // The same wiring the persistent runtime uses.
      fire: (entry) =>
        handle.admitTurn({ kind: "cron", job: entry.name }, entry.prompt ?? "do the thing"),
      log: (m) => fireLogs.push(m),
      setTimer: (cb): TimerHandle => {
        timers.push(cb);
        return 0 as unknown as TimerHandle;
      },
      clearTimer: () => {},
    });
    try {
      timers.splice(0).forEach((cb) => {
        cb();
      });
      for (let i = 0; i < 300 && !fireLogs.some((l) => l.includes("fire error")); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(fireLogs.some((l) => l.includes("fire error"))).toBe(true);
      expect(fireLogs.some((l) => l.includes("empty response"))).toBe(true);
      expect(seen.filter((r) => !r.summarization)).toHaveLength(
        DEFAULT_MAX_EMPTY_RESPONSE_RETRIES + 1,
      );
    } finally {
      scheduler.stop();
      await handle.shutdown();
    }
  }, 30_000);

  it("a recovered retry resolves the admitted turn", async () => {
    const seen: SeenRequest[] = [];
    const live = await liveFactory(
      (agentCall) =>
        agentCall === 1
          ? { kind: "empty", inputTokens: 1_000 }
          : { kind: "text", text: "DONE: recovered", inputTokens: 1_000 },
      seen,
    );
    const handle = await startPersistent({
      name: "testbot",
      agentsRoot: root,
      log: () => {},
      sessionFactory: live.factory,
    });
    try {
      const messages = await handle.admitTurn({ kind: "cron", job: "nightly" }, "do the thing");
      expect(messages.length).toBeGreaterThan(0);
      expect(seen.filter((r) => !r.summarization)).toHaveLength(2);
    } finally {
      await handle.shutdown();
    }
  }, 30_000);
});

/** The real session with one completed prior turn, so the automatic compaction
 *  after the exhausted turn has history to compact. */
async function seededLiveFactory(
  reply: (agentCall: number, request: SeenRequest) => Reply,
  seen: SeenRequest[],
  seedText = "prior turn",
) {
  const live = await liveFactory(reply, seen);
  const build = live.factory;
  live.factory = async (config) => {
    const session = await build(config);
    await session.prompt(seedText, { expandPromptTemplates: false });
    return session;
  };
  return live;
}

describe("an exhausted turn stays failed through automatic compaction (#381)", () => {
  const PROMPT = "x".repeat(240_000);

  it("the one-shot run fails with empty_response and sends no continuation", async () => {
    const seen: SeenRequest[] = [];
    const live = await seededLiveFactory(
      (agentCall) =>
        agentCall === 1
          ? { kind: "text", text: "PRIOR: done.", inputTokens: 1_000 }
          : agentCall <= DEFAULT_MAX_EMPTY_RESPONSE_RETRIES + 2
            ? { kind: "empty", inputTokens: 60_000 }
            : { kind: "text", text: "DONE: answered after compaction.", inputTokens: 1_000 },
      seen,
    );
    const res = await runAgent({
      name: "testbot",
      agentsRoot: root,
      prompt: PROMPT,
      captureStdout: true,
      sessionFactory: live.factory,
    });
    const agentRequests = seen.filter((r) => !r.summarization);
    // The prior turn plus the exhausted request and its bound's re-issues; the
    // compaction runs, and no message follows it.
    expect(agentRequests).toHaveLength(DEFAULT_MAX_EMPTY_RESPONSE_RETRIES + 2);
    expect(live.compactions).toHaveLength(1);
    expect(live.compactions[0]?.result).toBeTruthy();
    expect(agentRequests.some((r) => r.lastUserText.includes("[BOB CONTINUE"))).toBe(false);
    expect(agentRequests.some((r) => r.messagesJson.includes("[BOB WHAT REMAINS"))).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("empty_response");
  }, 60_000);

  it("the persistent admission rejects the turn and the scheduler records a fire error", async () => {
    const seen: SeenRequest[] = [];
    const live = await seededLiveFactory(
      (agentCall) =>
        agentCall === 1
          ? { kind: "text", text: "PRIOR: done.", inputTokens: 1_000 }
          : agentCall <= DEFAULT_MAX_EMPTY_RESPONSE_RETRIES + 2
            ? { kind: "empty", inputTokens: 60_000 }
            : { kind: "text", text: "DONE: answered after compaction.", inputTokens: 1_000 },
      seen,
    );
    const handle = await startPersistent({
      name: "testbot",
      agentsRoot: root,
      log: () => {},
      sessionFactory: live.factory,
    });
    const fireLogs: string[] = [];
    const timers: Array<() => void> = [];
    const scheduler = startCronScheduler({
      entries: [{ name: "nightly", schedule: "* * * * *", prompt: PROMPT }],
      fire: (entry) => handle.admitTurn({ kind: "cron", job: entry.name }, entry.prompt ?? PROMPT),
      log: (m) => fireLogs.push(m),
      setTimer: (cb): TimerHandle => {
        timers.push(cb);
        return 0 as unknown as TimerHandle;
      },
      clearTimer: () => {},
    });
    try {
      timers.splice(0).forEach((cb) => {
        cb();
      });
      for (let i = 0; i < 600 && !fireLogs.some((l) => l.includes("fire error")); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const agentRequests = seen.filter((r) => !r.summarization);
      expect(fireLogs.some((l) => l.includes("fire error"))).toBe(true);
      expect(fireLogs.some((l) => l.includes("empty response"))).toBe(true);
      expect(agentRequests).toHaveLength(DEFAULT_MAX_EMPTY_RESPONSE_RETRIES + 2);
      expect(live.compactions).toHaveLength(1);
      expect(agentRequests.some((r) => r.messagesJson.includes("[BOB WHAT REMAINS"))).toBe(false);
    } finally {
      scheduler.stop();
      await handle.shutdown();
    }
  }, 60_000);
});

describe("the empty-response bound (#381)", () => {
  it("is a positive integer, capped at the constant", () => {
    expect(resolveMaxEmptyResponseRetries(undefined)).toBe(DEFAULT_MAX_EMPTY_RESPONSE_RETRIES);
    expect(resolveMaxEmptyResponseRetries(1)).toBe(1);
    expect(resolveMaxEmptyResponseRetries(99)).toBe(DEFAULT_MAX_EMPTY_RESPONSE_RETRIES);
    for (const bad of [0, -1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveMaxEmptyResponseRetries(bad)).toThrow(/invalid maxEmptyResponseRetries/);
    }
  }, 10_000);
});
