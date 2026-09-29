// Integration (bob#185 slice 1, round 2): the two things the spec asked the
// builder to VERIFY — (a) the run log's tool-result projection carries the
// structured signals, and (b) pi's tool execution context cwd equals Bob's
// pinned config.cwd — the latter through a REAL context probe run through the
// `run`, `launch` and `persistent` entry paths (blocker 6), not fake sessions.

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
import type { RunSession, RunSessionConfig, RunSessionFactory } from "../../../src/shell/run.js";
import { projectRunLogRecord, runAgent, runLaunch } from "../../../src/shell/run.js";
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
    expect(details.signals).toEqual(["stale_anchor", "budget_stop"]);
    expect(JSON.stringify(record)).toContain("stale_anchor");
  });
});

// --- (b) a REAL context probe through run / launch / persistent --------------

const STUB_PROVIDER = "bob-stub";
const STUB_MODEL = "stub-1";

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

let root: string;
let agentsRoot: string;
let agentDir: string;
let extDir: string;
let cwd: string;
let probePath: string;
const probed: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-cwd-live-"));
  extDir = mkdtempSync(join(tmpdir(), "bob-cwd-ext-"));
  agentsRoot = join(root, "agents");
  probed.length = 0;
  const res = initAgent({
    name: "testbot",
    role: "builder-local",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextWindow: 200_000,
    agentsRoot,
    flairKeysDir: join(root, ".flair", "keys"),
    skipFlair: true,
  });
  agentDir = res.agentDir;
  cwd = join(agentDir, "work");
  probePath = join(extDir, "probe.js");
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
  (globalThis as unknown as { __probeCwds: string[] }).__probeCwds = probed;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
});

/** A RunSessionFactory that builds a REAL pi session with the probe tool, using
 *  the stub model — so the entry path drives it exactly as production does. */
function realProbeFactory(): RunSessionFactory {
  return async (config: RunSessionConfig): Promise<RunSession> => {
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
    const factory = createBobRuntimeFactory({
      config: {
        ...config,
        provider: STUB_PROVIDER,
        model: STUB_MODEL,
        modelLimits: { provider: STUB_PROVIDER, model: STUB_MODEL, contextWindow: 200_000 },
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
      cwd: config.cwd,
      agentDir: config.piAgentDir,
      sessionManager: SessionManager.inMemory(config.cwd) as never,
    });
    return session as unknown as RunSession;
  };
}

describe("anchored-edit — a REAL probe's ctx.cwd equals config.cwd on every entry path", () => {
  it("run: ctx.cwd === <agentDir>/work", async () => {
    await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: realProbeFactory(),
    });
    expect(probed).toEqual([cwd]);
  }, 60_000);

  it("launch: ctx.cwd === <agentDir>/work", async () => {
    await runLaunch({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: realProbeFactory(),
    });
    expect(probed).toEqual([cwd]);
  }, 60_000);

  it("persistent: ctx.cwd === <agentDir>/work", async () => {
    const handle = await startPersistent({
      name: "testbot",
      agentsRoot,
      installSignalHandlers: false,
      keepAlive: async () => {},
      sessionFactory: realProbeFactory(),
    });
    try {
      await handle.session.prompt("go", { expandPromptTemplates: false });
    } finally {
      await handle.shutdown();
    }
    expect(probed).toEqual([cwd]);
  }, 60_000);
});
