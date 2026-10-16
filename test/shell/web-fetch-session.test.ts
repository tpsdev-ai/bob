// The web_fetch tool through bob's session factory, real turn admission,
// pi lifecycle and tool-parameter validator, with a synthetic extension
// entrypoint, scripted model transport and injected fetch.

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

async function webSession(
  steps: Step[],
  web: Parameters<typeof resolveWebSettings>[0] = {},
): Promise<Live> {
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
      settings: resolveWebSettings(web),
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

test("provenance survives bob's automatic continuation (reasoning-only re-prompt)", async () => {
  const live = await webSession([
    // 1. a tool call spends both budgets; the admission seed recorded the URL.
    { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
    // 2. reasoning-only ending: bob re-prompts the SAME admission.
    { thinking: "let me consider" },
    // 3. the continuation's tool call, carrying a URL only the FIRST prompt
    //    recorded.
    { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
    { text: "done" },
  ]);
  try {
    await live.admission.admitTurn({ kind: "cron", job: "brief" }, "read https://host-a.test/x");
    // The continuation prompt carries no URL, so a re-seeded state would refuse
    // the second fetch; it succeeds only because the first prompt's state
    // survived the continuation.
    expect(live.results).toHaveLength(2);
    expect(live.results.map((r) => r.isError)).toEqual([false, false]);
    expect(live.fetched).toEqual(["https://host-a.test/x", "https://host-a.test/x"]);
  } finally {
    await live.cleanup();
  }
});

test("the fetch-attempt budget does not replenish across a continuation", async () => {
  const live = await webSession(
    [
      { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
      { thinking: "let me consider" },
      { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
      { text: "done" },
    ],
    { fetch_per_turn: 1 },
  );
  try {
    await live.admission.admitTurn({ kind: "cron", job: "brief" }, "read https://host-a.test/x");
    // The first prompt spent the single attempt; the continuation's call must
    // be refused for the spent budget, not served by a replenished one.
    expect(live.results).toHaveLength(2);
    expect(live.results[0].isError).toBe(false);
    expect(live.results[1].isError).toBe(true);
    expect(live.results[1].text).toContain("budget-fetch");
    expect(live.fetched).toEqual(["https://host-a.test/x"]);
  } finally {
    await live.cleanup();
  }
});

test("the text allowance does not replenish across a continuation", async () => {
  const live = await webSession(
    [
      { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
      { thinking: "let me consider" },
      { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
      { text: "done" },
    ],
    { text_per_turn: "page body".length },
  );
  try {
    await live.admission.admitTurn({ kind: "cron", job: "brief" }, "read https://host-a.test/x");
    // The first prompt's fetch returned the whole allowance; the continuation's
    // call must find none left.
    expect(live.results).toHaveLength(2);
    expect(live.results[0].isError).toBe(false);
    expect(live.results[1].isError).toBe(true);
    expect(live.results[1].text).toContain("budget-text");
    expect(live.fetched).toEqual(["https://host-a.test/x"]);
  } finally {
    await live.cleanup();
  }
});

test("settlement ends the operation: a later bare prompt carries no state", async () => {
  const live = await webSession([
    { tool: "web_fetch", args: { url: "https://host-a.test/x" } },
    { text: "done" },
    // The bare prompt's call is refused. This prompt runs outside any admission
    // AND after the admitted operation SETTLED (its token revoked), so the
    // settled operation's state is not exposed to it — a distinction the
    // captured-context cases in web-extension.test.ts pin without a new prompt.
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
