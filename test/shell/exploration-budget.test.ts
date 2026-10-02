// bob#279 — the exploration budget. Through runAgent with a fabricated session
// that emits tool_execution_start events: a run that keeps reading gets ONE
// instruction after the budget and ends with `exploration_budget_exhausted`
// after twice the budget; a run that edits within budget is unaffected; a
// write-class call resets the count; the outcome is in the run log and doctor's
// last-run line; and the budget is read from the role/agent config.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExplorationBudget } from "../../src/shell/bob-yaml.js";
import { lastRunOutcomeReason, readLastRunSummary, runDoctor } from "../../src/shell/doctor.js";
import {
  BUILDER_LOCAL_EXPLORATION_BUDGET,
  EXPLORATION_INSTRUCTION,
  ExplorationBudgetDetector,
  ExplorationBudgetError,
} from "../../src/shell/exploration-budget.js";
import { loadRole } from "../../src/shell/role-loader.js";
import {
  type RunSession,
  type RunSessionFactory,
  resolveExplorationBudget,
  runAgent,
} from "../../src/shell/run.js";

// A fabricated AgentSession matching the RunSession seam. prompt() emits one
// tool_execution_start per call, then either ends an assistant message (a clean
// run) or hangs (so the run is ended by its own stop). steer() records what the
// runtime injects.
function makeSession(opts: { calls: string[]; resolve: boolean }): {
  session: RunSession;
  steers: string[];
  aborts: number;
} {
  const listeners: Array<(event: unknown) => void> = [];
  const steers: string[] = [];
  let aborts = 0;
  let done = false;
  const emit = (event: unknown): void => {
    for (const listener of listeners) listener(event);
  };
  const session: RunSession = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt() {
      let i = 0;
      for (const toolName of opts.calls) {
        if (done) break; // once the run is ended, stop feeding it
        // Varying args keep the loop breaker (identical calls) out of the way;
        // this test is about the exploration budget (varied read-only calls).
        emit({
          type: "tool_execution_start",
          toolCallId: `t${i}`,
          toolName,
          args: { path: `f${i}.ts` },
        });
        i += 1;
      }
      if (opts.resolve) {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
          },
        });
        return;
      }
      return new Promise<void>(() => {});
    },
    async steer(text: string) {
      steers.push(text);
    },
    async abort() {
      aborts += 1;
      done = true;
    },
    dispose() {
      // no-op
    },
  };
  return { session, steers, aborts: () => aborts };
}

function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
}

function agentYaml(name: string, role: string, runBlock?: string): string {
  return [
    "agent:",
    `  id: ${name}`,
    `  name: ${name}`,
    `  role: ${role}`,
    "",
    "provider:",
    "  name: anthropic",
    "  model: claude-sonnet-4-6",
    "",
    "tools:",
    "  allow:",
    "    - read_lines",
    "",
    ...(runBlock !== undefined ? ["run:", runBlock] : []),
  ].join("\n");
}

describe("ExplorationBudgetDetector", () => {
  it("counts consecutive read-only calls, injects at the limit and exhausts at twice it", () => {
    const d = new ExplorationBudgetDetector(3);
    expect(d.observe("read")).toEqual({ readOnlyCalls: 1, inject: false, exhaust: false });
    expect(d.observe("grep")).toEqual({ readOnlyCalls: 2, inject: false, exhaust: false });
    expect(d.observe("read_lines")).toEqual({ readOnlyCalls: 3, inject: true, exhaust: false });
    expect(d.observe("find")).toEqual({ readOnlyCalls: 4, inject: false, exhaust: false });
    expect(d.observe("ls")).toEqual({ readOnlyCalls: 5, inject: false, exhaust: false });
    expect(d.observe("flair_search")).toEqual({ readOnlyCalls: 6, inject: false, exhaust: true });
  });

  it("treats every non-read-only call — a writer, an effect, an egress tool, `run`, or an unknown name — as write-class and resets the count", () => {
    const d = new ExplorationBudgetDetector(2);
    d.observe("read");
    expect(d.observe("edit_lines")).toEqual({ readOnlyCalls: 0, inject: false, exhaust: false });
    d.observe("read");
    expect(d.observe("run").readOnlyCalls).toBe(0);
    d.observe("read");
    expect(d.observe("flair_write").readOnlyCalls).toBe(0);
    d.observe("read");
    expect(d.observe("web_fetch").readOnlyCalls).toBe(0);
    d.observe("read");
    expect(d.observe("not_a_real_tool").readOnlyCalls).toBe(0);
    // A fresh run of read-only calls still injects at the limit.
    d.observe("read");
    expect(d.observe("read").inject).toBe(true);
  });

  it("refuses a limit that is not a positive whole number", () => {
    expect(() => new ExplorationBudgetDetector(0)).toThrow(ExplorationBudgetError);
    expect(() => new ExplorationBudgetDetector(-1)).toThrow(ExplorationBudgetError);
    expect(() => new ExplorationBudgetDetector(1.5)).toThrow(ExplorationBudgetError);
  });
});

