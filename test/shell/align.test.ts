// `bob align` — the recurring alignment check-in.
//
// Same session shape as onboarding (bob's ONE factory through pi's
// InteractiveMode, under the fixed setup policy), so this file asserts the
// alignment-specific parts: soul.md must exist, the meta-prompt frames drift,
// the setup policy is the fixed read + write_soul, write_soul is bound to the
// directory the session runs as, and the soul hash tells us
// whether the check-in actually produced an update.
import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAlign } from "../../src/shell/align.js";
import { stringFlag } from "../../src/shell/argv.js";
import type { SessionRunner } from "../../src/shell/onboard.js";
import type { RunSessionConfig } from "../../src/shell/run.js";
import { SETUP_TOOL_POLICY } from "../../src/shell/session.js";

interface Run {
  policy: { tools: string[] };
  config: {
    appendSystemPrompt: string;
    provider: string;
    model: string;
    piAgentDir: string;
    setupSoulPath?: string;
  };
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
        setupSoulPath: input.config.setupSoulPath,
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
  role = "reviewer",
  provider: { name: string; model: string } = { name: "anthropic", model: "claude-sonnet-4-6" },
): void {
  // Canonical: write_soul is bound to the realpath of the agents root.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bob-align-")));
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

  it("runs the check-in under the fixed setup policy (read + write_soul)", async () => {
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
    // bob#204: soul-only write; pi's generic `write` is NOT granted.
    expect(runs[0].policy.tools).toEqual(["read", "write_soul"]);
    expect(runs[0].policy.tools).not.toContain("write");
    expect(runs[0].config.setupSoulPath).toBe(join(agentDir, "soul.md"));
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

  // bob#204: write_soul is bound to the directory the session RUNS AS
  // (resolveRunConfig's), never to a requested --agent-dir naming another agent.
  it("refuses `align testbot --agent-dir <other>` before the session starts; other's soul.md is untouched", async () => {
    scaffoldAgent();
    const other = join(dirname(agentDir), "other");
    mkdirSync(other);
    writeFileSync(join(other, "soul.md"), "other persona\n");
    // A runner that does what write_soul does: write the soul.md it is BOUND to.
    const bound: string[] = [];
    const runner: SessionRunner = async (input) => {
      bound.push(String(input.config.setupSoulPath));
      if (input.config.setupSoulPath) writeFileSync(input.config.setupSoulPath, "rewritten\n");
      return 0;
    };
    await expect(
      runAlign({ name: "testbot", agentDir: other, sessionRunner: runner }),
    ).rejects.toThrow(/refusing to start - the agent directory \S*other is not testbot's/);
    expect(bound).toEqual([]);
    expect(readFileSync(join(other, "soul.md"), "utf8")).toBe("other persona\n");
    expect(readFileSync(join(agentDir, "soul.md"), "utf8")).toBe("current persona\n");
  });

  it("binds write_soul to the directory resolveRunConfig resolved, whatever spelling names it", async () => {
    scaffoldAgent();
    const { runner, runs } = fakeRunner({});
    await runAlign({ name: "testbot", agentDir: `${agentDir}/work/../`, sessionRunner: runner });
    expect(runs[0].config.setupSoulPath).toBe(join(agentDir, "soul.md"));
  });

  // bob#204: the agents root is canonicalized ONCE, before the config is read,
  // so the config, the session's paths and write_soul come from ONE tree.
  it("resolves a linked agents root once: config, session paths and soul come from the canonical tree", async () => {
    scaffoldAgent(); // the canonical tree: <root>/testbot, model claude-sonnet-4-6
    const root = dirname(agentDir);
    const treeB = join(root, "tree-b");
    mkdirSync(join(treeB, "testbot", "work"), { recursive: true });
    writeFileSync(join(treeB, "testbot", "soul.md"), "tree b persona\n");
    writeFileSync(
      join(treeB, "testbot", "bob.yaml"),
      readFileSync(join(agentDir, "bob.yaml"), "utf8").replace("claude-sonnet-4-6", "tree-b-model"),
    );
    const link = join(root, "agents-link");
    symlinkSync(root, link);
    // The runner retargets the link as the session starts: nothing the setup
    // flow resolved may follow it.
    const seen: RunSessionConfig[] = [];
    const runner: SessionRunner = async (input) => {
      seen.push(input.config);
      unlinkSync(link);
      symlinkSync(treeB, link);
      return 0;
    };
    const res = await runAlign({
      name: "testbot",
      agentDir: join(link, "testbot"),
      sessionRunner: runner,
    });
    expect(seen[0]?.cwd).toBe(join(agentDir, "work"));
    expect(seen[0]?.piAgentDir).toBe(join(agentDir, ".pi-agent"));
    expect(seen[0]?.setupSoulPath).toBe(join(agentDir, "soul.md"));
    expect(seen[0]?.model).toBe("claude-sonnet-4-6");
    expect(res.agentDir).toBe(agentDir);
    expect(res.soulPath).toBe(join(agentDir, "soul.md"));
    expect(res.soulUpdated).toBe(false);
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
    scaffoldAgent("reviewer", { name: "exe-dev-gateway", model: "claude-opus-4-7" });
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
    scaffoldAgent("reviewer", { name: "ollama-cloud", model: "kimi-k2.6" });
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
    scaffoldAgent("reviewer", { name: "ollama-cloud", model: "kimi-k2.6" });
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

  it("keeps credential paths under a provider/model override", async () => {
    // bob.yaml's own provider is ollama-cloud (a pass-through), but the override
    // names a DIFFERENT bob provider (exe-dev-gateway -> anthropic) and a
    // different model. The provider + model fields must follow the override, while
    // piAgentDir must stay the agent's own dir — the credential source is fixed.
    scaffoldAgent("reviewer", { name: "ollama-cloud", model: "kimi-k2.6" });
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

    await runAlign({ name: "testbot", agentDir, sessionRunner: runner });
    const {
      provider: _p0,
      model: _m0,
      providerRecord: selectedOverride,
      ...overridden
    } = runs[0].fullConfig;
    const {
      provider: _p1,
      model: _m1,
      providerRecord: selectedDefault,
      ...unflagged
    } = runs[1].fullConfig;
    expect(selectedOverride).toMatchObject({ id: "exe-dev-gateway", runtime: "anthropic" });
    expect(selectedDefault).toMatchObject({ id: "ollama-cloud", runtime: "ollama-cloud" });
    expect(Object.keys(overridden.capabilityEnv as Record<string, string>)).not.toHaveLength(0);
    expect(overridden).toEqual(unflagged);
  });
});
