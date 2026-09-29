// A tiny scripted-model program for the work tests: a list of instructions the
// stub model walks, one tool call per model turn.
//
// Each instruction sees every tool result so far and returns
//   a Step          — emit it and move on,
//   { again: Step } — emit it and stay on this instruction (polling), or
//   null            — emit nothing here; move to the next instruction.

import type { Script, Step, ToolOutcome } from "./helpers.js";

export type Instr = Step | { again: Step } | null;
export type Instruction = (results: ToolOutcome[]) => Instr | Promise<Instr>;

export function program(...steps: Instruction[]): Script {
  let i = 0;
  return async (results) => {
    while (i < steps.length) {
      const out = await steps[i](results);
      if (out === null) {
        i += 1;
        continue;
      }
      if ("again" in out) return out.again;
      i += 1;
      return out;
    }
    return { text: "done" };
  };
}

export const call =
  (tool: string, args: Record<string, unknown> = {}): Instruction =>
  () => ({ tool, args });

// Call `tool` with args built from the results so far.
export const callWith =
  (tool: string, args: (r: ToolOutcome[]) => Record<string, unknown>): Instruction =>
  (r) => ({ tool, args: args(r) });

// Wait `ms` (the model "thinks"), then continue.
export const pause =
  (ms: number): Instruction =>
  async () => {
    await new Promise((r) => setTimeout(r, ms));
    return null;
  };

// Run an arbitrary side effect (a signal from outside, say), then continue.
export const effect =
  (fn: (r: ToolOutcome[]) => void | Promise<void>): Instruction =>
  async (r) => {
    await fn(r);
    return null;
  };

// Poll run_status for `runId` until it reports finished (bounded).
export function pollUntilFinished(runId: string | ((r: ToolOutcome[]) => string), limit = 250) {
  let polls = 0;
  return async (r: ToolOutcome[]): Promise<Instr> => {
    const last = r[r.length - 1];
    if (last && last.tool === "run_status" && last.details.state === "finished") return null;
    polls += 1;
    if (polls > limit) return { text: "gave up polling" };
    if (polls > 1) await new Promise((res) => setTimeout(res, 40));
    const id = typeof runId === "function" ? runId(r) : runId;
    return { again: { tool: "run_status", args: { run_id: id } } };
  };
}

// The details of the latest result of `tool` (or of any tool).
export function lastOf(results: ToolOutcome[], tool?: string): ToolOutcome {
  for (let i = results.length - 1; i >= 0; i--) {
    if (tool === undefined || results[i].tool === tool) return results[i];
  }
  throw new Error(`no ${tool ?? "tool"} result yet`);
}