describe("resolveExplorationBudget", () => {
  it("reads the role default (builder-local ships 20) and lets bob.yaml override it", () => {
    const roleOnly = readFileSync(join("roles", "builder-local", "role.json"), "utf8");
    expect(loadRole("builder-local").exploration_budget).toBe(BUILDER_LOCAL_EXPLORATION_BUDGET);
    expect(BUILDER_LOCAL_EXPLORATION_BUDGET).toBe(20);
    expect(roleOnly).toContain('"exploration_budget": 20');
    expect(resolveExplorationBudget(agentYaml("b", "builder-local"))).toBe(20);
    expect(
      resolveExplorationBudget(agentYaml("b", "builder-local", "  exploration_budget: 4")),
    ).toBe(4);
  });

  it("leaves the budget off for a role that names none and sets it for one that does", () => {
    expect(resolveExplorationBudget(agentYaml("c", "coder"))).toBeUndefined();
    expect(resolveExplorationBudget(agentYaml("c", "coder", "  exploration_budget: 7"))).toBe(7);
  });

  it("refuses a non-positive or non-integer value in bob.yaml", () => {
    expect(() => readExplorationBudget("run:\n  exploration_budget: 0")).toThrow();
    expect(() => readExplorationBudget('run:\n  exploration_budget: "x"')).toThrow();
    expect(readExplorationBudget("run:\n  exploration_budget: 5")).toBe(5);
    expect(readExplorationBudget("agent:\n  id: x")).toBeUndefined();
  });
});

