// The ONE place a pi session is handed its tool policy is createPiRunSession's
// createAgentSession call. That call is the contract: before this change it
// passed no `tools`, so every agent got pi's defaults (read, bash, edit, write)
// plus capability tools no matter what its role said, and bob.yaml's `tools:`
// block was written but never read back. Mock the SDK here so the test can read
// the options createPiRunSession actually passes.
//
// (run.test.ts asserts the resolved config a session factory receives — this
// file asserts the SDK call that config is threaded into.)
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { RunSessionConfig } from "../../src/shell/run.js";

const sessionCalls: Array<Record<string, unknown>> = [];

mock.module("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: async (opts: Record<string, unknown>) => {
    sessionCalls.push(opts);
    return { session: { dispose() {} } };
  },
  DefaultResourceLoader: class {
    constructor(_opts: unknown) {}
    async reload(): Promise<void> {}
    getExtensions() {
      return { errors: [] as Array<{ path: string; error: string }> };
    }
  },
  ModelRuntime: {
    create: async () => ({
      getModel: () => ({ provider: "anthropic", id: "claude-sonnet-4-6" }),
    }),
  },
  SessionManager: {
    inMemory: (cwd: string) => ({ kind: "in-memory", cwd }),
    create: (cwd: string) => ({ kind: "durable", cwd }),
  },
}));

const { createPiRunSession } = await import("../../src/shell/run.js");

// The config gains `tools`/`excludeTools` with the change; spelling them
// structurally keeps this file honest whichever way the field is declared.
type TooledConfig = RunSessionConfig & { tools?: string[]; excludeTools?: string[] };

function baseConfig(overrides: Partial<TooledConfig>): TooledConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    appendSystemPrompt: "",
    cwd: "/tmp/bob-toolpolicy-work",
    piAgentDir: "/tmp/bob-toolpolicy-pi",
    extensionSources: [],
    capabilityEnv: {},
    ...overrides,
  };
}

describe("createPiRunSession — the tool policy reaches createAgentSession", () => {
  beforeEach(() => {
    sessionCalls.length = 0;
  });

  it("passes the allowlist as `tools` and the exclusions as `excludeTools`", async () => {
    await createPiRunSession(
      baseConfig({
        tools: ["read", "flair_search"],
        excludeTools: ["bash", "write", "edit", "powershell"],
      }),
    );
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0]?.tools).toEqual(["read", "flair_search"]);
    expect(sessionCalls[0]?.excludeTools).toEqual(["bash", "write", "edit", "powershell"]);
  });

  it("omits both arguments when the agent declared no tool policy", async () => {
    // No `tools:` block in bob.yaml = pi's own defaults. Passing an empty
    // allowlist would mean "no tools at all", which is a different agent.
    await createPiRunSession(baseConfig({ tools: undefined, excludeTools: [] }));
    expect(sessionCalls).toHaveLength(1);
    const opts = sessionCalls[0] ?? {};
    expect("tools" in opts).toBe(false);
    expect("excludeTools" in opts).toBe(false);
  });

  it("omits excludeTools when nothing is excluded", async () => {
    await createPiRunSession(baseConfig({ tools: ["read"], excludeTools: [] }));
    expect(sessionCalls[0]?.tools).toEqual(["read"]);
    const opts = sessionCalls[0] ?? {};
    expect("excludeTools" in opts).toBe(false);
  });
});
