// `bob align` — the recurring alignment check-in.
//
// Same session shape as onboarding (bob's ONE factory through pi's
// InteractiveMode, under the fixed setup policy), so this file asserts the
// alignment-specific parts: soul.md must exist, the meta-prompt frames drift,
// the setup policy is the fixed read + write, and the soul hash tells us
// whether the check-in actually produced an update.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAlign } from "../../src/shell/align.js";
import type { SessionRunner } from "../../src/shell/onboard.js";
import { SETUP_TOOL_POLICY } from "../../src/shell/session.js";

interface Run {
  policy: { tools: string[] };
  config: { appendSystemPrompt: string };
  initialMessage: string;
}

function fakeRunner(opts: { exitCode?: number; writeSoul?: string; onRun?: (run: Run) => void }): {
  runner: SessionRunner;
  runs: Run[];
} {
  const runs: Run[] = [];
  const runner: SessionRunner = async (input) => {
    const run: Run = {
      policy: { tools: [...input.policy.tools] },
      config: { appendSystemPrompt: input.config.appendSystemPrompt },
      initialMessage: input.initialMessage,
    };
    runs.push(run);
    opts.onRun?.(run);
    if (opts.writeSoul !== undefined) writeFileSync(join(agentDir, "soul.md"), opts.writeSoul);
    return opts.exitCode ?? 0;
  };
  return { runner, runs };
}

let agentDir: string;

function scaffoldAgent(role = "ea"): void {
  const root = mkdtempSync(join(tmpdir(), "bob-align-"));
  agentDir = join(root, "testbot");
  mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
  mkdirSync(join(agentDir, "work"), { recursive: true });
  writeFileSync(join(agentDir, "soul.md"), "current persona\n");
  writeFileSync(
    join(agentDir, "bob.yaml"),
    [
      "agent:",
      "  id: testbot",
      "  name: Testbot",
      `  role: ${role}`,
      "",
      "provider:",
      "  name: anthropic",
      "  model: claude-sonnet-4-6",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
    ].join("\n"),
  );
}

describe("runAlign", () => {
  afterEach(() => {
    rmSync(dirname(agentDir), { recursive: true, force: true });
  });

  it("reports soulUpdated=true when soul.md changes during the session", async () => {
    scaffoldAgent();
    const { runner } = fakeRunner({ writeSoul: "updated persona\n" });
    const res = await runAlign({
      name: "testbot",
      agentDir,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionRunner: runner,
    });
    expect(res.soulUpdated).toBe(true);
    expect(res.soulHashBefore).not.toBe(res.soulHashAfter);
  });

  it("reports soulUpdated=false when nothing was changed", async () => {
    scaffoldAgent();
    const { runner } = fakeRunner({});
    const res = await runAlign({
      name: "testbot",
      agentDir,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionRunner: runner,
    });
    expect(res.soulUpdated).toBe(false);
  });

  it("runs the check-in under the fixed setup policy (read + write)", async () => {
    scaffoldAgent();
    const { runner, runs } = fakeRunner({});
    await runAlign({
      name: "testbot",
      agentDir,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionRunner: runner,
    });
    expect(runs[0].policy.tools).toEqual([...SETUP_TOOL_POLICY.tools]);
  });

  it("frames the check-in around the agent's current soul.md", async () => {
    scaffoldAgent();
    const { runner, runs } = fakeRunner({});
    await runAlign({
      name: "testbot",
      agentDir,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionRunner: runner,
    });
    expect(runs[0].config.appendSystemPrompt).toContain("alignment check");
    expect(runs[0].config.appendSystemPrompt).toContain(join(agentDir, "soul.md"));
    expect(runs[0].initialMessage).toContain("testbot");
  });

  it("propagates a non-zero exit code", async () => {
    scaffoldAgent();
    const { runner } = fakeRunner({ exitCode: 1 });
    const res = await runAlign({
      name: "testbot",
      agentDir,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionRunner: runner,
    });
    expect(res.exitCode).toBe(1);
  });

  it("refuses when soul.md is missing (nothing to align)", async () => {
    scaffoldAgent();
    rmSync(join(agentDir, "soul.md"));
    const { runner, runs } = fakeRunner({});
    await expect(
      runAlign({
        name: "testbot",
        agentDir,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        sessionRunner: runner,
      }),
    ).rejects.toThrow(/soul\.md not found/);
    expect(runs).toEqual([]);
  });

  it("REFUSES to start the check-in when the agent has no tool policy", async () => {
    scaffoldAgent();
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: ea",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-x",
        "",
      ].join("\n"),
    );
    const { runner, runs } = fakeRunner({});
    await expect(
      runAlign({
        name: "testbot",
        agentDir,
        provider: "anthropic",
        model: "claude-x",
        sessionRunner: runner,
      }),
    ).rejects.toThrow(/no tools: block/);
    expect(runs).toEqual([]);
  });

  it("rejects path-traversal in name", async () => {
    scaffoldAgent();
    await expect(
      runAlign({
        name: "../etc",
        agentDir,
        provider: "anthropic",
        model: "claude-x",
        sessionRunner: fakeRunner({}).runner,
      }),
    ).rejects.toThrow(/invalid agent name/);
  });
});
