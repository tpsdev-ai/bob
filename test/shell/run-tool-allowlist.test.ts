// The ONE place a pi session is handed its tool policy is createPiRunSession's
// createAgentSession call. Before this change that call passed no `tools`, so
// every agent got pi's defaults (read, bash, edit, write) plus capability tools
// no matter what its role said, and bob.yaml's `tools:` block was written but
// never read back.
//
// These tests drive the REAL pi session (no SDK mock — a module mock here would
// leak into every other test file in the run) and read back the tool set the
// session actually came up with. run.test.ts asserts the resolved config a
// session factory receives; this file asserts what that config does to a
// session.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityConfigEnv, resolveCapabilities } from "../../src/shell/capability-loader.js";
import type { RunSessionConfig } from "../../src/shell/run.js";
import { createPiRunSession, resolveRunConfig } from "../../src/shell/run.js";

// The config REQUIRES `tools` with round 3; spelling it structurally keeps this
// file honest whichever way the field is declared.
type TooledConfig = RunSessionConfig & { tools?: string[]; excludeTools?: string[] };

describe("createPiRunSession — the tool policy reaches the session", () => {
  let cwd: string;
  let piAgentDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "bob-toolpolicy-cwd-"));
    piAgentDir = mkdtempSync(join(tmpdir(), "bob-toolpolicy-pi-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(piAgentDir, { recursive: true, force: true });
  });

  function baseConfig(overrides: Partial<TooledConfig>): TooledConfig {
    return {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      modelLimits: { provider: "anthropic", model: "claude-sonnet-4-6", contextWindow: 200_000 },
      appendSystemPrompt: "",
      cwd,
      piAgentDir,
      extensionSources: [],
      capabilityEnv: {},
      ...overrides,
    };
  }

  // The tool set the session actually came up with, sorted for comparison.
  async function activeTools(overrides: Partial<TooledConfig>): Promise<string[]> {
    const session = (await createPiRunSession(baseConfig(overrides))) as unknown as {
      getActiveToolNames(): string[];
      dispose(): void;
    };
    try {
      return session.getActiveToolNames().slice().sort();
    } finally {
      session.dispose();
    }
  }

  it("enables EXACTLY the allowlist", async () => {
    expect(await activeTools({ tools: ["read", "grep"], excludeTools: [] })).toEqual([
      "grep",
      "read",
    ]);
  });

  it("a RESIDENT session's `read` is the CONFINED one (custom tool overrides pi's) (bob#230)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "bob-toolpolicy-out-"));
    writeFileSync(join(outside, "secret.txt"), "outside contents");
    writeFileSync(join(cwd, "inside.txt"), "inside contents");
    const cred = join(cwd, "auth.json");
    writeFileSync(cred, "{}");
    const build = async (persistent: boolean) =>
      (await createPiRunSession(
        baseConfig({ tools: ["read"], excludeTools: [], persistent, credentialPaths: [cred] }),
      )) as unknown as {
        _toolRegistry: Map<string, { execute(...a: unknown[]): Promise<unknown> }>;
        dispose(): void;
      };
    const resident = await build(true);
    try {
      const read = resident._toolRegistry.get("read");
      if (!read) throw new Error("the resident `read` tool is not registered");
      const text = (r: unknown) =>
        (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("");
      // The workspace file reads.
      expect(text(await read.execute("c", { path: "inside.txt" }, undefined, undefined))).toContain(
        "inside contents",
      );
      // Outside the workspace is refused — the ACTIVE tool is the confined one.
      await expect(
        read.execute("c", { path: join(outside, "secret.txt") }, undefined, undefined),
      ).rejects.toThrow(/does not resolve to a file inside the agent's workspace/);
      // A credential file inside the workspace is refused.
      await expect(read.execute("c", { path: "auth.json" }, undefined, undefined)).rejects.toThrow(
        /credential file/,
      );
    } finally {
      resident.dispose();
    }
    // A NON-resident session keeps pi's own read (the custom tool is not added).
    const ephemeral = await build(false);
    try {
      const read = ephemeral._toolRegistry.get("read");
      if (!read) throw new Error("the ephemeral `read` tool is not registered");
      const r = (await read.execute(
        "c",
        { path: join(outside, "secret.txt") },
        undefined,
        undefined,
      )) as {
        content: Array<{ text?: string }>;
      };
      expect(r.content.map((c) => c.text ?? "").join("")).toContain("outside contents");
    } finally {
      ephemeral.dispose();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("REFUSES a config with no allowlist at all (the type and the runtime)", async () => {
    // Round 3: `tools` is REQUIRED. A session built without it would come up on
    // pi's defaults (read, bash, edit, write) — the absence of a policy is the
    // defect this area recovers from, so the factory refuses it rather than
    // falling back. Passing an empty list instead means "no tools at all".
    const config = baseConfig({ tools: undefined, excludeTools: [] });
    // The runtime refuses it even though the type would not (a caller can reach
    // here through `any`).
    await expect(createPiRunSession(config as unknown as RunSessionConfig)).rejects.toThrow(
      /without a resolved tool policy/,
    );
  });

  it("treats an explicit EMPTY allowlist as 'no tools'", async () => {
    expect(await activeTools({ tools: [], excludeTools: [] })).toEqual([]);
  });

  it("REFUSES a session whose allowlist names a tool no loaded capability provides", async () => {
    // flint #151 item 4: the EA role's allowlist names discord_reply. On an
    // agent that does not declare the discord capability, pi IGNORES the name
    // ("Unknown tool names are ignored") and the session comes up without the
    // tool its role asked for. That silent drop is a load error now, naming the
    // tool — the catalog cannot catch it, because the name is real in bob.
    const agentsRoot = mkdtempSync(join(tmpdir(), "bob-ea-no-discord-"));
    try {
      const agentDir = join(agentsRoot, "assistant");
      mkdirSync(join(agentDir, "work"), { recursive: true });
      mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
      writeFileSync(
        join(agentDir, "bob.yaml"),
        [
          "agent:",
          "  id: assistant",
          "  role: ea",
          "",
          "provider:",
          "  name: anthropic",
          "  model: claude-sonnet-4-6",
          "  context_window: 200000",
          "",
          "tools:",
          "  allow:",
          "    - discord_reply",
          "",
        ].join("\n"),
      );
      const { config } = resolveRunConfig({ name: "assistant", agentsRoot });
      expect(config.tools).toEqual(["discord_reply"]);
      await expect(createPiRunSession(config)).rejects.toThrow(/discord_reply/);
    } finally {
      rmSync(agentsRoot, { recursive: true, force: true });
    }
  });

  it("applies excludeTools after the allowlist (pi's documented order)", async () => {
    expect(await activeTools({ tools: ["read", "bash"], excludeTools: ["bash"] })).toEqual([
      "read",
    ]);
  });

  // A real capability's extension source + config env, resolved through the
  // catalog exactly as resolveRunConfig does it.
  function fixtureCapability(): Pick<TooledConfig, "extensionSources" | "capabilityEnv"> {
    const resolution = resolveCapabilities({
      yamlText: ["capabilities:", "  - fixture", "", "fixture:", "  greeting: hi", ""].join("\n"),
    });
    expect(resolution.extensionSources).toHaveLength(1);
    return {
      extensionSources: resolution.extensionSources,
      capabilityEnv: capabilityConfigEnv(resolution),
    };
  }

  it("enables a capability tool named in the allowlist", async () => {
    // Role allowlists name capability tools (flair_search, discord_reply, …).
    // pi's `tools` is a strict list over built-ins AND extension tools, so a
    // named capability tool must come up — otherwise every shipped role would
    // lose its memory/discord tools.
    const tools = await activeTools({
      tools: ["read", "bob_fixture_noop"],
      excludeTools: [],
      ...fixtureCapability(),
    });
    expect(tools).toEqual(["bob_fixture_noop", "read"]);
  });

  it("drops a tool excluded by name even when it is a capability tool", async () => {
    const tools = await activeTools({
      tools: ["read", "bob_fixture_noop"],
      excludeTools: ["bob_fixture_noop"],
      ...fixtureCapability(),
    });
    expect(tools).toEqual(["read"]);
  });
});
