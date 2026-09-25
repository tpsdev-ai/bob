// `bob align` — the recurring alignment check-in.
//
// Same session shape as onboarding (bob's ONE factory through pi's
// InteractiveMode, under the fixed setup policy), so this file asserts the
// alignment-specific parts: soul.md must exist, the meta-prompt frames drift,
// the setup policy is the fixed read + write, and the soul hash tells us
// whether the check-in actually produced an update.
import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAlign } from "../../src/shell/align.js";
import { stringFlag } from "../../src/shell/argv.js";
import type { SessionRunner } from "../../src/shell/onboard.js";
import { SETUP_TOOL_POLICY } from "../../src/shell/session.js";

interface Run {
  policy: { tools: string[] };
  config: { appendSystemPrompt: string; provider: string; model: string; piAgentDir: string };
  // The whole session config, for tests that compare every field.
  fullConfig: Record<string, unknown>;
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
      config: {
        appendSystemPrompt: input.config.appendSystemPrompt,
        provider: input.config.provider,
        model: input.config.model,
        piAgentDir: input.config.piAgentDir,
      },
      fullConfig: { ...(input.config as unknown as Record<string, unknown>) },
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

function scaffoldAgent(
  role = "ea",
  provider: { name: string; model: string } = { name: "anthropic", model: "claude-sonnet-4-6" },
): void {
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
      `  name: ${provider.name}`,
      `  model: ${provider.model}`,
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

// #155: the check-in runs on the agent's OWN provider and model. `bob align`
// used to hand runAlign its own hardcoded defaults (`ollama-cloud` /
// `kimi-k2.6`), so an alignment session could run on a different model than the
// agent it was aligning. The fields are optional overrides now, and an override
// replaces only the field it names.
describe("runAlign — the agent's own provider and model (#155)", () => {
  afterEach(() => {
    rmSync(dirname(agentDir), { recursive: true, force: true });
  });

  it("carries bob.yaml's provider and model when neither flag is given", async () => {
    scaffoldAgent(); // provider.name: anthropic, provider.model: claude-sonnet-4-6
    const { runner, runs } = fakeRunner({});
    await runAlign({ name: "testbot", agentDir, sessionRunner: runner });
    expect(runs[0].config.provider).toBe("anthropic");
    expect(runs[0].config.model).toBe("claude-sonnet-4-6");
  });

  it("maps bob.yaml's provider to pi's id exactly once", async () => {
    // bob's `exe-dev-gateway` is pi's `anthropic` (see run.ts
    // mapBobProviderToPi): the resolved value arrives already mapped, and
    // runAlign must not map it a second time or hand pi bob's own name.
    scaffoldAgent("ea", { name: "exe-dev-gateway", model: "claude-opus-4-7" });
    const { runner, runs } = fakeRunner({});
    await runAlign({ name: "testbot", agentDir, sessionRunner: runner });
    expect(runs[0].config.provider).toBe("anthropic");
    expect(runs[0].config.model).toBe("claude-opus-4-7");
  });

  it("--model alone replaces the model and keeps bob.yaml's provider", async () => {
    scaffoldAgent();
    const { runner, runs } = fakeRunner({});
    await runAlign({
      name: "testbot",
      agentDir,
      model: stringFlag({ model: "claude-opus-4-7" }, "model"),
      sessionRunner: runner,
    });
    expect(runs[0].config.provider).toBe("anthropic");
    expect(runs[0].config.model).toBe("claude-opus-4-7");
  });

  it("--provider alone replaces the provider and keeps bob.yaml's model", async () => {
    scaffoldAgent("ea", { name: "ollama-cloud", model: "kimi-k2.6" });
    const { runner, runs } = fakeRunner({});
    await runAlign({
      name: "testbot",
      agentDir,
      provider: stringFlag({ provider: "exe-dev-gateway" }, "provider"),
      sessionRunner: runner,
    });
    // The override is a BOB provider name and is mapped once, at this boundary.
    expect(runs[0].config.provider).toBe("anthropic");
    expect(runs[0].config.model).toBe("kimi-k2.6");
  });

  it("a bare --model (no value) is not a value: bob.yaml's model stays", async () => {
    // What the CLI hands runAlign for `bob align testbot --model`: parseArgs
    // yields `true` for a valueless flag, and stringFlag reads that as "not
    // given" (the rule `bob run` and `bob install-service` already use). `bob
    // run <name> --model` behaves the same way — the flag is treated as absent.
    scaffoldAgent();
    const { runner, runs } = fakeRunner({});
    await runAlign({
      name: "testbot",
      agentDir,
      model: stringFlag({ model: true }, "model"),
      sessionRunner: runner,
    });
    expect(runs[0].config.model).toBe("claude-sonnet-4-6");
    expect(runs[0].config.provider).toBe("anthropic");
  });

  it("a bare --provider (no value) is not a value: bob.yaml's provider stays", async () => {
    scaffoldAgent("ea", { name: "ollama-cloud", model: "kimi-k2.6" });
    const { runner, runs } = fakeRunner({});
    await runAlign({
      name: "testbot",
      agentDir,
      provider: stringFlag({ provider: true }, "provider"),
      sessionRunner: runner,
    });
    expect(runs[0].config.provider).toBe("ollama-cloud");
    expect(runs[0].config.model).toBe("kimi-k2.6");
  });
});

// #170 follow-up: an --provider / --model override may change ONLY the provider
// and model it names. It must NOT move the credential source: pi reads its
// auth.json from the agent's own .pi-agent dir (RunSessionConfig.piAgentDir),
// which is fixed to the agent's directory and is never a field the override
// touches. (An override that redirected the credential dir would let `bob align`
// sign in as a different principal than the agent it was aligning.)
describe("runAlign — an override cannot change the credential source (#170)", () => {
  afterEach(() => {
    rmSync(dirname(agentDir), { recursive: true, force: true });
  });

  it("keeps every field but provider and model (piAgentDir and capabilityEnv included) under a --provider + --model override", async () => {
    // bob.yaml's own provider is ollama-cloud (a pass-through), but the override
    // names a DIFFERENT bob provider (exe-dev-gateway -> anthropic) and a
    // different model. The provider + model fields must follow the override, while
    // piAgentDir must stay the agent's own dir — the credential source is fixed.
    scaffoldAgent("ea", { name: "ollama-cloud", model: "kimi-k2.6" });
    // A capability whose config names a credential file, so capabilityEnv is
    // not empty and the comparison below can fail.
    appendFileSync(
      join(agentDir, "bob.yaml"),
      [
        "capabilities:",
        "  - flair",
        "",
        "flair:",
        "  url: http://127.0.0.1:9",
        "  agentId: testbot",
        "  keyFile: /dev/null",
        "",
      ].join("\n"),
    );
    const { runner, runs } = fakeRunner({});
    await runAlign({
      name: "testbot",
      agentDir,
      provider: "exe-dev-gateway",
      model: "claude-opus-4-7",
      sessionRunner: runner,
    });
    // The override took effect on the provider (mapped once to pi's id) and model.
    expect(runs[0].config.provider).toBe("anthropic");
    expect(runs[0].config.model).toBe("claude-opus-4-7");
    // But the credential source is still the agent's own .pi-agent dir.
    expect(runs[0].config.piAgentDir).toBe(join(agentDir, ".pi-agent"));

    // And every other field besides provider and model is exactly what an
    // unflagged check-in resolves: capabilityEnv (which can name a credential
    // file) included.
    await runAlign({ name: "testbot", agentDir, sessionRunner: runner });
    const { provider: _p0, model: _m0, ...overridden } = runs[0].fullConfig;
    const { provider: _p1, model: _m1, ...unflagged } = runs[1].fullConfig;
    expect(Object.keys(overridden.capabilityEnv as Record<string, string>)).not.toHaveLength(0);
    expect(overridden).toEqual(unflagged);
  });
});
