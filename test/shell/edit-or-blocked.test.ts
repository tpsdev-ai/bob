import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/shell/doctor.js";
import {
  hasEditSuccessEvidence,
  isFileEditTool,
  isVerifiedEdit,
} from "../../src/shell/edit-evidence.js";
import { EXPLORATION_INSTRUCTION } from "../../src/shell/exploration-budget.js";
import { loadRole } from "../../src/shell/role-loader.js";
import {
  type RunSession,
  type RunSessionFactory,
  resolveRequireEditOrBlocked,
  runAgent,
  runLaunch,
} from "../../src/shell/run.js";

const EDIT_LINES_OK = {
  content: [{ type: "text", text: "edited f0.ts" }],
  details: { fingerprint: "F#0123456789abcdef", lineCount: 8, lineDelta: 2, signals: [] },
};
const WRITE_FILE_OK = {
  content: [{ type: "text", text: "created f0.ts" }],
  details: { fingerprint: "F#fedcba9876543210", bytes: 12, signals: [] },
};
const PI_EDIT_OK = {
  content: [{ type: "text", text: "Successfully replaced 1 block(s) in f0.ts." }],
  details: { diff: "-a\n+b", patch: "", firstChangedLine: 1 },
};
const PI_WRITE_OK = {
  content: [{ type: "text", text: "Successfully wrote 12 bytes to f0.ts" }],
  details: undefined,
};
const REPLACE_LINES_OK = {
  content: [{ type: "text", text: "Replaced lines 3-4 in f0.ts." }],
  details: undefined,
};
const READ_LINES_OK = {
  content: [{ type: "text", text: "1\tone" }],
  details: { fingerprint: "F#0123456789abcdef", lineCount: 8, signals: [] },
};

// A fabricated AgentSession matching the RunSession seam: prompt() emits the
// scripted tool calls (a start and its end, so the result is observed), then
// ends one assistant message with the run's final text.
function makeSession(opts: {
  calls?: Array<{ toolName: string; result?: unknown; isError?: unknown }>;
  finalText?: string;
}): { session: RunSession; aborts: () => number; steers: string[] } {
  const listeners: Array<(event: unknown) => void> = [];
  const steers: string[] = [];
  let aborts = 0;
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
      for (const call of opts.calls ?? []) {
        // Varying args keep the loop breaker (identical calls) out of the way.
        emit({
          type: "tool_execution_start",
          toolCallId: `t${i}`,
          toolName: call.toolName,
          args: { path: `f${i}.ts` },
        });
        emit({
          type: "tool_execution_end",
          toolCallId: `t${i}`,
          toolName: call.toolName,
          result: call.result,
          isError: Object.hasOwn(call, "isError") ? call.isError : false,
        });
        i += 1;
      }
      if (opts.finalText !== undefined) {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: opts.finalText }],
            stopReason: "stop",
          },
        });
      }
      return;
    },
    async steer(text) {
      steers.push(text);
    },
    async abort() {
      aborts += 1;
    },
    dispose() {
      // no-op
    },
  };
  return { session, aborts: () => aborts, steers };
}

function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
}

function agentYaml(name: string, role: string, tool: string): string {
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
    `    - ${tool}`,
  ].join("\n");
}

