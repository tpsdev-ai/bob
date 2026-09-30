// bob#225 item 3 — the refresh test. #215 wrapped pi's model-runtime `getModel`
// so a `getModel` lookup of the session's declared provider/model pair returns
// its declared context window (and output cap), "including after pi refreshes
// the session's model" (`applyModelLimits`, src/shell/model-budget.ts). The
// wrapper covers `getModel` only; pi also lists models through `getModels()`
// (for example to resolve a CLI model pattern), which the wrapper does not
// change and this file does not exercise.
// #215 checked the `getModel` lookup directly (`runtime.getModel(...)`) but
// never EXECUTED a refresh.
//
// This file builds REAL pi sessions through bob's ONE factory (fake provider, no
// network) and drives pi's refresh path through a real extension that registers
// a provider, which makes pi re-resolve the session's model from the runtime
// (`AgentSession._refreshCurrentModelFromRegistry` -> `getModel`).
// The assertion is end to end — the refreshed session model, and the next
// request pi builds from it, carry bob.yaml's window and cap, not the registry's.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import type { RunSession, RunSessionConfig } from "../../src/shell/run.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

const STUB_PROVIDER = "bob-stub-214";
const STUB_MODEL = "stub-214";
const STUB_API = "bob-stub-214-api";

// The registry's numbers — deliberately DIFFERENT from bob.yaml's, so a test
// can tell which one resolved (this is the #214 disagreement the wrapper exists
// for: pi's registry said one thing, the server enforced another).
const REGISTRY_WINDOW = 131_072;
const REGISTRY_MAX_TOKENS = 32_000;
// bob.yaml's numbers, declared for the pair this session runs.
const CONFIG_WINDOW = 262_144;
const CONFIG_MAX_OUTPUT = 16_000;

let root: string;
let agentsRoot: string;
let cwd: string;
let piAgentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-225-refresh-"));
  agentsRoot = join(root, "agents");
  // The fixture bob.yaml IS the source of the asserted pair and its limits: it
  // declares the stub provider/model AND both the context window and the output
  // cap, so the test asserts against the limits bob resolves FROM THIS FILE.
  const res = initAgent({
    name: "budgetbot",
    role: "ea",
    provider: STUB_PROVIDER,
    model: STUB_MODEL,
    contextWindow: CONFIG_WINDOW,
    agentsRoot,
    skipFlair: true,
  });
  // `bob init` writes provider.context_window; the output cap is added under
  // `provider:` here so the fixture declares BOTH limits.
  const yamlPath = join(res.agentDir, "bob.yaml");
  writeFileSync(
    yamlPath,
    readFileSync(yamlPath, "utf8").replace(
      /^ {2}context_window: \d+$/m,
      `  context_window: ${CONFIG_WINDOW}\n  max_output_tokens: ${CONFIG_MAX_OUTPUT}`,
    ),
  );
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

/** A minimal stub provider: one text answer per request, recording the model
 *  pi handed it (so a test can read the window/cap the request carried). */
function stubProvider() {
  const requests: Array<{ model: Model<string> }> = [];
  const streamSimple = (
    model: Model<string>,
    _context: Context,
    _options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    requests.push({ model });
    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage(10, 1),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
  return { requests, streamSimple };
}

/** A ModelRuntime whose REGISTRY declares this stub pair with the DISAGREEING
 *  numbers, so a `getModel` lookup of this pair that bypasses bob's wrapper
 *  reads 131072 (and 32000 max tokens). */
async function stubRuntime(streamSimple: ReturnType<typeof stubProvider>["streamSimple"]) {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider(STUB_PROVIDER, {
    name: "Bob Stub 225",
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
        contextWindow: REGISTRY_WINDOW,
        maxTokens: REGISTRY_MAX_TOKENS,
      },
    ],
  });
  return runtime;
}

/**
 * A real extension source that registers a provider every time an agent run
 * starts, through pi's extension API (`pi.registerProvider`), an API a
 * capability CAN use; no capability bob ships registers a provider today. The
 * registration makes pi re-resolve the session's model from the runtime
 * (`_refreshCurrentModelFromRegistry`), the refresh path this test executes.
 */
