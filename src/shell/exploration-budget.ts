import { TOOL_EFFECTS } from "./tool-allowlist.js";

export const BUILDER_LOCAL_EXPLORATION_BUDGET = 20;

const COMMAND_RUNNER_TOOLS: ReadonlySet<string> = new Set(["run", "bash", "powershell"]);

function isFileEditTool(toolName: string): boolean {
  return (
    Object.hasOwn(TOOL_EFFECTS, toolName) &&
    TOOL_EFFECTS[toolName] === "writer" &&
    !COMMAND_RUNNER_TOOLS.has(toolName)
  );
}

export const EXPLORATION_INSTRUCTION =
  "You have made tool calls without a successful file-edit tool result. Make the edit now, or stop and report BLOCKED with what is missing.";

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

  observeEnd(toolName: string, isError: unknown): ExplorationObservation {
    if (isFileEditTool(toolName)) {
      if (isError !== false) return this.countNonProgress();
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
    super(`the run made ${nonProgressCalls} non-progress tool calls (budget ${limit})`);
    this.name = "ExplorationBudgetExhaustedError";
    this.limit = limit;
    this.nonProgressCalls = nonProgressCalls;
  }
}

export function explorationInstructionMessage(name: string, nonProgressCalls: number): string {
  return `bob run ${name}: EXPLORATION BUDGET — ${nonProgressCalls} non-progress tool calls; instructing the model to make the edit now, or report BLOCKED with what is missing.\n`;
}

export function explorationExhaustedMessage(
  name: string,
  limit: number,
  nonProgressCalls: number,
): string {
  return `bob run ${name}: EXPLORATION BUDGET EXHAUSTED — ${nonProgressCalls} non-progress tool calls (budget ${limit}), so the run was ended (exit 1). Give the task an exact edit, or raise it with run.exploration_budget in bob.yaml or exploration_budget in the role's role.json.\n`;
}
