// Shared harness for the work-capability tests (bob#211).
//
// `workSession` builds a REAL pi session through bob's ONE session factory
// (createBobRuntimeFactory) and pi's session runtime, with a scripted stub model.
// The work capability is loaded by pi's own extension loader from a probe file
// that calls `wireWork` with test timings and a scratch state root, so every
// tool call goes through pi's registration, argument validation and agent loop,
// and bob's tool policy and audit — the wiring production uses — while the
// grace periods stay short enough for a fast suite.
//
// Every job a test starts is a job the TOOL started, in its own process group;
// cleanup kills only those groups (by the pgid the tool recorded), never by name.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type WorkSession, wireWork } from "../../../src/capabilities/work/capability.js";
import type { JobManagerOptions } from "../../../src/capabilities/work/run.js";
import type { RunSessionConfig } from "../../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../../src/shell/session.js";

export interface ToolOutcome {
  tool: string;
  isError: boolean;
  text: string;
  details: Record<string, unknown>;
}

export type Step = { tool: string; args: Record<string, unknown> } | { text: string };
// The scripted model: given every tool result so far, the next step.
export type Script = (results: ToolOutcome[]) => Step | Promise<Step>;

const STUB_PROVIDER = "bob-work-stub";
const STUB_MODEL = "stub-1";

function toolResults(context: Context): ToolOutcome[] {
  const out: ToolOutcome[] = [];
  for (const m of context.messages as unknown as Array<Record<string, unknown>>) {
    if (m.role !== "toolResult") continue;
    const content = (m.content as Array<{ type: string; text?: string }>) ?? [];
    out.push({
      tool: String(m.toolName),
      isError: m.isError === true,
      text: content.map((c) => c.text ?? "").join("\n"),
      details: (m.details ?? {}) as Record<string, unknown>,
    });
  }
  return out;
}

function stubStream(script: Script) {
  let call = 0;
  return (model: Model<string>, context: Context): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    call += 1;
    const id = call;
    void (async () => {
      let step: Step;
      try {
        step = await script(toolResults(context));
      } catch (err) {
        step = { text: `script error: ${(err as Error).message}` };
      }
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const isTool = "tool" in step;
      const content = isTool
        ? [
            {
              type: "toolCall" as const,
              id: `call-${id}`,
              name: (step as { tool: string }).tool,
              arguments: (step as { args: Record<string, unknown> }).args,
            },
          ]
        : [{ type: "text" as const, text: (step as { text: string }).text }];
      const message = {
        role: "assistant" as const,
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: (isTool ? "toolUse" : "stop") as "toolUse" | "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } as never });
      stream.push({ type: "done", reason: message.stopReason, message: message as never });
      stream.end(message as never);
    })();
    return stream;
  };
}

export interface LiveWork {
  runtime: AgentSessionRuntime;
  work: WorkSession;
  logs: string[];
  scratch: string;
  stateRoot: string;
  cwd: string;
  // Every tool result the session produced, in order.
  results: ToolOutcome[];
  // Send one prompt; the scripted model runs until it answers with text.
  prompt(): Promise<void>;
  cleanup(): Promise<void>;
}

// Test timings: short grace periods, the production defaults otherwise.
// The probe extension pi loads: CONSTANT text, with no value built into it. It
// calls the one wiring hook the harness installs on globalThis while this
// session loads (WIRE_HOOK below), so everything per-session — the scratch
// state root, the timings, the log — reaches the capability as data.
const WIRE_HOOK = "__bobWorkTestWire";
const PROBE_SOURCE =
  "export default async function (pi) { await globalThis.__bobWorkTestWire(pi); }\n";

export const FAST: Partial<JobManagerOptions> = {
  killGraceMs: 400,
  reapLimitMs: 1500,
  drainGraceMs: 250,
};

export async function workSession(opts: {
  script: Script;
  wire?: Partial<JobManagerOptions>;
  // Reuse a state root (the boot-sweep tests seed it before the session loads).
  stateRoot?: string;
}): Promise<LiveWork> {
  const scratch = mkdtempSync(join(tmpdir(), "bob-work-test-"));
  const cwd = join(scratch, "workspace");
  const piAgentDir = join(scratch, "pi-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(piAgentDir, { recursive: true });
  const stateRoot = opts.stateRoot ?? join(scratch, "state");
  const probePath = join(scratch, "work-probe.js");
  writeFileSync(probePath, PROBE_SOURCE);
  const logs: string[] = [];
  let work: WorkSession | undefined;
  const wire = async (pi: unknown) => {
    work = wireWork({
      pi: pi as Parameters<typeof wireWork>[0]["pi"],
      stateRoot,
      ...FAST,
      ...opts.wire,
      log: (m) => logs.push(m),
    });
    await work.bootSweep;
  };

  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerProvider(STUB_PROVIDER, {
    name: "Bob Work Stub",
    apiKey: "stub-key",
    api: "bob-work-stub-api",
    baseUrl: "http://localhost:0",
    streamSimple: stubStream(opts.script),
    models: [
      {
        id: STUB_MODEL,
        name: "Stub",
        api: "bob-work-stub-api",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
  });
  const config: RunSessionConfig = {
    provider: STUB_PROVIDER,
    model: STUB_MODEL,
    appendSystemPrompt: "",
    cwd,
    piAgentDir,
    extensionSources: [probePath],
    capabilityBySource: { [probePath]: "work" },
    capabilityEnv: {},
    tools: ["run", "run_status", "run_cancel"],
    excludeTools: [],
  };
  const factory = createBobRuntimeFactory({
    config,
    policy: {
      tools: ["run", "run_status", "run_cancel"],
      excludeTools: [],
      resident: false,
      allowResidentShell: false,
    },
    deps: { log: (m) => logs.push(m), exit: () => {} },
    modelRuntime,
  });
  // The hook is installed only while THIS session loads; one load at a time.
  const hooks = globalThis as unknown as Record<string, unknown>;
  if (hooks[WIRE_HOOK] !== undefined) {
    throw new Error("workSession: another work session is loading; load them one at a time");
  }
  hooks[WIRE_HOOK] = wire;
  let runtime: AgentSessionRuntime;
  try {
    runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });
  } finally {
    delete hooks[WIRE_HOOK];
  }
  if (!work) throw new Error("the work capability did not load into the session");
  const results: ToolOutcome[] = [];
  runtime.session.subscribe((event: unknown) => {
    const e = event as {
      type?: string;
      toolName?: string;
      isError?: boolean;
      result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> };
    };
    if (e.type !== "tool_execution_end") return;
    results.push({
      tool: String(e.toolName),
      isError: e.isError === true,
      text: (e.result?.content ?? []).map((c) => c.text ?? "").join("\n"),
      details: e.result?.details ?? {},
    });
  });
  const live: LiveWork = {
    runtime,
    work,
    logs,
    scratch,
    stateRoot,
    cwd,
    results,
    async prompt() {
      await runtime.session.prompt("go", { expandPromptTemplates: false });
    },
    async cleanup() {
      try {
        await runtime.dispose();
      } catch {
        // already disposed
      }
      // Belt and braces: any group the TOOL started that is somehow still alive.
      for (const job of work?.manager.list() ?? []) {
        try {
          process.kill(-job.pgid, "SIGKILL");
        } catch {
          // gone
        }
      }
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  return live;
}

// A group probe for assertions: true while any process is in the group.
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
