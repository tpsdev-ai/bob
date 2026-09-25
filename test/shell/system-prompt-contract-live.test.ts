// The #145 guarantee at the REQUEST boundary, against a REAL pi session.
//
// The unit tests pin the pieces; this file stands up pi's own session (through
// bob's ONE factory) with a STUB model and proves the claims that only a real
// session can prove:
//
//   1. the contract is in the SYSTEM PROMPT of every agent request — including
//      the request after a real pi compaction, which rewrites the message
//      history and nothing else;
//   2. a capability that takes the contract away — by replacing the prompt in
//      `before_agent_start`, or by rewriting the outgoing provider payload in
//      `before_provider_request` — fails the turn exactly like a failed audit
//      (the session is disposed, the process is ended, the reason is named);
//   3. pi's own summarization request is EXEMPT — and it is exempt because pi
//      is compacting (`AgentSession.isCompacting`), never because of text in
//      the payload: pasting pi's prompt into an agent request is refused
//      (round 2's defect), while the same text on pi's own compaction request
//      passes;
//   4. the block is there for a session REPLACED through the runtime factory
//      (pi's /new path) and for the PERSISTENT runtime's standing contract
//      after a compaction — the two paths a resident agent actually takes;
//      overflow recovery and a reload remain follow-ups (named in the report).
//
// The stub provider is bob's own: it builds an Anthropic-shaped payload, calls
// `options.onPayload` like every real provider API does (the compaction summary
// request included), records what the guard would see, and then streams a
// scripted assistant message. A provider that skips `onPayload` would never
// reach `before_provider_request` at all — which is exactly why the guard lives
// there and why this stub calls it.

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
import {
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { startPersistent } from "../../src/shell/persistent.js";
import type { RunSession, RunSessionConfig, RunSessionFactory } from "../../src/shell/run.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

/** pi's own summarization system prompt, VERBATIM (pi 0.84.3,
 *  core/compaction/utils.js `SUMMARIZATION_SYSTEM_PROMPT`; pi does not export
 *  it). The stub uses it to label pi's summarization requests — and the guard
 *  must NOT key on it (round 2's borrowable exemption): it keys on
 *  `AgentSession.isCompacting`. */
const PI_SUMMARIZATION_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

const STUB_PROVIDER = "bob-stub";
const STUB_MODEL = "stub-1";

interface RecordedRequest {
  call: number;
  /** The system prompt pi handed the provider (the context). */
  contextSystemPrompt: string;
  /** The system prompt in the FINAL payload, after every extension handler. */
  payloadSystemPrompt: string;
  /** True when this was pi's own summarization call. */
  summarization: boolean;
  /** True when the request carried the agent turn's `onPayload` — the seam pi
   *  routes to `before_provider_request`. */
  onPayload: boolean;
}

/** Every request the stub provider saw, in order. */
let requests: RecordedRequest[] = [];

/** The system prompt text of a payload, read the same way for every shape. */
function payloadSystemText(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as { system?: unknown; messages?: unknown };
  const system = record.system;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof (entry as { text?: unknown })?.text === "string"
            ? ((entry as { text: string }).text as string)
            : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * A stub provider that behaves like a real API client: it builds a payload,
 * awaits `onPayload` (so `before_provider_request` runs, guard included), and
 * streams one assistant message. `scripted(call)` decides the reply text.
 */
function stubProvider(scripted: (call: number, systemPrompt: string) => string) {
  const state = { callCount: 0 };
  const streamSimple = (
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const call = state.callCount + 1;
    state.callCount = call;
    queueMicrotask(async () => {
      const contextSystemPrompt = context.systemPrompt ?? "";
      let payload: Record<string, unknown> = {
        model: model.id,
        system: [{ type: "text", text: contextSystemPrompt }],
        messages: context.messages,
      };
      try {
        // Every real provider API calls this hook (pi-ai 0.84.3: anthropic,
        // openai, google, bedrock …), and pi routes it to
        // before_provider_request. It is the seam the guard exists for.
        const next = await options?.onPayload?.(payload, model);
        if (next !== undefined) payload = next as Record<string, unknown>;
        const payloadSystemPrompt = payloadSystemText(payload);
        const summarization = payloadSystemPrompt.includes(PI_SUMMARIZATION_PROMPT);
        requests.push({
          call,
          contextSystemPrompt,
          payloadSystemPrompt,
          summarization,
          onPayload: typeof options?.onPayload === "function",
        });
        const text = summarization
          ? "Summary: the conversation so far, condensed."
          : scripted(call, contextSystemPrompt);
        const message = {
          role: "assistant" as const,
          content: text.length > 0 ? [{ type: "text" as const, text }] : [],
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
      } catch (err) {
        const message = {
          role: "assistant" as const,
          content: [],
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
          stopReason: "error" as const,
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: message as never });
        stream.end(message as never);
      }
    });
    return stream;
  };
  return { state, streamSimple };
}

let root: string;
let agentsRoot: string;
let agentDir: string;
let cwd: string;
let piAgentDir: string;
let extDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-contract-live-"));
  agentsRoot = join(root, "agents");
  extDir = mkdtempSync(join(tmpdir(), "bob-contract-ext-"));
  requests = [];
  const res = initAgent({
    name: "testbot",
    role: "ea",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    agentsRoot,
    flairKeysDir: join(root, ".flair", "keys"),
    skipFlair: true,
  });
  agentDir = res.agentDir;
  cwd = join(agentDir, "work");
  piAgentDir = join(agentDir, ".pi-agent");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
});

