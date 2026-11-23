// bob#356 V2a — the tool-admission gate through bob's REAL session factory.
//
// A scripted provider runs pi's own AgentSession and tool loop. A local fixture
// extension registers an allowed `reachy_say` and a grant-class `mail_send`;
// the gate must let the first run inside a voice turn and refuse the second
// with the fixed, named reason. No network: the provider is scripted.
//
// The gate also fails closed THROUGH the factory: a second fixture extension
// (loaded before bob's inline extensions, as pi orders them) answers the
// turn-admission service request with nothing, so the gate's own factory throws
// on load. Session creation then refuses before pi builds a session, and a
// session.reload() that loses the gate disposes the session and ends the
// process (the exit is a recorder here).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RunSession, RunSessionConfig, RunSessionFactory } from "../../src/shell/run.js";
import { assertToolAdmissionGateLoaded, createBobRuntimeFactory } from "../../src/shell/session.js";
import {
  createToolAdmissionExtension,
  VOICE_GRANT_REFUSAL,
} from "../../src/shell/tool-admission.js";
import { createTurnAdmission, runtimeEventBus } from "../../src/shell/turn-admission.js";
import type { TurnOrigin } from "../../src/shell/turn-origin.js";

const STUB_PROVIDER = "bob-voice-gate-356";
const STUB_API = "bob-voice-gate-356-api";
const STUB_MODEL = "claude-sonnet-4-6";
const CONTEXT_WINDOW = 100_000;
const TOOL_LOG = "BOB_TEST_VOICE_TOOL_LOG";
const SABOTAGE_FLAG = "BOB_TEST_GATE_SABOTAGE";

let root: string;
const roots: string[] = [];
const runtimes: Array<{ dispose(): Promise<void> }> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-voice-gate-356-"));
  roots.push(root);
  const agentDir = join(root, "testbot");
  mkdirSync(join(agentDir, "work"), { recursive: true });
  mkdirSync(join(agentDir, ".pi-agent"));
});

afterEach(async () => {
  delete process.env[SABOTAGE_FLAG];
  try {
    for (const r of runtimes.splice(0)) await r.dispose();
  } finally {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});

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

type Step =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "text"; text: string };

