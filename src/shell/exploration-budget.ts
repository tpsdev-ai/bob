import { isFileEditTool, isVerifiedFileEdit } from "./edit-evidence.js";

export const BUILDER_LOCAL_EXPLORATION_BUDGET = 20;

export const EXPLORATION_INSTRUCTION =
  "You have made tool calls since the last credited edit. Make the edit now, or stop and report BLOCKED with what is missing.";

export class ExplorationBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplorationBudgetError";
  }
}

export function parseExplorationBudget(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

export interface ExplorationObservation {
  nonProgressCalls: number;
  inject: boolean;
  exhaust: boolean;
}

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

  observeStart(toolName: string): ExplorationObservation {
    if (isFileEditTool(toolName)) {
      return { nonProgressCalls: this.count, inject: false, exhaust: false };
    }
    return this.countNonProgress();
  }

  observeEnd(toolName: string, isError: unknown, result: unknown): ExplorationObservation {
    if (isFileEditTool(toolName)) {
      if (!isVerifiedFileEdit(toolName, isError, result)) {
        return this.countNonProgress();
      }
      this.count = 0;
    }
    return { nonProgressCalls: this.count, inject: false, exhaust: false };
  }

  private countNonProgress(): ExplorationObservation {
    this.count += 1;
    return {
      nonProgressCalls: this.count,
      inject: this.count === this.limit,
      exhaust: this.count >= this.limit * 2,
    };
  }

  get nonProgressCalls(): number {
    return this.count;
  }
}

export class ExplorationBudgetExhaustedError extends Error {
  readonly limit: number;
  readonly nonProgressCalls: number;
  constructor(limit: number, nonProgressCalls: number) {
    super(
      `the run made ${nonProgressCalls} tool calls since the last credited edit (budget ${limit})`,
    );
    this.name = "ExplorationBudgetExhaustedError";
    this.limit = limit;
    this.nonProgressCalls = nonProgressCalls;
  }
}

export function explorationInstructionMessage(name: string, nonProgressCalls: number): string {
  return `bob run ${name}: EXPLORATION BUDGET — ${nonProgressCalls} tool calls since the last credited edit; attempting the edit-or-BLOCKED instruction.\n`;
}

export function explorationExhaustedMessage(
  name: string,
  limit: number,
  nonProgressCalls: number,
): string {
  return `bob run ${name}: EXPLORATION BUDGET EXHAUSTED — ${nonProgressCalls} tool calls since the last credited edit (budget ${limit}), so the run was ended (exit 1). Give the task an exact edit, or raise it with run.exploration_budget in bob.yaml or exploration_budget in the role's role.json.\n`;
}