describe("the verified-edit predicate", () => {
  it("accepts each file-edit tool's own success evidence", () => {
    expect(isVerifiedEdit("edit_lines", false, EDIT_LINES_OK)).toBe(true);
    expect(isVerifiedEdit("insert_after", false, EDIT_LINES_OK)).toBe(true);
    expect(isVerifiedEdit("write_file", false, WRITE_FILE_OK)).toBe(true);
    expect(isVerifiedEdit("edit", false, PI_EDIT_OK)).toBe(true);
    expect(isVerifiedEdit("write", false, PI_WRITE_OK)).toBe(true);
    expect(isVerifiedEdit("replace_lines", false, REPLACE_LINES_OK)).toBe(true);
    expect(isFileEditTool("edit_lines")).toBe(true);
  });

  for (const [tool, result] of [
    ["edit_lines", EDIT_LINES_OK],
    ["insert_after", EDIT_LINES_OK],
    ["write_file", WRITE_FILE_OK],
    ["edit", PI_EDIT_OK],
    ["write", PI_WRITE_OK],
    ["replace_lines", REPLACE_LINES_OK],
  ] as const) {
    it(`${tool} rejects missing content`, () => {
      const { content: _content, ...missing } = result;
      expect(isVerifiedEdit(tool, false, missing)).toBe(false);
    });

    it.each([
      ["undefined", undefined],
      ["null", null],
      ["string", "success"],
      ["object", { type: "text", text: "success" }],
      ["empty array", []],
      ["null block", [null]],
      ["string block", ["success"]],
      ["missing type", [{ text: "success" }]],
      ["wrong type", [{ type: "image", text: "success" }]],
      ["missing text", [{ type: "text" }]],
      ["numeric text", [{ type: "text", text: 12 }]],
      ["blank text", [{ type: "text", text: "  " }]],
      ["malformed trailing block", [...result.content, { type: "text", text: 12 }]],
    ])(`${tool} rejects malformed content: %s`, (_label, content) => {
      expect(isVerifiedEdit(tool, false, { ...result, content })).toBe(false);
    });

    it.each([[null], [false], ["details"], [[]]])(
      `${tool} rejects malformed details: %p`,
      (details) => {
        expect(isVerifiedEdit(tool, false, { ...result, details })).toBe(false);
      },
    );
  }

  it("does not count an error, a refusal, a command, a read or an unknown name", () => {
    expect(isVerifiedEdit("edit_lines", true, EDIT_LINES_OK)).toBe(false);
    expect(
      isVerifiedEdit("edit_lines", false, {
        content: [{ type: "text", text: "refused" }],
        details: { fingerprint: "F#0123456789abcdef", lineDelta: 2, refused: true },
      }),
    ).toBe(false);
    expect(isVerifiedEdit("run", false, PI_WRITE_OK)).toBe(false);
    expect(isVerifiedEdit("bash", false, PI_WRITE_OK)).toBe(false);
    expect(isVerifiedEdit("powershell", false, PI_WRITE_OK)).toBe(false);
    expect(isVerifiedEdit("read_lines", false, READ_LINES_OK)).toBe(false);
    expect(isVerifiedEdit("flair_write", false, PI_WRITE_OK)).toBe(false);
    expect(isVerifiedEdit("not_a_real_tool", false, PI_WRITE_OK)).toBe(false);
    expect(isFileEditTool("run")).toBe(false);
    expect(isFileEditTool("not_a_real_tool")).toBe(false);
  });

  it("does not count a malformed result, whatever the name", () => {
    expect(hasEditSuccessEvidence("edit_lines", undefined)).toBe(false);
    expect(hasEditSuccessEvidence("edit_lines", {})).toBe(false);
    expect(
      hasEditSuccessEvidence("edit_lines", {
        ...EDIT_LINES_OK,
        details: { fingerprint: "not-a-fingerprint", lineDelta: 1 },
      }),
    ).toBe(false);
    expect(
      hasEditSuccessEvidence("edit_lines", {
        ...EDIT_LINES_OK,
        details: { fingerprint: "F#0123456789abcdef" },
      }),
    ).toBe(false);
    expect(
      hasEditSuccessEvidence("write_file", {
        ...WRITE_FILE_OK,
        details: { fingerprint: "F#0123456789abcdef", bytes: -1 },
      }),
    ).toBe(false);
    expect(
      hasEditSuccessEvidence("write", {
        content: [{ type: "text", text: "Successfully wrote some bytes to f0.ts" }],
      }),
    ).toBe(false);
    expect(
      hasEditSuccessEvidence("write", {
        content: [{ type: "text", text: "Successfully wrote 12 bytes to f0.ts" }],
      }),
    ).toBe(true);
    expect(
      hasEditSuccessEvidence("replace_lines", {
        content: [{ type: "text", text: "Replaced lines 3-4 in f0.ts" }],
      }),
    ).toBe(false);
    expect(hasEditSuccessEvidence("edit", { ...PI_EDIT_OK, details: { diff: "   " } })).toBe(false);
    expect(hasEditSuccessEvidence("edit", { ...PI_EDIT_OK, details: { diff: "-a\n+b" } })).toBe(
      true,
    );
  });
});

describe("resolveRequireEditOrBlocked", () => {
  it("reads the role opt-in: builder-local true, another role false", () => {
    expect(resolveRequireEditOrBlocked(agentYaml("b", "builder-local", "read_lines"))).toBe(true);
    expect(resolveRequireEditOrBlocked(agentYaml("c", "coder", "read"))).toBe(false);
    expect(loadRole("builder-local").require_edit_or_blocked).toBe(true);
    expect(loadRole("coder").require_edit_or_blocked).toBeUndefined();
  });
});