/** A scripted provider: one assistant message per agent request, in order. */
function scriptedProvider(steps: Step[], seen: Context[]) {
  let i = 0;
  return (
    model: Model,
    context: Context,
    _options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    seen.push(context);
    const step = steps[Math.min(i, steps.length - 1)] ?? { kind: "text", text: "done" };
    i += 1;
    queueMicrotask(() => {
      const content: AssistantMessage["content"] = [];
      let stopReason: AssistantMessage["stopReason"] = "stop";
      if (step.kind === "text") content.push({ type: "text", text: step.text });
      else {
        content.push({ type: "toolCall", id: `call-${i}`, name: step.name, arguments: step.args });
        stopReason = "toolUse";
      }
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage(10, 10),
        stopReason,
        timestamp: Date.now(),
      };
      const partial = { ...message, content: [] as AssistantMessage["content"] };
      stream.push({ type: "start", partial: partial as never });
      stream.push({
        type: "done",
        reason: stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end(message);
    });
    return stream;
  };
}

const FIXTURE = `import { appendFileSync } from "node:fs";
export default function (pi) {
  const log = (line) => appendFileSync(process.env.${TOOL_LOG}, line + "\\n");
  pi.registerTool({
    name: "reachy_say",
    label: "Reachy Say",
    description: "speak",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    async execute(_id, params) { log("reachy_say:" + params.text); return { content: [{ type: "text", text: "spoken" }], details: {} }; },
  });
  pi.registerTool({
    name: "mail_send",
    label: "Mail Send",
    description: "send mail",
    parameters: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false },
    async execute(_id, params) { log("mail_send:" + params.body); return { content: [{ type: "text", text: "sent" }], details: {} }; },
  });
}
`;

// A FAULT, not a capability: when the flag is set as it loads, this extension
// answers bob's turn-admission service request with nothing. pi loads path
// extensions before bob's inline ones and calls the bus handlers in order, so the
// gate's factory then reads no admission and throws, which pi records as an
// inline extension load error. pi unsubscribes a reloaded extension's bus
// handlers, so a reload with the flag unset loads the gate again.
const SABOTAGE = `export default function (pi) {
  if (process.env.${SABOTAGE_FLAG} === "1") {
    pi.events.on("bob:turn-admission", (receive) => receive(undefined));
  }
}
`;

/** A model runtime whose provider is the scripted one. */
async function scriptedRuntime(steps: Step[], seen: Context[]): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "testbot", ".pi-agent", "auth.json"),
    modelsPath: null,
  });
  modelRuntime.registerProvider(STUB_PROVIDER, {
    name: "Stub",
    apiKey: "stub-key",
    api: STUB_API,
    baseUrl: "http://localhost:0",
    streamSimple: scriptedProvider(steps, seen),
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
  return modelRuntime;
}

/** The session config for a fixture agent served by `admission`. */
function fixtureConfig(
  sources: Record<string, string>,
  admission: ReturnType<typeof createTurnAdmission>,
): RunSessionConfig {
  return {
    provider: STUB_PROVIDER,
    model: STUB_MODEL,
    appendSystemPrompt: "",
    cwd: join(root, "testbot", "work"),
    piAgentDir: join(root, "testbot", ".pi-agent"),
    extensionSources: Object.keys(sources),
    capabilityBySource: sources,
    capabilityEnv: {},
    turnAdmission: admission,
    tools: ["reachy_say", "mail_send"],
    excludeTools: [],
  };
}

/** bob's REAL runtime factory for `config`, with the scripted model. */
function bobFactoryFor(
  config: RunSessionConfig,
  modelRuntime: ModelRuntime,
  deps: { log: (m: string) => void; exit: (code: number) => void },
  buildSession?: typeof createAgentSessionFromServices,
) {
  return createBobRuntimeFactory({
    config: {
      ...config,
      providerRecord: undefined,
      modelLimits: { provider: STUB_PROVIDER, model: config.model, contextWindow: CONTEXT_WINDOW },
    },
    policy: {
      tools: config.tools,
      excludeTools: config.excludeTools ?? [],
      resident: false,
      allowResidentShell: false,
    },
    deps,
    modelRuntime,
    ...(buildSession !== undefined ? { buildSession } : {}),
  });
}

/** Write the two fixture extensions; returns their sources → capability names. */
function writeFixtures(): Record<string, string> {
  const fixture = join(root, "voice-fixture.ts");
  writeFileSync(fixture, FIXTURE);
  const sabotage = join(root, "gate-sabotage.ts");
  writeFileSync(sabotage, SABOTAGE);
  return { [fixture]: "voice-fixture", [sabotage]: "gate-sabotage" };
}

describe("bob#356 V2a — the admission gate through the real session factory", () => {
  it("a voice turn runs reachy_say and refuses the grant tool with the named reason", async () => {
    const toolLog = join(root, "tools.log");
    writeFileSync(toolLog, "");
    process.env[TOOL_LOG] = toolLog;
    const fixture = join(root, "voice-fixture.ts");
    writeFileSync(fixture, FIXTURE);
    const seen: Context[] = [];
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "testbot", ".pi-agent", "auth.json"),
      modelsPath: null,
    });
    modelRuntime.registerProvider(STUB_PROVIDER, {
      name: "Stub",
      apiKey: "stub-key",
      api: STUB_API,
      baseUrl: "http://localhost:0",
      streamSimple: scriptedProvider(
        [
          { kind: "tool", name: "reachy_say", args: { text: "hello from the room" } },
          { kind: "tool", name: "mail_send", args: { body: "the report" } },
          { kind: "text", text: "done" },
        ],
        seen,
      ),
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

    let realSession: RunSession | undefined;
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => {
        if (!realSession) throw new Error("the real session is not built yet");
        return realSession;
      },
    });
    const factory: RunSessionFactory = async (config) => {
      const bobFactory = createBobRuntimeFactory({
        config: {
          ...config,
          provider: STUB_PROVIDER,
          providerRecord: undefined,
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
        deps: { log: () => {}, exit: () => {} },
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

    const session = await factory({
      provider: STUB_PROVIDER,
      model: STUB_MODEL,
      appendSystemPrompt: "",
      cwd: join(root, "testbot", "work"),
      piAgentDir: join(root, "testbot", ".pi-agent"),
      extensionSources: [fixture],
      capabilityBySource: { [fixture]: "voice-fixture" },
      capabilityEnv: {},
      turnAdmission: admission,
      tools: ["reachy_say", "mail_send"],
      excludeTools: [],
    });
    realSession = session;
    admission.bind(session);

    const voice: TurnOrigin = {
      kind: "voice",
      speakerVerified: false,
      utteranceId: "utt_1",
      correlationId: "corr_1",
    };
    await admission.admitTurn(voice, "please speak, then mail the report");

    const lines = readFileSync(toolLog, "utf-8").split("\n").filter(Boolean);
    expect(lines).toEqual(["reachy_say:hello from the room"]);
    // The model saw the named refusal for the grant tool.
    const finalMessages = JSON.stringify(seen[seen.length - 1]?.messages ?? []);
    expect(finalMessages).toContain(VOICE_GRANT_REFUSAL);
    expect(finalMessages).toContain("mail_send");
  }, 60_000);
});

describe("bob#356 V2a — the gate fails closed", () => {
  it("the extension factory refuses a session with no turn-admission service", () => {
    const handlers: unknown[] = [];
    const pi = {
      events: runtimeEventBus({}),
      on(_type: string, handler: unknown) {
        handlers.push(handler);
      },
    };
    expect(() => createToolAdmissionExtension({ log: () => {} }).factory(pi)).toThrow(
      /tool admission gate has no turn-admission service/,
    );
    expect(handlers).toEqual([]);
  });

  it("the gate check refuses a load error AND a gate that is simply not loaded", () => {
    const gate = { name: "bob-tool-admission" } as never;
    const loaderWith = (
      errors: Array<{ path: string; error: string }>,
      extensions: Array<{ path: string }>,
    ) => ({ getExtensions: () => ({ errors, extensions }) });
    const loaded = [{ path: "<inline:bob-tool-admission>" }];
    expect(() =>
      assertToolAdmissionGateLoaded(
        loaderWith([{ path: "<inline:bob-tool-admission>", error: "boom" }], []),
        gate,
      ),
    ).toThrow(/tool-admission gate/);
    // No error recorded, and no gate either: still refused, by name.
    expect(() => assertToolAdmissionGateLoaded(loaderWith([], []), gate)).toThrow(
      /the tool-admission gate <inline:bob-tool-admission> is not among the loaded extensions/,
    );
    expect(() =>
      assertToolAdmissionGateLoaded(loaderWith([], [{ path: "<inline:other>" }]), gate),
    ).toThrow(/not among the loaded extensions/);
    expect(() => assertToolAdmissionGateLoaded(loaderWith([], loaded), gate)).not.toThrow();
    // A session that needs no gate (no turn admission) is not checked.
    expect(() => assertToolAdmissionGateLoaded(loaderWith([], []), undefined)).not.toThrow();
  });

  it("THROUGH the factory: a gate that fails to load refuses session creation before pi builds a session", async () => {
    const seen: Context[] = [];
    const modelRuntime = await scriptedRuntime([{ kind: "text", text: "never" }], seen);
    const admission = createTurnAdmission({ log: () => {} });
    const config = fixtureConfig(writeFixtures(), admission);
    process.env[SABOTAGE_FLAG] = "1";
    let built = 0;
    const exits: number[] = [];
    const bobFactory = bobFactoryFor(
      config,
      modelRuntime,
      { log: () => {}, exit: (code) => exits.push(code) },
      async (options) => {
        built += 1;
        return createAgentSessionFromServices(options);
      },
    );
    const creation = createAgentSessionRuntime(bobFactory, {
      cwd: config.cwd,
      agentDir: config.piAgentDir,
      sessionManager: SessionManager.inMemory(config.cwd),
    });
    await expect(creation).rejects.toThrow(/tool-admission gate/);
    await expect(creation).rejects.toThrow(
      /<inline:bob-tool-admission>: bob: tool admission gate has no turn-admission service/,
    );
    // Refused before the session existed: pi built none, so nothing was
    // prompted and nothing could be.
    expect(built).toBe(0);
    expect(seen).toEqual([]);
    expect(exits).toEqual([]);
  }, 60_000);

  it("THROUGH the factory: a reload that loses the gate disposes the session and ends the process", async () => {
    const seen: Context[] = [];
    const modelRuntime = await scriptedRuntime([{ kind: "text", text: "never" }], seen);
    const admission = createTurnAdmission({ log: () => {} });
    const config = fixtureConfig(writeFixtures(), admission);
    const exits: number[] = [];
    const logs: string[] = [];
    const bobFactory = bobFactoryFor(config, modelRuntime, {
      log: (m) => logs.push(m),
      exit: (code) => exits.push(code),
    });
    // Created with the gate loaded: the control.
    const runtime = await createAgentSessionRuntime(bobFactory, {
      cwd: config.cwd,
      agentDir: config.piAgentDir,
      sessionManager: SessionManager.inMemory(config.cwd),
    });
    runtimes.push(runtime);
    const loaded = () =>
      (
        runtime.session as unknown as {
          resourceLoader: { getExtensions(): { extensions: Array<{ path: string }> } };
        }
      ).resourceLoader
        .getExtensions()
        .extensions.map((e) => e.path);
    expect(loaded()).toContain("<inline:bob-tool-admission>");
    let disposed = 0;
    const session = runtime.session as unknown as {
      reload(): Promise<void>;
      dispose(): void;
    };
    const dispose = session.dispose.bind(session);
    session.dispose = () => {
      disposed += 1;
      dispose();
    };

    process.env[SABOTAGE_FLAG] = "1";
    await expect(session.reload()).rejects.toThrow(/tool-admission gate/);
    expect(loaded()).not.toContain("<inline:bob-tool-admission>");
    expect(exits).toEqual([1]);
    expect(disposed).toBe(1);
    expect(logs.join("\n")).toContain("<inline:bob-tool-admission>");
    expect(seen).toEqual([]);
  }, 60_000);
});
