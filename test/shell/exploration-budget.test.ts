import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createReplaceLinesToolDefinition,
  createTolerantEditToolDefinition,
} from "../../src/shell/bob-edit-tools.js";
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
import { makeHarness } from "../capabilities/anchored-edit/helpers.js";

type ScriptedCall =
  | string
  | { tool: string; error?: boolean | "unknown"; result?: unknown; args?: Record<string, unknown> };

const editResults: Record<string, object> = {
  write: { content: [{ type: "text", text: "Successfully wrote 0 bytes to f.ts" }] },
  edit: {
    content: [{ type: "text", text: "edited f.ts" }],
    details: { diff: "-1 before\n+1 after" },
  },
  replace_lines: { content: [{ type: "text", text: "Replaced lines 1-1 in f.ts." }] },
  write_file: {
    content: [{ type: "text", text: "edited f.ts" }],
    details: { fingerprint: "F#0123456789abcdef", bytes: 0 },
  },
  edit_lines: {
    content: [{ type: "text", text: "edited f.ts" }],
    details: { fingerprint: "F#0123456789abcdef", lineDelta: 0 },
  },
  insert_after: {
    content: [{ type: "text", text: "edited f.ts" }],
    details: { fingerprint: "F#0123456789abcdef", lineDelta: 1 },
  },
};

