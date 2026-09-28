// Integration (bob#185 slice 1): the two things the spec asked the builder to
// VERIFY — (a) the run log's tool-result projection carries the structured
// signals, and (b) pi's tool execution context cwd equals Bob's pinned
// config.cwd on the run, launch and persistent entry paths — plus a REAL-session
// proof that a tool observes that cwd.

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
import { initAgent } from "../../../src/shell/init.js";
import { startPersistent } from "../../../src/shell/persistent.js";
import type { RunSession, RunSessionConfig } from "../../../src/shell/run.js";
import {
  projectRunLogRecord,
  resolveRunConfig,
  runAgent,
  runLaunch,
} from "../../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../../src/shell/session.js";

// --- (a) the run-log projection carries the signals --------------------------

describe("anchored-edit — structured signals survive the run-log projection", () => {
  it("tool_execution_end keeps result.details.signals", () => {
    const record = projectRunLogRecord({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "edit_lines",
      isError: false,
      result: {
        content: [{ type: "text", text: "REFUSED: stale" }],
        details: { refused: true, signals: ["stale_anchor", "budget_stop"] },
      },
    });
    const details = (record.result as { details: { signals: string[] } }).details;
    // VERIFIED: the projection logs `result` whole, so `details` (and its
    // `signals`) reach the run log. No bridge in run.ts is needed.
    expect(details.signals).toEqual(["stale_anchor", "budget_stop"]);
    expect(JSON.stringify(record)).toContain("stale_anchor");
  });
});

// --- (b) run / launch / persistent pass config.cwd ---------------------------

function fakeSession(): RunSession {
  return {
    subscribe() {
      return () => {};
    },
    async prompt() {},
    get messages() {
      return [];
    },
    dispose() {},
  } as RunSession;
}

describe("anchored-edit — Bob pins config.cwd on every entry path", () => {
  let root: string;
  let agentsRoot: string;
  let agentDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-cwd-"));
    agentsRoot = join(root, "agents");
    const res = initAgent({
      name: "testbot",
      role: "builder-local",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentsRoot,
      flairKeysDir: join(root, ".flair", "keys"),
      skipFlair: true,
    });
    agentDir = res.agentDir;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const expectedCwd = () => join(agentDir, "work");

  it("run passes config.cwd === <agentDir>/work to the session factory", async () => {
    const seen: string[] = [];
    await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: async (config: RunSessionConfig) => {
        seen.push(config.cwd);
        return fakeSession();
      },
    });
    expect(seen).toEqual([expectedCwd()]);
  });

  it("launch passes config.cwd === <agentDir>/work to the session factory", async () => {
    const seen: string[] = [];
    await runLaunch({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: async (config: RunSessionConfig) => {
        seen.push(config.cwd);
        return fakeSession();
      },
    });
    expect(seen).toEqual([expectedCwd()]);
  });

  it("persistent passes config.cwd === <agentDir>/work to the session factory", async () => {
    const seen: string[] = [];
    const handle = await startPersistent({
      name: "testbot",
      agentsRoot,
      installSignalHandlers: false,
      keepAlive: async () => {},
      sessionFactory: async (config: RunSessionConfig) => {
        seen.push(config.cwd);
        return fakeSession();
      },
    });
    expect(seen).toEqual([expectedCwd()]);
    await handle.shutdown();
  });
});

// --- (b') a REAL pi session executes a tool with ctx.cwd === that cwd --------

const STUB_PROVIDER = "bob-stub";
const STUB_MODEL = "stub-1";
const probeCwds: string[] = [];

function stubProviderWithToolCall(toolName: string) {
  const state = { callCount: 0 };
  const streamSimple = (
    model: Model<string>,
    _context: Context,
    _options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    state.callCount += 1;
    const call = state.callCount;
    queueMicrotask(() => {
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const callTool = call === 1;
      const content = callTool
        ? [{ type: "toolCall" as const, id: "call-1", name: toolName, arguments: {} }]
        : [{ type: "text" as const, text: "done" }];
      const message = {
        role: "assistant" as const,
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: (callTool ? "toolUse" : "stop") as "toolUse" | "stop",
        timestamp: Date.now(),
      };
      const partial = { ...message, content: [] as typeof content };
      stream.push({ type: "start", partial: partial as never });
      stream.push({ type: "done", reason: message.stopReason, message: message as never });
      stream.end(message as never);
    });
    return stream;
  };
  return streamSimple;
}

describe("anchored-edit — a real pi session's tool context cwd is config.cwd", () => {
  let root: string;
  let agentsRoot: string;
  let agentDir: string;
  let extDir: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-cwd-live-"));
    extDir = mkdtempSync(join(tmpdir(), "bob-cwd-ext-"));
    agentsRoot = join(root, "agents");
    probeCwds.length = 0;
    const res = initAgent({
      name: "testbot",
      role: "builder-local",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentsRoot,
      flairKeysDir: join(root, ".flair", "keys"),
      skipFlair: true,
    });
    agentDir = res.agentDir;
    cwd = join(agentDir, "work");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(extDir, { recursive: true, force: true });
  });

  it("a tool's ExtensionContext.cwd equals <agentDir>/work", async () => {
    const probePath = join(extDir, "probe.js");
    writeFileSync(
      probePath,
      [
        "export default function (pi) {",
        "  pi.registerTool({",
        "    name: 'probe_cwd', label: 'Probe cwd', description: 'records the tool execution context cwd',",
        "    parameters: { type: 'object', properties: {} },",
        "    async execute(id, params, signal, onUpdate, ctx) {",
        "      globalThis.__probeCwds.push(ctx.cwd);",
        "      return { content: [{ type: 'text', text: 'ok' }], details: {} };",
        "    },",
        "  });",
        "}",
      ].join("\n"),
    );
    const runtime = await ModelRuntime.create({ modelsPath: null });
    runtime.registerProvider(STUB_PROVIDER, {
      name: "Bob Stub",
      apiKey: "stub-key",
      api: "bob-stub-api",
      baseUrl: "http://localhost:0",
      streamSimple: stubProviderWithToolCall("probe_cwd"),
      models: [
        {
          id: STUB_MODEL,
          name: "Stub",
          api: "bob-stub-api",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 4096,
        },
      ],
    });
    (globalThis as unknown as { __probeCwds: string[] }).__probeCwds = probeCwds;
    const config = resolveRunConfig({ name: "testbot", agentsRoot }).config;
    const factory = createBobRuntimeFactory({
      config: {
        ...config,
        provider: STUB_PROVIDER,
        model: STUB_MODEL,
        extensionSources: [probePath],
        capabilityBySource: { [probePath]: "probe" },
      },
      policy: {
        tools: ["probe_cwd"],
        excludeTools: [],
        resident: false,
        allowResidentShell: false,
      },
      deps: { log: () => {}, exit: () => {} },
      modelRuntime: runtime,
    });
    const { session } = await factory({
      cwd,
      agentDir: join(agentDir, ".pi-agent"),
      sessionManager: SessionManager.inMemory(cwd) as never,
    });
    try {
      await session.prompt("go", { expandPromptTemplates: false });
    } finally {
      session.dispose();
    }
    expect(probeCwds).toEqual([cwd]);
  });
});
