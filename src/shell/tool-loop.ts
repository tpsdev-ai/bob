// tool-loop.ts — bob#143 item 3, the loop breaker, pure and testable.
//
// A local model can repeat the SAME tool call (identical name and arguments)
// for many turns: the issue's run issued the same `edit` and the same
// whitespace-inspection command 8-16 times each and never recovered. The
// runtime can observe the repetition even when the model does not.
//
// This detector counts CONSECUTIVE identical calls. Any call with a different
// name or different arguments resets the run of repeats to one — only an
// unbroken run of the same call fires. When the run reaches `limit` the caller
// ends the turn.

/** Default number of consecutive identical calls that ends a turn. */
export const DEFAULT_TOOL_LOOP_LIMIT = 4;

/** A stable key for a call: the tool name and its arguments, order-independent. */
export function toolCallKey(toolName: string, args: unknown): string {
  return `${toolName}\u0000${stableStringify(args)}`;
}

// JSON with object keys sorted, so two calls whose argument objects were built
// in a different key order are still the SAME call. Falls back to the raw
// string for a value JSON cannot encode.
function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(val as Record<string, unknown>).sort()) {
          sorted[key] = (val as Record<string, unknown>)[key];
        }
        return sorted;
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

export interface LoopObservation {
  /** Length of the current run of identical calls. */
  count: number;
  /** True when the run has reached the limit. */
  fire: boolean;
}

export class ToolLoopDetector {
  private readonly limit: number;
  private lastKey: string | undefined;
  private count = 0;

  constructor(limit: number = DEFAULT_TOOL_LOOP_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`tool loop limit must be a positive whole number (got ${limit})`);
    }
    this.limit = limit;
  }

  observe(toolName: string, args: unknown): LoopObservation {
    const key = toolCallKey(toolName, args);
    if (key === this.lastKey) this.count += 1;
    else {
      this.lastKey = key;
      this.count = 1;
    }
    return { count: this.count, fire: this.count >= this.limit };
  }

  reset(): void {
    this.lastKey = undefined;
    this.count = 0;
  }
}

// The error thrown into the awaited turn when the same call has repeated
// `limit` times in a row, so the turn ends instead of looping. `toolName` names
// the repeated call for the message. Shared by the one-shot and persistent turn
// paths, so both abort identically.
export class ToolLoopError extends Error {
  readonly toolName: string;
  readonly count: number;
  constructor(toolName: string, count: number) {
    super(`the tool call ${toolName} repeated ${count} times in a row`);
    this.name = "ToolLoopError";
    this.toolName = toolName;
    this.count = count;
  }
}

function summarizeArgs(args: unknown): string {
  if (args === undefined) return "(no arguments)";
  try {
    const json = JSON.stringify(args);
    if (json === undefined) return String(args);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return String(args);
  }
}

// The line the runtime logs when it ends a turn for a repeated call. Names the
// call and points at a different mechanism.
export function loopBreakMessage(
  name: string,
  toolName: string,
  args: unknown,
  count: number,
): string {
  return `bob run ${name}: LOOP BREAKER — the same tool call repeated ${count} times in a row: ${toolName} ${summarizeArgs(args)}; ending the turn. Use a different mechanism (for example replace_lines for a line-based edit), or stop and report BLOCKED.\n`;
}
