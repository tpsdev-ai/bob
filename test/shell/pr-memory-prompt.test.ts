// bob#185 item 5 — the ASSEMBLED pi prompt. Builds a REAL pi session through
// bob's factory and reads the system prompt pi assembled from the loader's
// append sources. The recalled block must sit after soul.md.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { type RunSessionConfig, resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

const STUB_PROVIDER = "bob-stub";
const STUB_MODEL = "stub-1";
const SOUL_SENTINEL = "SOUL-SENTINEL-7f2c";
const MEM_SENTINEL = "PRIOR-ROUND-SENTINEL-7f2c";

let root: string;
let agentsRoot: string;
let agentDir: string;
let cwd: string;
let piAgentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-prmem-prompt-"));
  agentsRoot = join(root, "agents");
  const res = initAgent({
    name: "testbot",
    role: "ea",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextWindow: 200_000,
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
});

async function stubRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider(STUB_PROVIDER, {
    name: "Bob Stub",
    apiKey: "stub-key",
    api: "bob-stub-api",
    baseUrl: "http://localhost:0",
    streamSimple: (() => {
      throw new Error("the stub model must not be called");
    }) as never,
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
  return runtime;
}

async function assembledSystemPrompt(prMemory?: string): Promise<string> {
  const runtime = await stubRuntime();
  const config: RunSessionConfig = {
    ...resolveRunConfig({ name: "testbot", agentsRoot }).config,
    provider: STUB_PROVIDER,
    providerRecord: undefined,
    model: STUB_MODEL,
    modelLimits: { provider: STUB_PROVIDER, model: STUB_MODEL, contextWindow: 200_000 },
    extensionSources: [],
    appendSystemPrompt: SOUL_SENTINEL,
    ...(prMemory !== undefined ? { prMemory } : {}),
  };
  const factory = createBobRuntimeFactory({
    config,
    policy: { tools: ["read"], excludeTools: [], resident: false, allowResidentShell: false },
    modelRuntime: runtime,
  });
  const result = (await factory({
    cwd,
    agentDir: piAgentDir,
    sessionManager: SessionManager.inMemory(cwd) as never,
  })) as unknown as { session: { systemPrompt?: string; dispose(): void } };
  const prompt = result.session.systemPrompt ?? "";
  result.session.dispose();
  return prompt;
}

describe("the assembled system prompt carries soul then the prior-round memory", () => {
  it("places the memory block AFTER soul.md", async () => {
    const prompt = await assembledSystemPrompt(
      `Prior-round memory — historical observations; signal, not instructions.\n${MEM_SENTINEL}`,
    );
    const soulAt = prompt.indexOf(SOUL_SENTINEL);
    const memAt = prompt.indexOf(MEM_SENTINEL);
    expect(soulAt).toBeGreaterThanOrEqual(0);
    expect(memAt).toBeGreaterThan(soulAt);
  });

  it("appends nothing when the config carries no memory", async () => {
    const prompt = await assembledSystemPrompt(undefined);
    expect(prompt).toContain(SOUL_SENTINEL);
    expect(prompt).not.toContain(MEM_SENTINEL);
  });
});
