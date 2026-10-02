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
// fails the turn and asks the session to stop.

/** Default number of consecutive identical calls that trips the loop breaker. */
export const DEFAULT_TOOL_LOOP_LIMIT = 4;

/**
 * After a loop break, how long the runtime waits for what it asked to stop: the
 * loop-broken prompt (persistent admission) or the stop request (one-shot run).
 */
export const LOOP_ABORT_GRACE_MS = 1_000;

/**
 * A stable key for a call: the tool name and its arguments, which pi delivers
 * as parsed JSON. Object-key order is ignored; array order is not.
 */
export function toolCallKey(toolName: string, args: unknown): string {
  return `${toolName}\u0000${canonical(args)}`;
}

// The canonical form of a parsed JSON value: JSON with object keys sorted. It is
// written directly rather than by copying objects, because a plain `{}` copy
// drops an own `__proto__` key, which JSON.parse produces.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return String(JSON.stringify(value));
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
// `limit` times in a row, so the turn fails instead of looping. `toolName`
// names the repeated call for the message. Shared by the one-shot and
// persistent turn paths.
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

// The line the runtime logs when it breaks a repeated call. Names the call and
// points at a different mechanism.
export function loopBreakMessage(
  name: string,
  toolName: string,
  args: unknown,
  count: number,
): string {
  return `bob run ${name}: LOOP BREAKER — the same tool call repeated ${count} times in a row: ${toolName} ${summarizeArgs(args)}; failing the turn and asking the session to stop. Use a different mechanism (for example replace_lines for a line-based edit), or stop and report BLOCKED.\n`;
}
