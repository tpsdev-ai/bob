// tool-loop.ts — bob#143 item 3, the loop breaker, pure and testable.
//
// A local model can repeat the SAME tool call (identical name and arguments)
// for many turns: the issue's run issued the same `edit` and the same
// whitespace-inspection command 8-16 times each and never recovered. The model
// cannot see its own repetition; the runtime can.
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