describe("builder-local runAgent: an edit or a BLOCKED report", () => {
  let agentsRoot: string;

  const mkAgent = (name: string, role: string, tool: string): void => {
    const agentDir = join(agentsRoot, name);
    mkdirSync(join(agentDir, "work"), { recursive: true });
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    writeFileSync(join(agentDir, "bob.yaml"), agentYaml(name, role, tool));
    writeFileSync(join(agentDir, "soul.md"), "You are a builder.");
  };

  const lastOutcomeReason = (name: string): string | undefined => {
    const runsDir = join(agentsRoot, name, "runs");
    const logs = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));
    expect(logs.length).toBe(1);
    const lines = readFileSync(join(runsDir, logs[0]), "utf8").split("\n").filter(Boolean);
    const outcomes = lines
      .map((l) => JSON.parse(l) as { outcome?: { reason?: string } })
      .filter((r) => r.outcome !== undefined);
    return outcomes.at(-1)?.outcome?.reason;
  };

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-edit-or-blocked-"));
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  it("the budget and completion gate agree on refused, failed, successful and command results", async () => {
    for (const [name, toolName, isError, result, accepted] of [
      [
        "refused",
        "edit_lines",
        false,
        { ...EDIT_LINES_OK, details: { ...EDIT_LINES_OK.details, refused: true } },
        false,
      ],
      ["failed", "edit_lines", true, EDIT_LINES_OK, false],
      ["successful", "edit_lines", false, EDIT_LINES_OK, true],
      ["command", "run", false, EDIT_LINES_OK, false],
      ["missing-error", "edit_lines", undefined, EDIT_LINES_OK, false],
      ["null-error", "edit_lines", null, EDIT_LINES_OK, false],
      ["string-error", "edit_lines", "false", EDIT_LINES_OK, false],
      ["numeric-error", "edit_lines", 0, EDIT_LINES_OK, false],
      ["missing-content", "edit_lines", false, { details: EDIT_LINES_OK.details }, false],
      ["malformed-content", "edit_lines", false, { ...EDIT_LINES_OK, content: "edited" }, false],
    ] as const) {
      mkAgent(name, "builder-local", toolName);
      const fake = makeSession({
        calls: [
          { toolName: "read_lines", result: READ_LINES_OK },
          { toolName, isError, result },
        ],
        finalText: "Here is the final report.",
      });
      const res = await runAgent({
        name,
        prompt: "do the task",
        agentsRoot,
        explorationBudget: 2,
        sessionFactory: factoryReturning(fake.session),
      });
      expect(fake.steers).toEqual(accepted ? [] : [EXPLORATION_INSTRUCTION]);
      expect(res.exitCode).toBe(accepted ? 0 : 1);
      expect(res.noEditNoBlocked).toBe(accepted ? undefined : true);
      expect(res.explorationBudgetExhausted).toBeUndefined();
      expect(lastOutcomeReason(name)).toBe(accepted ? undefined : "no_edit_no_blocked");
    }
  }, 15_000);

  it("exits non-zero with no_edit_no_blocked for a plan with no edit", async () => {
    mkAgent("planner", "builder-local", "read_lines");
    const fake = makeSession({
      calls: [{ toolName: "read_lines", result: READ_LINES_OK }],
      finalText: "Here is the plan: I will edit f0.ts in the next turn.",
    });
    const res = await runAgent({
      name: "planner",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(res.exitCode).toBe(1);
    expect(res.noEditNoBlocked).toBe(true);
    expect(res.failed).toBeUndefined();
    expect(lastOutcomeReason("planner")).toBe("no_edit_no_blocked");
  }, 15_000);

  it("completes normally when the run made a verified edit", async () => {
    mkAgent("editor", "builder-local", "edit_lines");
    const fake = makeSession({
      calls: [{ toolName: "edit_lines", result: EDIT_LINES_OK }],
      finalText: "Edited f0.ts and it passes.",
    });
    const res = await runAgent({
      name: "editor",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(res.exitCode).toBe(0);
    expect(res.noEditNoBlocked).toBeUndefined();
    expect(lastOutcomeReason("editor")).toBeUndefined();
  }, 15_000);

  it("exits as a BLOCKED report when the run ends in BLOCKED with no edit", async () => {
    mkAgent("blocked", "builder-local", "read_lines");
    const fake = makeSession({
      calls: [{ toolName: "read_lines", result: READ_LINES_OK }],
      finalText: "BLOCKED: f0.ts has no anchor for the line I must change.",
    });
    const res = await runAgent({
      name: "blocked",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(res.exitCode).toBe(0);
    expect(res.noEditNoBlocked).toBeUndefined();
    expect(lastOutcomeReason("blocked")).toBeUndefined();
  }, 15_000);

  it.each(["BLOCKEDNESS is not a report.", "BLOCKED-glued text is not a report."])(
    "rejects a BLOCKED prefix without a standalone token: %s",
    async (finalText) => {
      mkAgent("prefix", "builder-local", "read_lines");
      const fake = makeSession({ finalText });
      const res = await runAgent({
        name: "prefix",
        prompt: "do the task",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
      });
      expect(res.exitCode).toBe(1);
      expect(res.noEditNoBlocked).toBe(true);
      expect(lastOutcomeReason("prefix")).toBe("no_edit_no_blocked");
    },
    15_000,
  );

  it.each(["BLOCKED", "BLOCKED missing input.", "BLOCKED\nMissing input."])(
    "accepts a standalone BLOCKED opening token: %s",
    async (finalText) => {
      mkAgent("token", "builder-local", "read_lines");
      const fake = makeSession({ finalText });
      const res = await runAgent({
        name: "token",
        prompt: "do the task",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
      });
      expect(res.exitCode).toBe(0);
      expect(res.noEditNoBlocked).toBeUndefined();
    },
    15_000,
  );

  it.each([
    ["plan", "I will edit next.", false, 1],
    ["blocked", "BLOCKED: missing input.", false, 0],
    ["edited", "Edited f0.ts.", true, 0],
  ] as const)(
    "launch with a prompt applies the gate: %s",
    async (name, finalText, edited, code) => {
      mkAgent(name, "builder-local", "edit_lines");
      const fake = makeSession({
        finalText,
        calls: edited ? [{ toolName: "edit_lines", result: EDIT_LINES_OK }] : [],
      });
      expect(
        await runLaunch({
          name,
          prompt: "do the task",
          agentsRoot,
          sessionFactory: factoryReturning(fake.session),
        }),
      ).toBe(code);
      expect(lastOutcomeReason(name)).toBe(code === 1 ? "no_edit_no_blocked" : undefined);
    },
    15_000,
  );

  it("launch without a prompt uses the interactive path", async () => {
    mkAgent("interactive", "builder-local", "read_lines");
    let opened = false;
    expect(
      await runLaunch({
        name: "interactive",
        agentsRoot,
        sessionFactory: async () => {
          throw new Error("unexpected one-shot run");
        },
        interactive: async () => {
          opened = true;
          return 0;
        },
      }),
    ).toBe(0);
    expect(opened).toBe(true);
  }, 15_000);

  it("preserves an earlier completion failure", async () => {
    mkAgent("shape", "builder-local", "read_lines");
    const fake = makeSession({ finalText: "Here is the plan." });
    const res = await runAgent({
      name: "shape",
      prompt: "do the task",
      agentsRoot,
      expectedFinal: (text) => text.startsWith("DONE"),
      sessionFactory: factoryReturning(fake.session),
    });
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("final_shape_mismatch");
    expect(res.noEditNoBlocked).toBeUndefined();
    expect(lastOutcomeReason("shape")).not.toBe("no_edit_no_blocked");
  }, 15_000);

  it("enforces the gate even when the run log cannot be created", async () => {
    mkAgent("unlogged", "builder-local", "read_lines");
    const runsPath = join(agentsRoot, "unlogged", "runs");
    writeFileSync(runsPath, "not a directory");
    const fake = makeSession({ finalText: "Here is the plan." });
    const res = await runAgent({
      name: "unlogged",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(res.exitCode).toBe(1);
    expect(res.noEditNoBlocked).toBe(true);
    expect(readFileSync(runsPath, "utf8")).toBe("not a directory");
  }, 15_000);

  it("does not count a refused edit: a plan after it is still no_edit_no_blocked", async () => {
    mkAgent("refused", "builder-local", "edit_lines");
    const fake = makeSession({
      calls: [
        {
          toolName: "edit_lines",
          result: {
            content: [{ type: "text", text: "refused: the fingerprint is stale" }],
            details: { refused: true, reason: "stale fingerprint" },
          },
          isError: true,
        },
      ],
      finalText: "Here is the plan: I will re-read and retarget the edit.",
    });
    const res = await runAgent({
      name: "refused",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(res.exitCode).toBe(1);
    expect(res.noEditNoBlocked).toBe(true);
    expect(lastOutcomeReason("refused")).toBe("no_edit_no_blocked");
  }, 15_000);

  it("leaves a role without the opt-in unchanged", async () => {
    mkAgent("coderagent", "coder", "read");
    const fake = makeSession({
      calls: [{ toolName: "read", result: READ_LINES_OK }],
      finalText: "Here is the plan: I will edit f0.ts in the next turn.",
    });
    const res = await runAgent({
      name: "coderagent",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    expect(res.exitCode).toBe(0);
    expect(res.noEditNoBlocked).toBeUndefined();
  }, 15_000);

  it("names the outcome and its fix in doctor's last-run line", async () => {
    mkAgent("doctorrun", "builder-local", "read_lines");
    const fake = makeSession({
      calls: [{ toolName: "read_lines", result: READ_LINES_OK }],
      finalText: "Here is the plan.",
    });
    await runAgent({
      name: "doctorrun",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
    });
    const report = runDoctor({ name: "doctorrun", agentsRoot, homeDir: agentsRoot });
    const lastRun = report.checks.find((c) => c.name === "last run");
    expect(lastRun?.detail).toContain("no_edit_no_blocked");
    expect(lastRun?.status).toBe("warn");
    expect(lastRun?.fix).toContain("BLOCKED");
    expect(lastRun?.fix).toContain("no verified edit evidence");
  }, 15_000);
});
