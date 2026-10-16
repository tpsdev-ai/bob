// The web_fetch tool on a REAL pi session, through bob's ONE session factory,
// with the REAL turn admission and pi's real lifecycle and tool-parameter
// validator (bob#152, spec v3, slice R1c; round 2). Only the model transport
// and the network fetch are scripted: the session, the admission, the extension
// wiring (`wireWebCapability`), tool registration, argument validation and the
// agent loop are the ones production uses. No event is hand-fired and no
// `readOrigin` is faked.
//
// It covers: a bare prompt outside any admission (refused), an admitted call
// (allowed), bob's automatic continuation (provenance and spend survive),
// settlement (the state does not carry to a later prompt), and an invalid tool
// argument (refused by pi's validator before execution).

import { expect, test } from "bun:test";
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
import { wireWebCapability } from "../../src/capabilities/web/capability.js";
import { resolveWebSettings } from "../../src/capabilities/web/core.js";
import type { FetchResult } from "../../src/capabilities/web/fetch.js";
import type { RunSessionConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";
import { createTurnAdmission, getTurnAdmission } from "../../src/shell/turn-admission.js";

const STUB_PROVIDER = "bob-web-stub";
const STUB_MODEL = "stub-1";

type Step =
  | { tool: string; args: Record<string, unknown> }
  | { text: string }
  | { thinking: string };

interface ToolOutcome {
  tool: string;
  isError: boolean;
  text: string;
}

function stubStream(steps: Step[], calls: Step[]) {
  let index = 0;
  return (model: Model<string>, _context: Context): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const step: Step = steps[index] ?? { text: "done" };
      index += 1;
      calls.push(step);
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
              id: `call-${index}`,
              name: (step as { tool: string }).tool,
              arguments: (step as { args: Record<string, unknown> }).args,
            },
          ]
        : "thinking" in step
          ? [{ type: "thinking" as const, thinking: (step as { thinking: string }).thinking }]
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

interface Live {
  runtime: AgentSessionRuntime;
  admission: ReturnType<typeof createTurnAdmission>;
  fetched: string[];
  results: ToolOutcome[];
  calls: Step[];
  cleanup: () => Promise<void>;
}

const WIRE_HOOK = "__bobWebSessionTestWire";

