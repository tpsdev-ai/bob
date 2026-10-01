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

/** A stable key for a call: the tool name and its arguments, independent of object-key order. */
export function toolCallKey(toolName: string, args: unknown): string {
  return `${toolName}\u0000${stableStringify(args)}`;
}

// A canonical string for a value, written directly rather than by rebuilding
// objects: every own enumerable key is kept, `__proto__` included (a plain `{}`
// copy would drop it). Object keys are sorted, so two calls whose argument
// objects were built in a different key order are still the SAME call; array
// order is kept. A value JSON has no form for (undefined, a non-finite number, a
// bigint, a symbol, a function) gets its own unquoted token, and a cycle is
// written as <circular>. If reading the value throws (a getter, a revoked
// proxy), the key is String(value). For a JSON value, which is what pi
// delivers, distinct content gives a distinct string.
function stableStringify(value: unknown): string {
  try {
    return canonical(value, new Set());
  } catch {
    return String(value);
  }
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (Object.is(value, -0)) return "-0";
      return Number.isFinite(value) ? JSON.stringify(value) : String(value);
    case "boolean":
      return String(value);
    case "undefined":
      return "undefined";
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "function":
      return "function";
  }
  const obj = value as object;
  if (ancestors.has(obj)) return "<circular>";
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => canonical(item, ancestors)).join(",")}]`;
    }
    const record = obj as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(obj);
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