function refreshExtensionPath(): string {
  const path = join(root, "bob-refresh-extension.js");
  writeFileSync(
    path,
    [
      "// A test extension: register a provider when a run starts. pi re-resolves",
      "// the session's model from the runtime after a provider registration.",
      "export default function bobRefreshExtension(pi) {",
      '  pi.on("before_agent_start", () => {',
      '    pi.registerProvider("bob-refresh-probe", {',
      '      name: "Bob Refresh Probe",',
      "      apiKey: 'x',",
      `      api: '${STUB_API}',`,
      "      baseUrl: 'http://localhost:0',",
      "      models: [],",
      "    });",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  return path;
}

type LiveSession = RunSession & {
  model?: Model<string>;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
};

/** bob's ONE factory, with the refresh extension declared as a source. */
async function liveSession(input: {
  runtime: ModelRuntime;
  extensionSources?: string[];
}): Promise<LiveSession> {
  // The session's provider/model pair AND its limits come from the fixture
  // bob.yaml via resolveRunConfig; the test does not override them. It does
  // override two other fields of the resolved config, `extensionSources` (the
  // refresh extension it drives) and `capabilityBySource` (set to `{}`), and it
  // passes its own tool policy and a stub model runtime whose registry declares
  // the same pair with disagreeing limits (stubRuntime).
  const base = resolveRunConfig({ name: "budgetbot", agentsRoot }).config;
  const factory = createBobRuntimeFactory({
    config: {
      ...base,
      capabilityBySource: {},
      extensionSources: input.extensionSources ?? [],
    } as RunSessionConfig,
    policy: { tools: ["read"], excludeTools: [], resident: false, allowResidentShell: false },
    deps: { log: () => {}, exit: () => {} },
    modelRuntime: input.runtime,
  });
  const result = await factory({
    cwd,
    agentDir: piAgentDir,
    sessionManager: SessionManager.inMemory(cwd) as never,
  });
  return result.session as unknown as LiveSession;
}

describe("bob#225 — pi's model refresh resolves bob's declared window, end to end", () => {
  it("an extension registering a provider refreshes the session's model through bob's getModel, and the next request carries the declared window and cap", async () => {
    const stub = stubProvider();
    const runtime = await stubRuntime(stub.streamSimple);
    const session = await liveSession({
      runtime,
      extensionSources: [refreshExtensionPath()],
    });
    try {
      // Precondition (the creation path): the session's model already carries
      // the window and cap the fixture bob.yaml declares, not the registry's.
      const before = session.model;
      expect(before?.contextWindow).toBe(CONFIG_WINDOW);
      expect(before?.maxTokens).toBe(CONFIG_MAX_OUTPUT);

      // The prompt runs `before_agent_start`, the extension registers a
      // provider, and pi re-resolves the session's model from the runtime. The
      // refresh actually ran: pi replaced the model with the one `getModel`
      // returned (a fresh object), so identity changes.
      await session.prompt("hello", { expandPromptTemplates: false });
      expect(session.model).not.toBe(before);
      const afterFirstRefresh = session.model;
      // And what the refresh resolved is bob.yaml's pair, not the registry's.
      expect(afterFirstRefresh?.contextWindow).toBe(CONFIG_WINDOW);
      expect(afterFirstRefresh?.maxTokens).toBe(CONFIG_MAX_OUTPUT);
      // The request pi built from the refreshed model carries the window and cap.
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0]?.model.contextWindow).toBe(CONFIG_WINDOW);
      expect(stub.requests[0]?.model.maxTokens).toBe(CONFIG_MAX_OUTPUT);

      // The registry's own lookup still resolves through the wrapper too.
      expect(runtime.getModel(STUB_PROVIDER, STUB_MODEL)?.contextWindow).toBe(CONFIG_WINDOW);

      // A second run refreshes AGAIN (the same registration), after an explicit
      // runtime refresh. The explicit refresh must not abort or error...
      const refreshed = await runtime.refresh({ allowNetwork: false });
      expect(refreshed.aborted).toBe(false);
      expect(refreshed.errors.size).toBe(0);
      await session.prompt("again", { expandPromptTemplates: false });
      // ...and the second prompt must have REPLACED the model again — a fresh
      // object, not the one the first refresh produced — still carrying the
      // declared window and cap end to end.
      expect(session.model).not.toBe(afterFirstRefresh);
      expect(session.model?.contextWindow).toBe(CONFIG_WINDOW);
      expect(session.model?.maxTokens).toBe(CONFIG_MAX_OUTPUT);
      expect(stub.requests.length).toBe(2);
      expect(stub.requests[1]?.model.contextWindow).toBe(CONFIG_WINDOW);
      expect(stub.requests[1]?.model.maxTokens).toBe(CONFIG_MAX_OUTPUT);
    } finally {
      session.dispose();
    }
  });
});
