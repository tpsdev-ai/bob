// bob#185 item 5 — the ASSEMBLED pi prompt. Builds a REAL pi session through
// bob's factory and reads the system prompt pi assembled from the loader's
// append sources. The recalled block must sit after soul.md.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { prMemoryKey } from "../../src/shell/pr-memory.js";
import { attachPrMemory, type RunSessionConfig, resolveRunConfig } from "../../src/shell/run.js";
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

async function assembledSystemPrompt(prMemory?: string, web = false): Promise<string> {
  const runtime = await stubRuntime();
  const config: RunSessionConfig = {
    ...resolveRunConfig({ name: "testbot", agentsRoot }).config,
    provider: STUB_PROVIDER,
    providerRecord: undefined,
    model: STUB_MODEL,
    modelLimits: { provider: STUB_PROVIDER, model: STUB_MODEL, contextWindow: 200_000 },
    extensionSources: [],
    tools: web ? [] : ["read"],
    appendSystemPrompt: web ? "" : SOUL_SENTINEL,
    ...(prMemory !== undefined ? { prMemory } : {}),
  };
  if (web) {
    const source = fileURLToPath(new URL("../../src/capabilities/web/index.ts", import.meta.url));
    config.extensionSources = [source];
    config.capabilityBySource = { [source]: "web" };
    config.capabilityEnv = { BOB_CAP_WEB: "{}" };
    let reads = 0;
    config.taskBinding = {
      task_id: "t1",
      publication_id: "p1",
      repository: "github.com/tpsdev-ai/bob",
      workspace: cwd,
      base_oid: "a".repeat(40),
      mode: "build",
      artifact_root: cwd,
      declared_paths: [],
      check_commands: [],
      destination: { remote: "origin", ref: "refs/heads/main" },
      pr_ref: { repository: "github.com/tpsdev-ai/bob", number: 185 },
    };
    await attachPrMemory(
      config,
      { url: "http://flair.test", agentId: "testbot", keyFile: "/unused", maxTokens: 2000 },
      {
        readFile: () => Buffer.alloc(32, 7),
        fetchImpl: async () => {
          reads++;
          return new Response(
            JSON.stringify({
              id: prMemoryKey("testbot", "github.com/tpsdev-ai/bob", 185),
              agentId: "testbot",
              visibility: "private",
              content: JSON.stringify({
                v: 1,
                agentId: "testbot",
                repository: "github.com/tpsdev-ai/bob",
                prNumber: 185,
                open_findings: [],
                omitted: [],
                rounds: [
                  {
                    endedAt: "now",
                    outcome: "completed",
                    blockers_addressed: [],
                    files_touched: [MEM_SENTINEL],
                    test_evidence: [],
                    incomplete: [],
                    omitted: [],
                  },
                ],
              }),
            }),
          );
        },
      },
    );
    expect(reads).toBe(0);
    expect(config.prMemory).toBeUndefined();
  }
  const factory = createBobRuntimeFactory({
    config,
    policy: { tools: config.tools, excludeTools: [], resident: false, allowResidentShell: false },
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

it("starts a web-configured pi session without PR-memory recall", async () => {
  const prompt = await assembledSystemPrompt(undefined, true);
  expect(prompt).toContain("You are an assistant in a web session.");
  expect(prompt).not.toContain("Prior-round memory");
  expect(prompt).not.toContain("BOB-PR-MEMORY");
  expect(prompt).not.toContain(MEM_SENTINEL);
});