// A fabricated AgentSession matching the RunSession seam. prompt() emits one
// tool_execution_start per call, then either ends an assistant message (a clean
// run) or hangs (so the run is ended by its own stop). `script` replaces that
// for the nth prompt() call, for the turn scripts the budget needs (a turn that
// compacts and goes silent, then a continue turn that overruns).
function makeSession(opts: {
  calls?: ScriptedCall[];
  resolve?: boolean;
  script?: Array<(emit: (event: unknown) => void) => void>;
}): {
  session: RunSession;
  steers: string[];
  steerCallCounts: number[];
  aborts: () => number;
} {
  const listeners: Array<(event: unknown) => void> = [];
  const steers: string[] = [];
  const steerCallCounts: number[] = [];
  let startedCalls = 0;
  let aborts = 0;
  let done = false;
  let promptCalls = 0;
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
      promptCalls += 1;
      const scripted = opts.script?.[promptCalls - 1];
      if (scripted !== undefined) {
        scripted(emit);
        return;
      }
      let i = 0;
      for (const call of opts.calls ?? []) {
        if (done) break; // once the run is ended, stop feeding it
        const toolName = typeof call === "string" ? call : call.tool;
        const toolCallId = `t${i}`;
        startedCalls += 1;
        // Varying args keep the loop breaker (identical calls) out of the way;
        // this test is about the exploration budget.
        emit({
          type: "tool_execution_start",
          toolCallId,
          toolName,
          args:
            typeof call === "string" ? { path: `f${i}.ts` } : (call.args ?? { path: `f${i}.ts` }),
        });
        if (typeof call !== "string") {
          emit({
            type: "tool_execution_end",
            toolCallId,
            toolName,
            result: call.result ?? { content: [] },
            isError: call.error === "unknown" ? undefined : call.error === true,
          });
        }
        i += 1;
      }
      if (opts.resolve === true) {
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
      steerCallCounts.push(startedCalls);
    },
    async abort() {
      aborts += 1;
      done = true;
    },
    dispose() {
      // no-op
    },
  };
  return { session, steers, steerCallCounts, aborts: () => aborts };
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
  it("credits real file-edit tool results after checking the written bytes", async () => {
    const h = makeHarness();
    const d = new ExplorationBudgetDetector(2);
    const credit = (tool: string, result: unknown) => {
      d.observeStart("read");
      expect(d.observeEnd(tool, false, result).nonProgressCalls).toBe(0);
    };
    try {
      for (const [name, tool, input, expected] of [
        [
          "write",
          createWriteToolDefinition(h.root),
          { path: "f.ts", content: "a\nb\nc\nd\n" },
          "a\nb\nc\nd\n",
        ],
        [
          "edit",
          createTolerantEditToolDefinition(h.root),
          { path: "f.ts", edits: [{ oldText: "a", newText: "A" }] },
          "A\nb\nc\nd\n",
        ],
        [
          "replace_lines",
          createReplaceLinesToolDefinition(h.root),
          { path: "f.ts", startLine: 2, endLine: 2, newText: "B" },
          "A\nB\nc\nd\n",
        ],
      ] as const) {
        const result = await (
          tool as { execute: (id: string, input: unknown) => Promise<unknown> }
        ).execute("edit", input);
        expect(readFileSync(join(h.root, "f.ts"), "utf8")).toBe(expected);
        credit(name, result);
      }
      const read = await h.call("read_lines", { path: "f.ts" });
      const edited = await h.call("edit_lines", {
        path: "f.ts",
        from: h.anchor("f.ts", 1),
        to: h.anchor("f.ts", 1),
        new_text: "",
        fingerprint: read.details.fingerprint,
      });
      expect(readFileSync(join(h.root, "f.ts"), "utf8")).toBe("B\nc\nd\n");
      credit("edit_lines", {
        content: [{ type: "text", text: edited.text }],
        details: edited.details,
      });
      const inserted = await h.call("insert_after", {
        path: "f.ts",
        anchor: "L0",
        text: "start",
        fingerprint: edited.details.fingerprint,
      });
      expect(readFileSync(join(h.root, "f.ts"), "utf8")).toBe("start\nB\nc\nd\n");
      credit("insert_after", {
        content: [{ type: "text", text: inserted.text }],
        details: inserted.details,
      });
      const created = await h.call("write_file", { path: "empty.ts", content: "" });
      expect(readFileSync(join(h.root, "empty.ts"), "utf8")).toBe("");
      credit("write_file", {
        content: [{ type: "text", text: created.text }],
        details: created.details,
      });
    } finally {
      h.cleanup();
    }
  });

  it("counts reads, injects at the limit and exhausts at twice it", () => {
    const d = new ExplorationBudgetDetector(3);
    expect(d.observeStart("read")).toEqual({ nonProgressCalls: 1, inject: false, exhaust: false });
    expect(d.observeStart("grep")).toEqual({ nonProgressCalls: 2, inject: false, exhaust: false });
    expect(d.observeStart("read_lines")).toEqual({
      nonProgressCalls: 3,
      inject: true,
      exhaust: false,
    });
    expect(d.observeStart("find")).toEqual({ nonProgressCalls: 4, inject: false, exhaust: false });
    expect(d.observeStart("ls")).toEqual({ nonProgressCalls: 5, inject: false, exhaust: false });
    expect(d.observeStart("flair_search")).toEqual({
      nonProgressCalls: 6,
      inject: false,
      exhaust: true,
    });
  });

  for (const tool of [
    "write",
    "edit",
    "replace_lines",
    "write_file",
    "edit_lines",
    "insert_after",
  ]) {
    it(`${tool} credits a non-error end event with tool-specific success evidence`, () => {
      const d = new ExplorationBudgetDetector(2);
      d.observeStart("read");
      expect(d.observeStart(tool)).toEqual({ nonProgressCalls: 1, inject: false, exhaust: false });
      expect(d.observeEnd(tool, false, editResults[tool])).toEqual({
        nonProgressCalls: 0,
        inject: false,
        exhaust: false,
      });
      d.observeStart("read");
      d.observeStart(tool);
      expect(d.observeEnd(tool, true, editResults[tool])).toEqual({
        nonProgressCalls: 2,
        inject: true,
        exhaust: false,
      });
      d.observeStart(tool);
      expect(d.observeEnd(tool, undefined, editResults[tool]).nonProgressCalls).toBe(3);
      d.observeStart(tool);
      expect(d.observeEnd(tool, "false", editResults[tool])).toEqual({
        nonProgressCalls: 4,
        inject: false,
        exhaust: true,
      });
      d.observeEnd(tool, false, editResults[tool]);
      expect(d.observeStart("read").inject).toBe(false);
      expect(d.observeStart("read").inject).toBe(true);
    });

    it(`${tool} counts missing success evidence and refused non-error end events`, () => {
      const d = new ExplorationBudgetDetector(2);
      for (const result of [undefined, null, {}, { content: [] }]) {
        d.observeStart(tool);
        d.observeEnd(tool, false, result);
      }
      expect(d.nonProgressCalls).toBe(4);
      const evidence = editResults[tool] as { details?: object };
      expect(
        d.observeEnd(tool, false, {
          ...evidence,
          details: { ...evidence.details, refused: true },
        }),
      ).toEqual({ nonProgressCalls: 5, inject: false, exhaust: true });
    });
  }

  it("does not credit malformed success evidence", () => {
    const d = new ExplorationBudgetDetector(2);
    for (const [tool, result] of [
      ["edit", { ...editResults.edit, details: { diff: "" } }],
      [
        "edit_lines",
        { ...editResults.edit_lines, details: { fingerprint: "invalid", lineDelta: 1 } },
      ],
      [
        "insert_after",
        { ...editResults.insert_after, details: { fingerprint: "F#0123456789abcdef" } },
      ],
      [
        "write_file",
        { ...editResults.write_file, details: { fingerprint: "F#0123456789abcdef", bytes: -1 } },
      ],
      ["write", { content: [{ type: "text", text: "ERROR: write failed" }] }],
      ["replace_lines", { content: [{ type: "text", text: "No lines replaced" }] }],
    ] as const) {
      d.observeEnd(tool, false, result);
    }
    expect(d.nonProgressCalls).toBe(6);
  });

  it("ignores an inherited writer classification", () => {
    const prototype = Object.prototype;
    Object.defineProperty(prototype, "inherited_edit", { value: "writer", configurable: true });
    try {
      const d = new ExplorationBudgetDetector(2);
      d.observeStart("read");
      expect(d.observeStart("inherited_edit")).toEqual({
        nonProgressCalls: 2,
        inject: true,
        exhaust: false,
      });
      d.observeEnd("inherited_edit", false, editResults.edit);
      expect(d.nonProgressCalls).toBe(2);
    } finally {
      Reflect.deleteProperty(prototype, "inherited_edit");
    }
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
    expect(res.explorationBudgetExhausted).toEqual({ limit: 20, nonProgressCalls: 40 });
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
    expect(res.explorationBudgetExhausted).toEqual({ limit: 3, nonProgressCalls: 6 });
  }, 15_000);

  for (const error of [true, "unknown"] as const) {
    it(`edit-only end events with isError ${error} instruct and stop`, async () => {
      mkAgent("failed-edits", "builder-local", "  exploration_budget: 3");
      const fake = makeSession({
        calls: Array.from({ length: 6 }, () => ({ tool: "edit_lines", error })),
        resolve: true,
      });
      const res = await runAgent({
        name: "failed-edits",
        prompt: "do the task",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
      });
      expect(fake.steers).toEqual([EXPLORATION_INSTRUCTION]);
      expect(fake.steerCallCounts).toEqual([3]);
      expect(res.exitCode).toBe(1);
      expect(res.explorationBudgetExhausted).toEqual({ limit: 3, nonProgressCalls: 6 });
      expect(fake.aborts()).toBeGreaterThanOrEqual(1);
    });
  }

  it("repeated stale edit_lines refusals with isError false instruct and stop through runAgent", async () => {
    mkAgent("refused-edits", "builder-local", "  exploration_budget: 3");
    const h = makeHarness();
    try {
      writeFileSync(join(h.root, "f.ts"), "one\ntwo\nthree\nfour\n");
      const read = await h.call("read_lines", { path: "f.ts" });
      const anchor = h.anchor("f.ts", 1);
      const changed = "one\ntwo\nthree\nchanged elsewhere\n";
      writeFileSync(join(h.root, "f.ts"), changed);
      const calls: ScriptedCall[] = [];
      const edit = h.tools.get("edit_lines");
      if (!edit) throw new Error("edit_lines not registered");
      for (let i = 0; i < 6; i += 1) {
        const args = {
          path: "f.ts",
          from: anchor,
          to: anchor,
          new_text: `replacement ${i}`,
          fingerprint: read.details.fingerprint,
        };
        const result = await edit.execute(`refused-${i}`, args, undefined, undefined, {
          cwd: h.root,
        });
        expect(result.details).toEqual({ refused: true, signals: ["stale_anchor"] });
        calls.push({ tool: "edit_lines", error: false, args, result });
      }
      const fake = makeSession({ calls, resolve: true });
      const res = await runAgent({
        name: "refused-edits",
        prompt: "do the task",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
      });
      expect(readFileSync(join(h.root, "f.ts"), "utf8")).toBe(changed);
      expect({
        instructions: fake.steers,
        exitCode: res.exitCode,
        exhaustion: res.explorationBudgetExhausted,
      }).toEqual({
        instructions: [EXPLORATION_INSTRUCTION],
        exitCode: 1,
        exhaustion: { limit: 3, nonProgressCalls: 6 },
      });
      expect(fake.steerCallCounts).toEqual([3]);
      expect(res.loopBreaker).toBeUndefined();
      expect(res.failed).toBe(true);
      expect(fake.aborts()).toBeGreaterThanOrEqual(1);
    } finally {
      h.cleanup();
    }
  });

  it("edit_lines non-error end events without success evidence instruct and stop", async () => {
    mkAgent("empty-edits", "builder-local", "  exploration_budget: 3");
    const fake = makeSession({
      calls: Array.from({ length: 6 }, () => ({ tool: "edit_lines", error: false })),
      resolve: true,
    });
    const res = await runAgent({
      name: "empty-edits",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(fake.steers).toEqual([EXPLORATION_INSTRUCTION]);
    expect(fake.steerCallCounts).toEqual([3]);
    expect(res.exitCode).toBe(1);
    expect(res.explorationBudgetExhausted).toEqual({ limit: 3, nonProgressCalls: 6 });
  });

  for (const tool of ["run", "bash", "powershell"]) {
    for (const error of [false, true]) {
      it(`command-only ${tool} calls (isError: ${error}) instruct and stop through runAgent`, async () => {
        mkAgent("commands", "builder-local", "  exploration_budget: 3");
        const fake = makeSession({
          calls: Array.from({ length: 6 }, () => ({ tool, error })),
          resolve: true,
        });
        const res = await runAgent({
          name: "commands",
          prompt: "do the task",
          agentsRoot,
          sessionFactory: factoryReturning(fake.session),
        });
        expect(fake.steers).toEqual([EXPLORATION_INSTRUCTION]);
        expect(fake.steerCallCounts).toEqual([3]);
        expect(res.exitCode).toBe(1);
        expect(res.explorationBudgetExhausted).toEqual({ limit: 3, nonProgressCalls: 6 });
        expect(res.loopBreaker).toBeUndefined();
        expect(res.failed).toBe(true);
        expect(fake.aborts()).toBeGreaterThanOrEqual(1);
      });
    }
  }

  for (const tool of [
    "run_cancel",
    "flair_write",
    "web_fetch",
    "toString",
    "constructor",
    "not_a_real_tool",
  ]) {
    it(`non-error ${tool} end events never reset the budget through runAgent`, async () => {
      mkAgent("nonedit", "builder-local", "  exploration_budget: 3");
      const fake = makeSession({
        calls: Array.from({ length: 6 }, () => ["read_lines", { tool }]).flat(),
        resolve: true,
      });
      const res = await runAgent({
        name: "nonedit",
        prompt: "do the task",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
      });
      expect(fake.steers).toEqual([EXPLORATION_INSTRUCTION]);
      expect(fake.steerCallCounts).toEqual([3]);
      expect(res.exitCode).toBe(1);
      expect(res.explorationBudgetExhausted).toEqual({ limit: 3, nonProgressCalls: 6 });
      expect(res.failed).toBe(true);
      expect(fake.aborts()).toBeGreaterThanOrEqual(1);
    });
  }

  it("does not fire before the budget is reached", async () => {
    mkAgent("editor", "builder-local", "  exploration_budget: 5");
    const fake = makeSession({
      calls: ["read_lines", "read_lines", { tool: "edit_lines", result: editResults.edit_lines }],
      resolve: true,
    });
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

  it("a non-error edit_lines end event with success evidence resets the count (bob#281)", async () => {
    mkAgent("mixed", "builder-local", "  exploration_budget: 3");
    const fake = makeSession({
      calls: [
        "read_lines",
        "read_lines",
        { tool: "edit_lines", result: editResults.edit_lines },
        "read_lines",
        "read_lines",
      ],
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
    expect(res.explorationBudgetExhausted).toBeUndefined();
  }, 15_000);

  it("reads alternating with error edit end events still exhaust the budget (bob#281)", async () => {
    mkAgent("stale", "builder-local", "  exploration_budget: 3");
    const fake = makeSession({
      calls: [
        "read_lines",
        { tool: "edit_lines", error: true },
        "read_lines",
        { tool: "edit_lines", error: true },
        "read_lines",
        { tool: "edit_lines", error: true },
        "read_lines",
        { tool: "edit_lines", error: true },
        "read_lines",
        { tool: "edit_lines", error: true },
        "read_lines",
        { tool: "edit_lines", error: true },
      ],
      resolve: false,
    });
    const res = await runAgent({
      name: "stale",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(fake.steers).toEqual([EXPLORATION_INSTRUCTION]);
    expect(res.exitCode).toBe(1);
    expect(res.explorationBudgetExhausted).toEqual({ limit: 3, nonProgressCalls: 6 });
  }, 15_000);

  it("reads alternating with non-error run end events still exhaust the budget (bob#281)", async () => {
    mkAgent("shelling", "builder-local", "  exploration_budget: 3");
    const fake = makeSession({
      calls: [
        "read_lines",
        { tool: "run" },
        "read_lines",
        { tool: "run" },
        "read_lines",
        { tool: "run" },
        "read_lines",
        { tool: "run" },
        "read_lines",
        { tool: "run" },
        "read_lines",
        { tool: "run" },
      ],
      resolve: false,
    });
    const res = await runAgent({
      name: "shelling",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(fake.steers).toEqual([EXPLORATION_INSTRUCTION]);
    expect(res.exitCode).toBe(1);
    expect(res.explorationBudgetExhausted).toEqual({ limit: 3, nonProgressCalls: 6 });
  }, 15_000);

  it("reads alternating with an UNKNOWN tool name still exhaust the budget (bob#281)", async () => {
    mkAgent("unknown", "builder-local", "  exploration_budget: 3");
    // A name with no TOOL_EFFECTS row is not a change: it resets nothing.
    const fake = makeSession({
      calls: [
        "read_lines",
        { tool: "not_a_real_tool" },
        "read_lines",
        { tool: "not_a_real_tool" },
        "read_lines",
        { tool: "not_a_real_tool" },
        "read_lines",
        { tool: "not_a_real_tool" },
        "read_lines",
        { tool: "not_a_real_tool" },
        "read_lines",
        { tool: "not_a_real_tool" },
      ],
      resolve: false,
    });
    const res = await runAgent({
      name: "unknown",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(fake.steers).toEqual([EXPLORATION_INSTRUCTION]);
    expect(res.exitCode).toBe(1);
    expect(res.explorationBudgetExhausted).toEqual({ limit: 3, nonProgressCalls: 6 });
  }, 15_000);

  it("ends the run when the post-compaction continue turn exhausts the budget (#279)", async () => {
    // The first turn compacts and goes silent, so the run gets ONE continue
    // turn. That turn spends twice the budget in read-only calls and THEN ends a
    // message: the stop must fail the whole run, not be swallowed as a failed
    // continue turn and judged green by the message that followed it.
    mkAgent("retrying", "builder-local");
    const limit = BUILDER_LOCAL_EXPLORATION_BUDGET;
    const fake = makeSession({
      script: [
        (emit) => emit({ type: "compaction_end", reason: "threshold", aborted: false }),
        (emit) => {
          for (let i = 0; i < 2 * limit; i += 1) {
            emit({
              type: "tool_execution_start",
              toolCallId: `t${i}`,
              toolName: "read_lines",
              args: { path: `f${i}.ts` },
            });
          }
          emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              stopReason: "stop",
            },
          });
        },
      ],
    });
    const res = await runAgent({
      name: "retrying",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(res.exitCode).toBe(1);
    expect(res.explorationBudgetExhausted).toEqual({ limit, nonProgressCalls: 2 * limit });
    expect(fake.aborts()).toBeGreaterThanOrEqual(1);
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
    expect(res.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });

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

  it("skips a listed log that is not a regular file instead of blocking on it", () => {
    const runs = join(dir, "runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      join(runs, "a.jsonl"),
      [
        JSON.stringify({ t: "1", event: { type: "agent_start" } }),
        JSON.stringify({ t: "2", outcome: { reason: "tool_loop" } }),
      ].join("\n"),
    );
    // A NEWER entry that is a symlink to a FIFO with no writer: opening it for
    // reading would block doctor forever, so the last-run line must fall back to
    // the regular log.
    const fifo = join(dir, "blocked.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    symlinkSync(fifo, join(runs, "b.jsonl"));
    const future = Date.now() / 1000 + 60;
    utimesSync(fifo, future, future);
    const summary = readLastRunSummary(runs);
    expect(summary?.file).toBe("a.jsonl");
    expect(lastRunOutcomeReason(summary?.outcome)).toBe("tool_loop");
  }, 15_000);

  it("reports a missing or malformed outcome as 'no outcome recorded', never as success", () => {
    expect(lastRunOutcomeReason(undefined)).toBe("no outcome recorded");
    expect(lastRunOutcomeReason({})).toBe("no outcome recorded");
    expect(lastRunOutcomeReason({ reason: "" })).toBe("no outcome recorded");
    expect(lastRunOutcomeReason({ reason: "wall_clock" })).toBe("wall_clock");
  });

  it("parses the FIRST line of a log shorter than one chunk (bob#281)", () => {
    const runs = join(dir, "runs");
    mkdirSync(runs, { recursive: true });
    // A log small enough to be read in one chunk: the file STARTS on its first
    // line, so there is no earlier chunk for it to continue into and it must be
    // parsed like any other complete line.
    writeFileSync(
      join(runs, "short.jsonl"),
      [
        JSON.stringify({ t: "1", outcome: { reason: "wall_clock" } }),
        JSON.stringify({ done: true, exitCode: 1 }),
      ].join("\n"),
    );
    const summary = readLastRunSummary(runs);
    expect(summary?.file).toBe("short.jsonl");
    expect(lastRunOutcomeReason(summary?.outcome)).toBe("wall_clock");
    expect(summary?.exitCode).toBe(1);
  });

  it("parses a line whose multibyte character is split across a 64 KiB chunk boundary (bob#281)", () => {
    const runs = join(dir, "runs");
    mkdirSync(runs, { recursive: true });
    const CHUNK = 64 * 1024;
    const target = JSON.stringify({
      t: "2",
      outcome: { reason: "wall_clock", note: "é" },
    });
    const targetBytes = Buffer.from(target);
    const accentAt = targetBytes.indexOf(Buffer.from("é"));
    expect(accentAt).toBeGreaterThan(0);
    // Size the tail so the accent's SECOND byte is the first byte of the final
    // 64 KiB chunk: a reader that decodes each chunk on its own corrupts the
    // line that carries the outcome.
    const tailLen = CHUNK + accentAt - targetBytes.length;
    expect(tailLen).toBeGreaterThan(0);
    const tail = `${"b".repeat(tailLen - 1)}\n`;
    const file = Buffer.concat([targetBytes, Buffer.from(`\n${tail}`)]);
    // The construction is only meaningful if the boundary really splits the é.
    expect(file.length - CHUNK).toBe(accentAt + 1);
    writeFileSync(join(runs, "split.jsonl"), file);
    const summary = readLastRunSummary(runs);
    expect(summary?.file).toBe("split.jsonl");
    // The whole line decoded: the é survived, so the record parsed.
    expect(summary?.outcome).toEqual({ reason: "wall_clock", note: "é" });
    expect(lastRunOutcomeReason(summary?.outcome)).toBe("wall_clock");
  });
});

describe("doctor's last-run status for a run with no recorded outcome (bob#281)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-lastrun-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("follows the exit code: 0 with no recorded outcome is OK, non-zero is a warn", () => {
    const agentDir = join(root, "quiet");
    mkdirSync(join(agentDir, "runs"), { recursive: true });
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    writeFileSync(join(agentDir, "bob.yaml"), agentYaml("quiet", "builder-local"));
    writeFileSync(join(agentDir, "soul.md"), "You are a builder.");
    const log = join(agentDir, "runs", "a.jsonl");
    const lastRunOf = (exitCode: number): { status?: string; detail?: string } | undefined => {
      writeFileSync(log, `${JSON.stringify({ done: true, exitCode })}\n`);
      const report = runDoctor({ name: "quiet", agentsRoot: root, homeDir: root });
      return report.checks.find((c) => c.name === "last run");
    };
    // The reason is still "no outcome recorded"; the STATUS is the exit code's.
    const ok = lastRunOf(0);
    expect(ok?.status).toBe("ok");
    expect(ok?.detail).toContain("no outcome recorded");
    expect(ok?.detail).toContain("(exit 0)");
    const warn = lastRunOf(1);
    expect(warn?.status).toBe("warn");
    expect(warn?.detail).toContain("no outcome recorded");
    expect(warn?.detail).toContain("(exit 1)");
  }, 15_000);
});