async function stubRuntime(contextWindow = 200_000) {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  const stub = stubProvider((call) => (call === 1 ? "first turn done" : "later turn done"));
  runtime.registerProvider(STUB_PROVIDER, {
    name: "Bob Stub",
    apiKey: "stub-key",
    api: "bob-stub-api",
    baseUrl: "http://localhost:0",
    streamSimple: stub.streamSimple,
    models: [
      {
        id: STUB_MODEL,
        name: "Stub",
        api: "bob-stub-api",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 4096,
      },
    ],
  });
  return { runtime, stub };
}

/** The stub runtime + bob's ONE factory for a test config, so a test can build
 *  a session directly, through pi's RUNTIME (a replaced session), or through
 *  the PERSISTENT runtime — the paths a resident agent actually takes. */
async function bobFactoryFor(opts: {
  /** A capability extension source written to disk (order: before the guard). */
  capabilityText?: string;
  contextWindow?: number;
  taskContract?: string;
  standingContract?: string;
  contractCapChars?: number;
  /** A config resolved elsewhere (the persistent runtime resolves its own and
   *  sets the standing contract before it calls its factory). */
  fromConfig?: RunSessionConfig;
}) {
  const { runtime, stub } = await stubRuntime(opts.contextWindow);
  const extensionSources: string[] = [];
  if (opts.capabilityText !== undefined) {
    const extPath = join(extDir, `cap-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(extPath, opts.capabilityText);
    extensionSources.push(extPath);
  }
  const base = opts.fromConfig ?? resolveRunConfig({ name: "testbot", agentsRoot }).config;
  const logs: string[] = [];
  const exits: number[] = [];
  const factory = createBobRuntimeFactory({
    config: {
      ...base,
      provider: STUB_PROVIDER,
      model: STUB_MODEL,
      extensionSources,
      ...(opts.taskContract !== undefined ? { taskContract: opts.taskContract } : {}),
      ...(opts.standingContract !== undefined ? { standingContract: opts.standingContract } : {}),
      ...(opts.contractCapChars !== undefined ? { contractCapChars: opts.contractCapChars } : {}),
    },
    // The test agent declares the flair capability; this session loads none, so
    // the effective policy is only what pi itself provides (the audit would
    // otherwise refuse the session for the missing capability tools).
    policy: { tools: ["read"], excludeTools: [], resident: false, allowResidentShell: false },
    deps: { log: (m) => logs.push(m), exit: (code) => exits.push(code) },
    modelRuntime: runtime,
  });
  return { factory, logs, exits, stub };
}

type LiveSession = RunSession & {
  prompt(text: string, options?: unknown): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
};

/** Build a REAL pi session through bob's factory, with the stub model. */
async function contractSession(opts: {
  /** A capability extension source written to disk (order: before the guard). */
  capabilityText?: string;
  contextWindow?: number;
  taskContract?: string;
  standingContract?: string;
  contractCapChars?: number;
}) {
  const { factory, logs, exits, stub } = await bobFactoryFor(opts);
  const result = await factory({
    cwd,
    agentDir: piAgentDir,
    sessionManager: SessionManager.inMemory(cwd) as never,
  });
  const session = result.session as unknown as LiveSession;
  let disposals = 0;
  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    disposals += 1;
    dispose();
  };
  return {
    session,
    loader: result.services.resourceLoader,
    logs,
    exits,
    disposals: () => disposals,
    stub,
  };
}

// A marker at the very START of the task: pi's compaction keeps the RECENT part
// of the history and summarizes the rest, so this is the text that is actually
// dropped. It survives in the system prompt (the contract block is capped at its
// head), which is the whole shape change.
const HEAD_MARKER = "bob-contract-head-marker-9c1f";
// Enough content that pi has something to compact: it keeps the recent
// `keepRecentTokens` (20000) and summarizes what came before, so the history
// must be larger than that — three turns of ~40k chars ≈ 30k tokens. Only the
// FIRST turn carries the head marker: it is the content the compaction drops.
const headTask = () => `${HEAD_MARKER} ${"w".repeat(40_000)}`;
const laterTask = (n: number) => `turn ${n} ${"v".repeat(40_000)}`;
const runThreeTurns = async (session: { prompt(text: string): Promise<void> }) => {
  await session.prompt(headTask());
  await session.prompt(laterTask(2));
  await session.prompt(laterTask(3));
};

describe("#145 — the contract survives a real pi compaction (stub model)", () => {
  it("carries the TASK in the system prompt of an agent request after a real compaction (pi's own threshold path, MID-TURN)", async () => {
    // A context window whose threshold (window − reserveTokens 16384) is crossed
    // by the third turn's content, so pi compacts during that turn.
    const live = await contractSession({ taskContract: headTask(), contextWindow: 40_000 });
    try {
      const compactions: number[] = [];
      live.session.subscribe((event) => {
        const e = event as { type?: string; aborted?: boolean };
        if (e.type === "compaction_end" && !e.aborted) compactions.push(1);
      });

      await runThreeTurns(live.session);
      expect(compactions.length, "pi compacted during the turn").toBeGreaterThanOrEqual(1);

      // The task text is in every AGENT request's system prompt — the requests
      // made after the compaction included.
      const after = requests.filter((r) => !r.summarization && r.call > 1);
      expect(after.length, "the post-compaction request(s)").toBeGreaterThanOrEqual(1);
      for (const request of requests.filter((r) => !r.summarization)) {
        expect(request.payloadSystemPrompt).toContain("TASK");
        expect(request.contextSystemPrompt).toContain(HEAD_MARKER);
        // Agent requests are the ones the guard checks: they carry the seam.
        expect(request.onPayload, "an agent request carries the guard's seam").toBe(true);
      }

      // And the proof it is the SYSTEM PROMPT carrying it: compaction removed
      // the head of the task from the message history, and the (post-compaction)
      // requests still carry it.
      const messages = (live.session as unknown as { messages?: ReadonlyArray<unknown> }).messages;
      expect(JSON.stringify(messages ?? [])).not.toContain(HEAD_MARKER);
      expect(
        (live.session as unknown as { messages?: ReadonlyArray<unknown> }).messages?.length,
      ).toBeGreaterThan(0);
    } finally {
      live.session.dispose();
    }
  });

  it("appends the contract as LITERAL text through the loader override — never as a path source", async () => {
    // The contract text IS an existing file path. If the block were handed to pi
    // as an `appendSystemPrompt` SOURCE, pi would read that FILE
    // (core/resource-loader.js `resolvePromptInput`) and the session would
    // carry the file's contents instead of the task. The override runs after pi
    // has turned its sources into text, so the path stays a path.
    const filePath = join(agentDir, "soul.md");
    const fileContents = "SOUL FILE CONTENT THAT MUST NOT BECOME THE CONTRACT";
    writeFileSync(filePath, fileContents);
    const live = await contractSession({ taskContract: filePath });
    try {
      const entries = live.loader.getAppendSystemPrompt();
      // The override appends the contract LAST; that entry must be the literal
      // path text, not the file's contents. (The agent's own append source —
      // its soul — is untouched and still comes first.)
      const contractEntry = entries.at(-1) ?? "";
      expect(contractEntry).toContain(filePath);
      expect(contractEntry).not.toContain(fileContents);
      // And pi recorded NO append-system-prompt SOURCE at all: the contract is
      // text, so there is nothing on disk for a reload to re-read.
      const sources =
        (live.loader as unknown as { appendSystemPromptSourcePaths?: string[] })
          .appendSystemPromptSourcePaths ?? [];
      expect(sources).toEqual([]);
    } finally {
      live.session.dispose();
    }
  });

  it("carries the STANDING CONTRACT (persistent) in the system prompt of every agent request", async () => {
    const STANDING = "You are testbot, on duty as ea. Standing duties: sweep the inbox.";
    const live = await contractSession({ standingContract: STANDING });
    try {
      await live.session.prompt("a discord message arrives");
      expect(requests.length).toBeGreaterThanOrEqual(1);
      for (const request of requests) {
        expect(request.payloadSystemPrompt).toContain("on duty as ea");
        expect(request.payloadSystemPrompt).toContain("sweep the inbox");
      }
    } finally {
      live.session.dispose();
    }
  });

  it("carries it across a MANUAL pi compaction too, and on the request after it", async () => {
    const live = await contractSession({ taskContract: headTask() });
    try {
      await runThreeTurns(live.session);
      const beforeManual = requests.length;

      // pi's manual compaction entry point (/compact, RPC, extensions). Real
      // pi machinery, the same summarization model, the same history rewrite.
      const session = live.session as unknown as { compact(): Promise<void> };
      await session.compact();

      await live.session.prompt("continue");
      const after = requests.slice(beforeManual).filter((r) => !r.summarization);
      expect(after.length, "the post-compaction turn made a request").toBeGreaterThanOrEqual(1);
      for (const request of after) expect(request.payloadSystemPrompt).toContain("TASK");
      expect(
        JSON.stringify((live.session as unknown as { messages?: unknown }).messages ?? {}),
      ).not.toContain(HEAD_MARKER);
    } finally {
      live.session.dispose();
    }
  });
});

describe("#145 — the guard fails a turn whose request lost the contract", () => {
  it("fails when a capability REPLACES the prompt in before_agent_start", async () => {
    const live = await contractSession({
      taskContract: "the one-shot task",
      capabilityText: `export default function (pi) {
  pi.on("before_agent_start", () => ({ systemPrompt: "a capability replaced the whole prompt" }));
}
`,
    });
    try {
      await live.session.prompt("do the task").catch(() => {});
      expect(live.disposals(), "the session is disposed").toBeGreaterThanOrEqual(1);
      expect(live.exits, "the process is ended").toEqual([1]);
      expect(live.logs.join("\n")).toContain("contract_missing_from_system_prompt");
    } finally {
      live.session.dispose();
    }
  });

  it("fails when a capability REWRITES the outgoing provider payload in before_provider_request", async () => {
    const live = await contractSession({
      taskContract: "the one-shot task",
      capabilityText: `export default function (pi) {
  pi.on("before_provider_request", (event) => ({
    ...event.payload,
    system: [{ type: "text", text: "a capability rewrote the payload" }],
  }));
}
`,
    });
    try {
      await live.session.prompt("do the task").catch(() => {});
      expect(live.disposals(), "the session is disposed").toBeGreaterThanOrEqual(1);
      expect(live.exits, "the process is ended").toEqual([1]);
      expect(live.logs.join("\n")).toContain("contract_missing_from_system_prompt");
    } finally {
      live.session.dispose();
    }
  });

  it("fails a capability that pastes pi's OWN summarization prompt where the contract should be", async () => {
    // Round 2's defect, live: the exemption used to be keyed on text IN THE
    // PROMPT, so a capability could paste pi's summarization prompt in and drop
    // the contract. The exemption is pi's compaction flag now, and a capability
    // cannot make pi compact — so this request is refused.
    const live = await contractSession({
      taskContract: "the one-shot task",
      capabilityText: `export default function (pi) {
  pi.on("before_agent_start", () => ({ systemPrompt: ${JSON.stringify(PI_SUMMARIZATION_PROMPT)} }));
}
`,
    });
    try {
      await live.session.prompt("do the task").catch(() => {});
      expect(live.disposals(), "the session is disposed").toBeGreaterThanOrEqual(1);
      expect(live.exits, "the process is ended").toEqual([1]);
      expect(live.logs.join("\n")).toContain("contract_missing_from_system_prompt");
    } finally {
      live.session.dispose();
    }
  });

  it("never refuses pi's own summarization request — it is exempt while PI IS COMPACTING", async () => {
    const live = await contractSession({ taskContract: headTask() });
    try {
      await runThreeTurns(live.session);
      const session = live.session as unknown as { compact(): Promise<void> };
      await session.compact();
      const summarization = requests.filter((r) => r.summarization);
      expect(summarization.length, "pi made its summarization request").toBeGreaterThanOrEqual(1);
      for (const request of summarization) {
        // It carries pi's summarization prompt and NOT the contract.
        expect(request.payloadSystemPrompt).toContain(PI_SUMMARIZATION_PROMPT);
        expect(request.payloadSystemPrompt).not.toContain("[BOB TASK");
        // And in pi 0.84.3 it does not even reach the guard: the agent turn's
        // `onPayload` (which pi routes to before_provider_request) is attached
        // to the agent's OWN requests, while pi's summarization call hands the
        // stream function its own options. Pinned, because the day pi attaches
        // the hook here too, the exemption below becomes load-bearing instead of
        // insurance — see the guard's `compacting` flag.
        expect(request.onPayload, "pi's summary call carries no onPayload").toBe(false);
      }
      // Nothing refused them: no dispose, no exit.
      expect(live.exits).toEqual([]);
      expect(live.disposals()).toBe(0);
    } finally {
      live.session.dispose();
    }
  });
});

describe("#145 — the contract survives the paths a resident agent takes", () => {
  it("carries the TASK in a session REPLACED through the runtime factory (pi's /new path)", async () => {
    const { factory, exits } = await bobFactoryFor({ taskContract: "the one-shot task" });
    // pi's own runtime, built from bob's ONE factory: newSession() tears the
    // current session down and asks the factory for the next one, which is how
    // /new, /resume, /fork, /clone and /import all work.
    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(cwd) as never,
    });
    try {
      await (runtime.session as unknown as LiveSession).prompt("first turn");
      const before = requests.filter((request) => !request.summarization).length;
      expect(before, "the first session made a request").toBeGreaterThanOrEqual(1);

      await runtime.newSession();
      const replaced = runtime.session as unknown as LiveSession;
      await replaced.prompt("a turn in the replaced session");

      const after = requests.filter((request) => !request.summarization);
      expect(after.length, "the replaced session made a request").toBeGreaterThan(before);
      for (const request of after) {
        expect(request.payloadSystemPrompt).toContain("TASK");
        expect(request.payloadSystemPrompt).toContain("the one-shot task");
      }
      expect(exits, "no guard failure").toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("carries the STANDING CONTRACT after a real compaction in the PERSISTENT runtime", async () => {
    let exits: number[] = [];
    const sessionFactory: RunSessionFactory = async (config) => {
      // The SAME factory every path uses; the standing contract is already in
      // the config the persistent runtime resolved (persistent.ts).
      const built = await bobFactoryFor({ fromConfig: config, contextWindow: 40_000 });
      exits = built.exits;
      const result = await built.factory({
        cwd: config.cwd,
        agentDir: config.piAgentDir,
        sessionManager: SessionManager.inMemory(config.cwd) as never,
      });
      return result.session as unknown as RunSession;
    };
    const handle = await startPersistent({
      name: "testbot",
      agentsRoot,
      installSignalHandlers: false,
      keepAlive: async () => {},
      log: () => {},
      sessionFactory,
    });
    try {
      const compactions: number[] = [];
      handle.session.subscribe((event) => {
        const e = event as { type?: string; aborted?: boolean };
        if (e.type === "compaction_end" && !e.aborted) compactions.push(1);
      });

      let callsBefore = 0;
      handle.session.subscribe((event) => {
        const e = event as { type?: string; aborted?: boolean };
        if (e.type === "compaction_end" && !e.aborted && callsBefore === 0) {
          callsBefore = requests.length;
        }
      });
      await runThreeTurns(handle.session);
      expect(
        compactions.length,
        "pi compacted inside the persistent runtime",
      ).toBeGreaterThanOrEqual(1);
      expect(callsBefore, "the compaction happened after a first request").toBeGreaterThan(0);

      const agentRequests = requests.filter((request) => !request.summarization);
      expect(agentRequests.length, "the persistent runtime made requests").toBeGreaterThanOrEqual(
        2,
      );
      // Not merely "a request carried it": the requests made AFTER the
      // compaction did — the ones that would lose a message-history task.
      const afterCompaction = agentRequests.filter((request) => request.call > callsBefore);
      expect(
        afterCompaction.length,
        "a request was made after the compaction",
      ).toBeGreaterThanOrEqual(1);
      for (const request of agentRequests) {
        expect(request.payloadSystemPrompt).toContain("STANDING CONTRACT");
        expect(request.payloadSystemPrompt).toContain("on duty as ea");
      }
      // It is the SYSTEM PROMPT carrying it, not the history: the standing
      // contract never appears in the message list at all.
      const messages = (handle.session as unknown as { messages?: unknown }).messages;
      expect(JSON.stringify(messages ?? {})).not.toContain("STANDING CONTRACT");
      expect(exits, "no guard failure on pi's summarization request").toEqual([]);
    } finally {
      await handle.shutdown();
    }
  });
});