async function webSession(steps: Step[]): Promise<Live> {
  const scratch = mkdtempSync(join(tmpdir(), "bob-web-session-"));
  const cwd = join(scratch, "workspace");
  const piAgentDir = join(scratch, "pi-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(piAgentDir, { recursive: true });
  const probePath = join(scratch, "web-probe.js");
  writeFileSync(
    probePath,
    "export default async function (pi) { await globalThis.__bobWebSessionTestWire(pi); }\n",
  );
  const fetched: string[] = [];
  const calls: Step[] = [];
  const admission = createTurnAdmission({ log: () => {} });
  const hook = globalThis as unknown as Record<string, unknown>;
  hook[WIRE_HOOK] = (pi: unknown) => {
    const service = getTurnAdmission(pi as { events: { emit: unknown } });
    if (!service) throw new Error("the web session has no admission service");
    wireWebCapability({
      pi: pi as never,
      settings: resolveWebSettings({}),
      admission: service,
      fetch: async (url): Promise<FetchResult> => {
        fetched.push(url);
        return {
          finalUrl: url,
          status: 200,
          contentType: "text/plain",
          text: "page body",
          truncated: false,
          links: [],
        };
      },
    });
  };

  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerProvider(STUB_PROVIDER, {
    name: "Bob Web Stub",
    apiKey: "stub-key",
    api: "bob-web-stub-api",
    baseUrl: "http://localhost:0",
    streamSimple: stubStream(steps, calls),
    models: [
      {
        id: STUB_MODEL,
        name: "Stub",
        api: "bob-web-stub-api",
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
    modelLimits: { provider: STUB_PROVIDER, model: STUB_MODEL, contextWindow: 200_000 },
    appendSystemPrompt: "",
    cwd,
    piAgentDir,
    extensionSources: [probePath],
    capabilityBySource: { [probePath]: "web" },
    capabilityEnv: {},
    tools: ["web_fetch"],
    excludeTools: [],
    turnAdmission: admission,
  };
  const factory = createBobRuntimeFactory({
    config,
    policy: {
      tools: ["web_fetch"],
      excludeTools: [],
      resident: false,
      allowResidentShell: false,
    },
    deps: { log: () => {}, exit: () => {} },
    modelRuntime,
  });
  let runtime: AgentSessionRuntime;
  try {
    runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });
    admission.bind(runtime.session as never);
    hook[WIRE_HOOK] = undefined;
  } catch (err) {
    delete hook[WIRE_HOOK];
    rmSync(scratch, { recursive: true, force: true });
    throw err;
  }
  const results: ToolOutcome[] = [];
  runtime.session.subscribe((event: unknown) => {
    const e = event as {
      type?: string;
      toolName?: string;
      isError?: boolean;
      result?: { content?: Array<{ text?: string }> };
    };
    if (e.type !== "tool_execution_end") return;
    results.push({
      tool: String(e.toolName),
      isError: e.isError === true,
      text: (e.result?.content ?? []).map((c) => c.text ?? "").join("\n"),
    });
  });
  return {
    runtime,
    admission,
    fetched,
    results,
    calls,
    cleanup: async () => {
      try {
        await runtime.dispose();
      } catch {
        // already disposed
      }
      delete hook[WIRE_HOOK];
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

test("a bare prompt outside any admission cannot fetch: refused with no-admission", async () => {
  const live = await webSession([
    { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
    { text: "done" },
  ]);
  try {
    await live.runtime.session.prompt("read https://host-a.test/x", {
      expandPromptTemplates: false,
    });
    expect(live.results).toHaveLength(1);
    expect(live.results[0].tool).toBe("web_fetch");
    expect(live.results[0].isError).toBe(true);
    expect(live.results[0].text).toContain("no-admission");
    expect(live.fetched).toEqual([]);
  } finally {
    await live.cleanup();
  }
});

test("an admitted call fetches a URL recorded from the admitted prompt", async () => {
  const live = await webSession([
    { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
    { text: "done" },
  ]);
  try {
    await live.admission.admitTurn({ kind: "cron", job: "brief" }, "read https://host-a.test/x");
    expect(live.results).toHaveLength(1);
    expect(live.results[0].isError).toBe(false);
    expect(live.fetched).toEqual(["https://host-a.test/x"]);
  } finally {
    await live.cleanup();
  }
});

test("provenance and spend survive bob's automatic continuation (reasoning-only re-prompt)", async () => {
  const live = await webSession([
    // 1. reasoning-only ending: bob re-prompts the SAME admission.
    { thinking: "let me consider" },
    // 2. the tool call, carrying a URL only the FIRST prompt recorded.
    { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
    { text: "done" },
  ]);
  try {
    await live.admission.admitTurn({ kind: "cron", job: "brief" }, "read https://host-a.test/x");
    // The continuation prompt carries no URL, so a re-seeded state would refuse
    // this fetch; it succeeds only because the first prompt's state survived.
    expect(live.calls.length).toBe(3);
    expect(live.results).toHaveLength(1);
    expect(live.results[0].isError).toBe(false);
    expect(live.fetched).toEqual(["https://host-a.test/x"]);
  } finally {
    await live.cleanup();
  }
});

test("settlement ends the operation: a later bare prompt carries no state", async () => {
  const live = await webSession([
    { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
    { text: "done" },
    // The bare prompt's call (same URL) must be refused: the admitted
    // operation's state did not carry past its settlement.
    { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
    { text: "done" },
  ]);
  try {
    await live.admission.admitTurn({ kind: "cron", job: "brief" }, "read https://host-a.test/x");
    expect(live.results[0].isError).toBe(false);
    await live.runtime.session.prompt("again https://host-a.test/x", {
      expandPromptTemplates: false,
    });
    expect(live.results).toHaveLength(2);
    expect(live.results[1].isError).toBe(true);
    expect(live.results[1].text).toContain("no-admission");
  } finally {
    await live.cleanup();
  }
});

test("an invalid tool argument is refused by pi's validator before the fetch", async () => {
  const live = await webSession([
    { tool: "web_fetch", args: { url: "https://host-a.test/x", maxChars: 0 } },
    { text: "done" },
  ]);
  try {
    await live.admission.admitTurn({ kind: "cron", job: "brief" }, "read https://host-a.test/x");
    expect(live.results).toHaveLength(1);
    expect(live.results[0].isError).toBe(true);
    expect(live.fetched).toEqual([]);
  } finally {
    await live.cleanup();
  }
});
