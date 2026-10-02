import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolveCapabilities } from "../../../src/shell/capability-loader.js";
import { createBobRuntimeFactory } from "../../../src/shell/session.js";

let scratch: string;
let savedTmpdir: string | undefined;
let savedState: string | undefined;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-work-prod-"));
  savedTmpdir = process.env.TMPDIR;
  savedState = process.env.BOB_STATE_DIR;
  process.env.BOB_STATE_DIR = join(scratch, "state");
  process.env.TMPDIR = join(scratch, "tmp");
  mkdirSync(join(scratch, "tmp"));
});
afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  if (savedState === undefined) delete process.env.BOB_STATE_DIR;
  else process.env.BOB_STATE_DIR = savedState;
  rmSync(scratch, { recursive: true, force: true });
});

function oneCallThenDone(args: Record<string, unknown>) {
  let calls = 0;
  return (model: Model<string>, _context: Context): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    calls += 1;
    const first = calls === 1;
    queueMicrotask(() => {
      const message = {
        role: "assistant" as const,
        content: first
          ? [{ type: "toolCall" as const, id: "c1", name: "run", arguments: args }]
          : [{ type: "text" as const, text: "done" }],
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
        stopReason: (first ? "toolUse" : "stop") as "toolUse" | "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } as never });
      stream.push({ type: "done", reason: message.stopReason, message: message as never });
      stream.end(message as never);
    });
    return stream;
  };
}

describe("work — loaded from the blessed catalog, production settings", () => {
  it("run with no timeout_s gets the 600 s default; output lands in temporary scratch and records in BOB_STATE_DIR", async () => {
    const { extensionSources, capabilities } = resolveCapabilities({
      yamlText: "capabilities:\n  - work\n",
    });
    expect(capabilities.map((c) => c.name)).toEqual(["work"]);
    expect(extensionSources[0]).toMatch(/dist[\\/]capabilities[\\/]work[\\/]index\.js$/);

    const cwd = join(scratch, "workspace");
    const piAgentDir = join(scratch, "pi-agent");
    mkdirSync(cwd);
    mkdirSync(piAgentDir);
    const modelRuntime = await ModelRuntime.create({ modelsPath: null });
    modelRuntime.registerProvider("bob-work-prod-stub", {
      name: "Stub",
      apiKey: "stub-key",
      api: "bob-work-prod-stub-api",
      baseUrl: "http://localhost:0",
      streamSimple: oneCallThenDone({ command: "echo production-path" }),
      models: [
        {
          id: "stub-1",
          name: "Stub",
          api: "bob-work-prod-stub-api",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 4096,
        },
      ],
    });
    const tools = ["run", "run_status", "run_cancel"];
    const factory = createBobRuntimeFactory({
      config: {
        provider: "bob-work-prod-stub",
        model: "stub-1",
        modelLimits: { provider: "bob-work-prod-stub", model: "stub-1", contextWindow: 200_000 },
        appendSystemPrompt: "",
        cwd,
        piAgentDir,
        extensionSources,
        capabilityBySource: { [extensionSources[0]]: "work" },
        capabilityEnv: { BOB_CAP_WORK: "{}" },
        tools,
        excludeTools: [],
      },
      policy: { tools, excludeTools: [], resident: false, allowResidentShell: false },
      deps: { log: () => {}, exit: () => {} },
      modelRuntime,
    });
    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });
    const results: Array<{ details: Record<string, unknown>; text: string }> = [];
    runtime.session.subscribe((event: unknown) => {
      const e = event as {
        type?: string;
        result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> };
      };
      if (e.type === "tool_execution_end") {
        results.push({
          details: e.result?.details ?? {},
          text: (e.result?.content ?? []).map((c) => c.text ?? "").join("\n"),
        });
      }
    });
    try {
      expect(runtime.session.getActiveToolNames().slice().sort()).toEqual([
        "run",
        "run_cancel",
        "run_status",
      ]);
      await runtime.session.prompt("go", { expandPromptTemplates: false });
      expect(results.length).toBe(1);
      const d = results[0].details;
      expect(d).toMatchObject({
        outcome: "exited",
        exit_code: 0,
        success: true,
        effective_timeout_s: 600,
        timeout_source: "default",
      });
      expect(results[0].text).toContain("production-path");
      const root = join(scratch, "state");
      expect(String(d.output_ref).startsWith(join(scratch, "tmp", "bob-run-"))).toBe(true);
      expect(statSync(root).mode & 0o777).toBe(0o700);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);
});
