// bob#365 at the REAL pi session boundary.
//
// narration-turn.test.ts scripts the RunSession seam. This file drives
// `runAgent` through bob's ONE session factory (createBobRuntimeFactory) and
// pi's own AgentSession runtime, with a scripted PROVIDER: pi runs the turn,
// emits its own events, and ends the assistant message itself. What it proves
// that the seam tests cannot: pi ends a narrating text-only turn as the agent
// being finished, bob's re-prompt reaches the provider as a new user turn of the
// SAME session (the continuation text is what the model is sent), and the
// outcome is read from pi's own events.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import {
  DEFAULT_MAX_NARRATION_REPROMPTS,
  NARRATION_CONTINUE_TURN,
} from "../../src/shell/compaction-contract.js";
import { type RunSession, type RunSessionFactory, runAgent } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

const STUB_PROVIDER = "bob-narration-stub";
const STUB_API = "bob-narration-stub-api";
const MAX_PROVIDER_CALLS = 20;

/** One provider request as the stub saw it. */
interface SeenRequest {
  /** The text of the LAST user message in the request's context. */
  lastUserText: string;
  /** True when the request carried the system prompt (the contract block). */
  hadSystemPrompt: boolean;
}

function userText(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (m?.role !== "user") return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .map((b) =>
      typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "",
    )
    .join("");
}

/**
 * A scripted provider that behaves like a real API client: it calls
 * `onPayload` (so bob's request guard runs), then streams ONE text-only
 * assistant message whose text `reply(call)` decides, ending with stop.
 * MAX_PROVIDER_CALLS is the stop for a broken bound: a request past it ends on
 * an error, which ends the narration loop, so the suite fails an assertion
 * instead of spinning.
 */
function scriptedProvider(reply: (call: number) => string, seen: SeenRequest[]) {
  let calls = 0;
  return (
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const call = ++calls;
    queueMicrotask(async () => {
      const users = context.messages.filter((m) => (m as { role?: string }).role === "user");
      seen.push({
        lastUserText: userText(users[users.length - 1]),
        hadSystemPrompt: (context.systemPrompt ?? "").length > 0,
      });
      const text = call > MAX_PROVIDER_CALLS ? "" : reply(call);
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text }],
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
      try {
        if (call > MAX_PROVIDER_CALLS) throw new Error("stub: provider call guard exceeded");
        await options?.onPayload?.(
          {
            model: model.id,
            system: [{ type: "text", text: context.systemPrompt ?? "" }],
            messages: context.messages,
          },
          model,
        );
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
      } catch (error) {
        const failed = {
          ...message,
          content: [],
          stopReason: "error" as const,
          errorMessage: String(error),
        };
        stream.push({ type: "error", reason: "error", error: failed as never });
        stream.end(failed as never);
      }
    });
    return stream;
  };
}

let root: string;
const runtimes: Array<{ dispose(): Promise<void> }> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-narration-live-"));
  const agentDir = join(root, "testbot");
  mkdirSync(join(agentDir, "work"), { recursive: true });
  mkdirSync(join(agentDir, ".pi-agent"));
  // A reviewer: its role declares no final markers, so the run declares them
  // through `finalMarkers`.
  writeFileSync(
    join(agentDir, "bob.yaml"),
    "agent:\n  id: testbot\n  role: reviewer\nprovider:\n  name: anthropic\n  model: claude-sonnet-4-6\n  context_window: 200000\ntools:\n  allow:\n    - read\n",
  );
  writeFileSync(join(agentDir, "soul.md"), "You are Testbot.");
});

afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  rmSync(root, { recursive: true, force: true });
});

/** bob's ONE session factory over pi's runtime, with the scripted provider in
 *  place of the agent's own. Bob's request guard and tool audit run as usual;
 *  a session log or exit is recorded so a test can assert none happened. */
async function liveFactory(
  reply: (call: number) => string,
): Promise<{ factory: RunSessionFactory; seen: SeenRequest[]; logs: string[]; exits: number[] }> {
  const seen: SeenRequest[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
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
        id: "claude-sonnet-4-6",
        name: "Stub",
        api: STUB_API,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
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
        modelLimits: { provider: STUB_PROVIDER, model: config.model, contextWindow: 200_000 },
      },
      policy: {
        tools: config.tools,
        excludeTools: config.excludeTools,
        resident: false,
        allowResidentShell: false,
      },
      deps: { log: (m) => logs.push(m), exit: (code) => exits.push(code) },
      modelRuntime,
    });
    const runtime = await createAgentSessionRuntime(bobFactory, {
      cwd: config.cwd,
      agentDir: config.piAgentDir,
      sessionManager: SessionManager.inMemory(config.cwd),
    });
    runtimes.push(runtime);
    return runtime.session as unknown as RunSession;
  };
  return { factory, seen, logs, exits };
}

describe("narration turn through a REAL pi session (#365)", () => {
  it("narration → the fixed continuation as a new user turn → a final report starting with DONE completes", async () => {
    const live = await liveFactory((call) =>
      call === 1 ? "The spec says … Let me fix lines 282-284:" : "DONE: lines 282-284 fixed.",
    );
    const res = await runAgent({
      name: "testbot",
      agentsRoot: root,
      prompt: "Fix lines 282-284.",
      finalMarkers: ["DONE", "BLOCKED"],
      captureStdout: true,
      sessionFactory: live.factory,
    });
    // Two provider requests in ONE session: the task, then bob's continuation.
    expect(live.seen.map((r) => r.lastUserText)).toEqual([
      "Fix lines 282-284.",
      NARRATION_CONTINUE_TURN,
    ]);
    expect(live.seen.every((r) => r.hadSystemPrompt)).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(res.failed).toBeUndefined();
    expect(res.stdout).toBe("DONE: lines 282-284 fixed.");
    expect(live.exits).toEqual([]);
  }, 20_000);

  it("narration past the bound fails the run as narration_only", async () => {
    const live = await liveFactory(() => "Let me verify they're pre-existing:");
    const res = await runAgent({
      name: "testbot",
      agentsRoot: root,
      prompt: "Fix lines 282-284.",
      finalMarkers: ["DONE", "BLOCKED"],
      captureStdout: true,
      sessionFactory: live.factory,
    });
    expect(live.seen.map((r) => r.lastUserText)).toEqual([
      "Fix lines 282-284.",
      ...Array(DEFAULT_MAX_NARRATION_REPROMPTS).fill(NARRATION_CONTINUE_TURN),
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("narration_only");
    expect(res.failed).toBe(true);
    expect(live.exits).toEqual([]);
  }, 20_000);

  it("with no declared markers, the same narration ends the run on its first stop (unchanged)", async () => {
    const live = await liveFactory(() => "Let me verify they're pre-existing:");
    const res = await runAgent({
      name: "testbot",
      agentsRoot: root,
      prompt: "Fix lines 282-284.",
      captureStdout: true,
      sessionFactory: live.factory,
    });
    expect(live.seen).toHaveLength(1);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("Let me verify they're pre-existing:");
  }, 20_000);
});
