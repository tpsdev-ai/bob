// bob#254 — the ASSEMBLED pi prompt. The entry-path tests inspect the config
// bob resolves; this builds a REAL pi session through bob's ONE factory and
// reads the system prompt pi assembled from the loader's append sources, so it
// fails if the final append in session.ts (isolatedLoaderOptions) is removed.
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
const BOOT_SENTINEL = "BOOT-SENTINEL-7f2c";

let root: string;
let agentsRoot: string;
let agentDir: string;
let cwd: string;
let piAgentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-flairboot-prompt-"));
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

// Build a real pi session with bob's factory and return pi's assembled system
// prompt.
async function assembledSystemPrompt(flairBootstrap?: string): Promise<string> {
  const runtime = await stubRuntime();
  const config: RunSessionConfig = {
    ...resolveRunConfig({ name: "testbot", agentsRoot }).config,
    provider: STUB_PROVIDER,
    providerRecord: undefined,
    model: STUB_MODEL,
    modelLimits: { provider: STUB_PROVIDER, model: STUB_MODEL, contextWindow: 200_000 },
    extensionSources: [],
    appendSystemPrompt: SOUL_SENTINEL,
    ...(flairBootstrap !== undefined ? { flairBootstrap } : {}),
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

describe("the assembled system prompt carries soul then the Flair bootstrap", () => {
  it("places the bootstrap block AFTER soul.md", async () => {
    const prompt = await assembledSystemPrompt(
      `## Context from Flair (loaded at session start)\n${BOOT_SENTINEL}`,
    );
    const soulAt = prompt.indexOf(SOUL_SENTINEL);
    const bootAt = prompt.indexOf(BOOT_SENTINEL);
    expect(soulAt).toBeGreaterThanOrEqual(0);
    expect(bootAt).toBeGreaterThan(soulAt);
  });

  it("carries the failure note when the config holds one, not a fake context", async () => {
    const note =
      "Flair session context could not be loaded at session start (Flair was unreachable). Continuing without it.";
    const prompt = await assembledSystemPrompt(note);
    expect(prompt).toContain("could not be loaded");
    expect(prompt).not.toContain("## Active Skills");
  });

  it("appends nothing when the config carries no bootstrap", async () => {
    const prompt = await assembledSystemPrompt(undefined);
    expect(prompt).toContain(SOUL_SENTINEL);
    expect(prompt).not.toContain(BOOT_SENTINEL);
    expect(prompt).not.toContain("could not be loaded");
  });
});
