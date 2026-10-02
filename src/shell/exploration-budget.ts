// bob#279 — the exploration budget for a run that is only reading.
//
// On local models a builder run can spend its whole deadline reading: three
// measured runs issued 58, 90 and 88 tool calls and ended with no edit (or a
// constant and a stats field), each last message a plan to start editing. Prose
// in the brief did not change that — the runtime can see what the model does not
// report.
//
// This counts CONSECUTIVE read-only tool calls with no write-class call. A call
// is read-only when its row in tool-allowlist.ts's TOOL_EFFECTS is `read-only`
// (read, read_lines, grep, find, ls, run_status, flair_search, flair_get, ...).
// EVERY other call — a writer, an effect, an egress tool, or a name with no row
// — is write-class and RESETS the count: it is a change or a report, not more
// reading. `run` is a writer row (`work` runs a command), so a `run` call is
// write-class, never read-only.
//
// At `limit` consecutive read-only calls the runtime injects ONE fixed
// instruction into the next turn (EXPLORATION_INSTRUCTION): make the edit now,
// or report BLOCKED with what is missing. At `2 * limit` calls with still no
// write-class call the budget is EXHAUSTED and the run ends with the distinct
// outcome `exploration_budget_exhausted` — never a silent timeout. A write-class
// call resets the count, so a run that edits and then explores again gets a
// fresh budget.
//
// The limit is per role (role.json `exploration_budget`) and per agent (bob.yaml
// `run.exploration_budget`, which overrides the role). A role that names none —
// every role but `builder-local` — leaves the budget OFF: a run that is meant to
// read and report (a reviewer, an assistant) must not be told to edit.

import { TOOL_EFFECTS } from "./tool-allowlist.js";

/**
 * The exploration budget `builder-local` ships (roles/builder-local/role.json
 * `exploration_budget`): consecutive read-only calls before the runtime injects
 * its instruction, and again before the run ends. The default the issue names
 * for that role.
 */
export const BUILDER_LOCAL_EXPLORATION_BUDGET = 20;

/**
 * The ONE instruction the runtime injects when the budget is reached. It is
 * FIXED: the same text every time, carrying no count, no path and no workspace
 * data, so it is not a channel the model can steer.
 */
export const EXPLORATION_INSTRUCTION =
  "You have been reading without editing. Make the edit now, or stop and report BLOCKED with what is missing.";

/** A budget or outcome value bob refuses, naming the source and the fix. */
export class ExplorationBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplorationBudgetError";
  }
}

/**
 * A positive whole number of calls, or undefined for "not one". The role.json
 * reader refuses a role that names a budget in any other shape, naming the file.
 */
export function parseExplorationBudget(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

/** One observation of a tool call. */
export interface ExplorationObservation {
  /**
   * Length of the current run of consecutive read-only calls (0 after a
   * write-class call).
   */
  readOnlyCalls: number;
  /** True when this call reached the limit and the instruction is due. */
  inject: boolean;
  /** True when this call reached twice the limit and the run must end. */
  exhaust: boolean;
}

/**
 * Counts consecutive read-only tool calls. Constructed only when a role or agent
 * configures the budget; a limit is a positive whole number.
 */
export class ExplorationBudgetDetector {
  readonly limit: number;
  private count = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ExplorationBudgetError(
        `exploration budget must be a positive whole number (got ${limit})`,
      );
    }
    this.limit = limit;
  }

  observe(toolName: string): ExplorationObservation {
    if (TOOL_EFFECTS[toolName] !== "read-only") {
      // A write-class call (or a name with no row): the run did something other
      // than read, so the run of read-only calls is over.
      this.count = 0;
      return { readOnlyCalls: 0, inject: false, exhaust: false };
    }
    this.count += 1;
    return {
      readOnlyCalls: this.count,
      // The instruction fires ONCE per run of read-only calls, at the limit.
      inject: this.count === this.limit,
      // And the run ends if the same run of reads reaches twice the limit.
      exhaust: this.count >= this.limit * 2,
    };
  }

  /** Read-only calls in the current run (0 when none). */
  get readOnlyCalls(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
  }
}

/**
 * Thrown into the awaited turn when the exploration budget is exhausted, so the
 * turn fails and the run ends non-zero instead of reading until a bound fires.
 */
export class ExplorationBudgetExhaustedError extends Error {
  readonly limit: number;
  readonly readOnlyCalls: number;
  constructor(limit: number, readOnlyCalls: number) {
    super(
      `the run made ${readOnlyCalls} read-only tool calls in a row (budget ${limit}) with no edit`,
    );
    this.name = "ExplorationBudgetExhaustedError";
    this.limit = limit;
    this.readOnlyCalls = readOnlyCalls;
  }
}

/** The line the runtime logs when it injects the instruction. */
export function explorationInstructionMessage(name: string, readOnlyCalls: number): string {
  return `bob run ${name}: EXPLORATION BUDGET — ${readOnlyCalls} read-only tool calls in a row with no edit; instructing the model to make the edit now, or report BLOCKED with what is missing.\n`;
}

/** The line the runtime logs when it ends the run on an exhausted budget. */
export function explorationExhaustedMessage(
  name: string,
  limit: number,
  readOnlyCalls: number,
): string {
  return `bob run ${name}: EXPLORATION BUDGET EXHAUSTED — ${readOnlyCalls} read-only tool calls in a row with no edit (budget ${limit}), so the run was ended (exit 1). Give the task an exact edit, or raise it with run.exploration_budget in bob.yaml or exploration_budget in the role's role.json.\n`;
}