describe("runAgent exploration budget", () => {
  let agentsRoot: string;

  const mkAgent = (name: string, role: string, runBlock?: string): void => {
    const agentDir = join(agentsRoot, name);
    mkdirSync(join(agentDir, "work"), { recursive: true });
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    writeFileSync(join(agentDir, "bob.yaml"), agentYaml(name, role, runBlock));
    writeFileSync(join(agentDir, "soul.md"), "You are a builder.");
  };

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-explore-"));
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  it("ends a run that keeps reading: one instruction at the budget, exploration_budget_exhausted at twice it", async () => {
    mkAgent("reader", "builder-local");
    const fake = makeSession({
      calls: Array.from({ length: 40 }, () => "read_lines"),
      resolve: false,
    });
    const res = await runAgent({
      name: "reader",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    // The instruction is delivered ONCE, and exactly at the budget (20).
    expect(fake.steers).toEqual([EXPLORATION_INSTRUCTION]);
    expect(res.exitCode).toBe(1);
    expect(res.explorationBudgetExhausted).toEqual({ limit: 20, readOnlyCalls: 40 });
    expect(res.loopBreaker).toBeUndefined();
    expect(res.failed).toBe(true);
    expect(fake.aborts()).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("reads the budget from the agent config and ends after twice it", async () => {
    mkAgent("reader2", "builder-local", "  exploration_budget: 3");
    const fake = makeSession({
      calls: ["read_lines", "read_lines", "read_lines", "read_lines", "read_lines", "read_lines"],
      resolve: false,
    });
    const res = await runAgent({
      name: "reader2",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(fake.steers).toEqual([EXPLORATION_INSTRUCTION]);
    expect(res.exitCode).toBe(1);
    expect(res.explorationBudgetExhausted).toEqual({ limit: 3, readOnlyCalls: 6 });
  }, 15_000);

  it("does not fire when the run edits within budget", async () => {
    mkAgent("editor", "builder-local", "  exploration_budget: 5");
    const fake = makeSession({ calls: ["read_lines", "read_lines", "edit_lines"], resolve: true });
    const res = await runAgent({
      name: "editor",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(fake.steers).toEqual([]);
    expect(res.exitCode).toBe(0);
    expect(res.explorationBudgetExhausted).toBeUndefined();
  }, 15_000);

  it("resets the count on a write-class call", async () => {
    mkAgent("mixed", "builder-local", "  exploration_budget: 3");
    // 2 reads, a write, 2 reads: the longest read-only run is 2, under the limit.
    const fake = makeSession({
      calls: ["read_lines", "read_lines", "edit_lines", "read_lines", "read_lines"],
      resolve: true,
    });
    const res = await runAgent({
      name: "mixed",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(fake.steers).toEqual([]);
    expect(res.exitCode).toBe(0);
  }, 15_000);

  it("records the outcome in the run log and shows it in doctor's last-run line", async () => {
    mkAgent("logged", "builder-local", "  exploration_budget: 2");
    const fake = makeSession({
      calls: ["read_lines", "read_lines", "read_lines", "read_lines"],
      resolve: false,
    });
    const res = await runAgent({
      name: "logged",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(res.explorationBudgetExhausted).toEqual({ limit: 2, readOnlyCalls: 4 });

    const runsDir = join(agentsRoot, "logged", "runs");
    const logs = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));
    expect(logs.length).toBe(1);
    const lines = readFileSync(join(runsDir, logs[0]), "utf8").split("\n").filter(Boolean);
    const outcomes = lines
      .map((l) => JSON.parse(l) as { outcome?: { reason?: string } })
      .filter((r) => r.outcome !== undefined);
    expect(outcomes.at(-1)?.outcome?.reason).toBe("exploration_budget_exhausted");

    const report = runDoctor({ name: "logged", agentsRoot, homeDir: agentsRoot });
    const lastRun = report.checks.find((c) => c.name === "last run");
    expect(lastRun).toBeDefined();
    expect(lastRun?.detail).toContain("exploration_budget_exhausted");
    expect(lastRun?.status).toBe("warn");
    expect(lastRun?.fix).toContain("exploration_budget");
  }, 15_000);
});

describe("readLastRunSummary", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bob-runlog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the last outcome and exit code from the newest log", () => {
    const runs = join(dir, "runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      join(runs, "a.jsonl"),
      [
        JSON.stringify({ t: "1", event: { type: "agent_start" } }),
        JSON.stringify({ t: "2", outcome: { reason: "tool_loop", toolName: "edit", count: 4 } }),
        JSON.stringify({ t: "3", event: { type: "turn_end" } }),
        JSON.stringify({ done: true, exitCode: 1 }),
      ].join("\n"),
    );
    const summary = readLastRunSummary(runs);
    expect(summary?.file).toBe("a.jsonl");
    expect(lastRunOutcomeReason(summary?.outcome)).toBe("tool_loop");
    expect(summary?.exitCode).toBe(1);
  });

  it("returns undefined when there is no runs directory or no log", () => {
    expect(readLastRunSummary(join(dir, "runs"))).toBeUndefined();
    mkdirSync(join(dir, "runs"), { recursive: true });
    expect(readLastRunSummary(join(dir, "runs"))).toBeUndefined();
    expect(existsSync(join(dir, "runs"))).toBe(true);
  });

  it("returns undefined when a listed log is missing at open", () => {
    const runs = join(dir, "runs");
    mkdirSync(runs, { recursive: true });
    symlinkSync(join(runs, "vanished-target"), join(runs, "vanished.jsonl"));
    expect(readLastRunSummary(runs)).toBeUndefined();
  });

  it("reports a missing or malformed outcome as 'no outcome recorded', never as success", () => {
    expect(lastRunOutcomeReason(undefined)).toBe("no outcome recorded");
    expect(lastRunOutcomeReason({})).toBe("no outcome recorded");
    expect(lastRunOutcomeReason({ reason: "" })).toBe("no outcome recorded");
    expect(lastRunOutcomeReason({ reason: "wall_clock" })).toBe("wall_clock");
  });
});
