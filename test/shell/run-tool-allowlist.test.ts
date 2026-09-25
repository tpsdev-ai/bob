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

// The config gains `tools`/`excludeTools` with the change; spelling them
// structurally keeps this file honest whichever way the field is declared.
type TooledConfig = RunSessionConfig & { tools?: string[]; excludeTools?: string[] };

// pi's own defaults, as the installed SDK documents them (sdk.d.ts: "the
// default built-in tools (read, bash, edit, write)").
const PI_DEFAULT_TOOLS = ["bash", "edit", "read", "write"];

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

  it("leaves pi's defaults in place when no allowlist is passed AT ALL", async () => {
    // Factory-level tolerance only: resolveAgentToolPolicy refuses a bob.yaml
    // without `tools.allow`, so no launch path gets here empty — a caller that
    // builds a session by hand can still omit the list, and pi's defaults then
    // apply. Passing an empty list instead means "no tools at all".
    expect(await activeTools({ tools: undefined, excludeTools: [] })).toEqual(PI_DEFAULT_TOOLS);
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
          "",
          "tools:",
          "  allow:",
          "    - read",
          "    - discord_reply",
          "",
        ].join("\n"),
      );
      const { config } = resolveRunConfig({ name: "assistant", agentsRoot });
      expect(config.tools).toEqual(["read", "discord_reply"]);
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
