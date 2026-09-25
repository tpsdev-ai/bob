// The compaction contract (issue #145).
//
// A bob run that hits pi's threshold compaction used to lose its own plan — the
// model's "commit next" lived only in the conversation being summarized — and
// then settle `done: true, exitCode 0` with the work uncommitted and no final
// message. From the outside that is indistinguishable from a clean completion.
//
// This module is the fix, in two halves:
//
//   1. AFTER EVERY compaction, re-inject ONE bounded "pinned block": the original
//      task (a one-shot `bob run`) or the agent's standing contract (the
//      persistent runtime), plus "what remains" — the last plan the agent stated,
//      or a generated note describing the worktree (git status --short) and the
//      last few tool calls. The block is capped so the re-injection can never be
//      the thing that tips the context back over the threshold.
//   2. The completion contract for a one-shot run: it settles `exitCode 0` only
//      with a NON-EMPTY final assistant message (and matches an expected shape
//      when one is declared). Settling silently after a compaction retries ONCE
//      with an explicit "continue from the state above" turn; if it still settles
//      without meeting the contract the run exits non-zero with a named reason
//      (`settled_after_compaction` / `no_final_message`). Never exit 0 for
//      silence.
//
// Everything here is pure/injectable so it is unit-testable without pi: the
// session wiring lives in run.ts / persistent.ts and passes the event stream in.

import { spawnSync } from "node:child_process";

/** Cap on the re-injected pinned block, in characters. Generous enough to carry
 *  a task + a plan, small enough that the re-injection cannot itself trip the
 *  context threshold. The cap is named in the block's own header. */
export const DEFAULT_PINNED_CAP_CHARS = 6000;

/** How many recent tool calls the generated worktree note lists. */
export const DEFAULT_RECENT_TOOL_CALLS = 5;

/** How many `git status --short` lines the generated worktree note lists. */
export const DEFAULT_WORKTREE_STATUS_LINES = 30;

/** The named reasons a one-shot run may refuse to report success. */
export type SilenceReason = "settled_after_compaction" | "no_final_message";

/** The explicit continue turn sent as the single retry. */
export const CONTINUE_TURN =
  "[BOB CONTINUE — the previous turn ended without a final message after a context compaction]\n" +
  "Context was compacted and your last turn ended silently. Continue from the state above: " +
  "restate what remains in one line, finish the task, and end with a final message describing " +
  "the outcome (including any commit/push the task asked for).";

/** Truncate `text` to `cap` characters, marking the cut. */
export function capText(text: string, cap: number): string {
  if (cap <= 0 || text.length <= cap) return text;
  const marker = "\n… [truncated]";
  return text.slice(0, Math.max(0, cap - marker.length)) + marker;
}

/** The "what remains" inputs: the last plan the agent stated, and/or the
 *  generated worktree state (git status + recent tool calls). */
export interface RemainingState {
  /** The agent's own last stated plan/todo, when bob captured one. */
  lastStatedPlan?: string;
  /** `git status --short` output for the agent's worktree ("" outside a repo). */
  gitStatus?: string;
  /** The most recent tool calls, oldest → newest, as short labels. */
  recentToolCalls?: readonly string[];
}

/** Render the generated worktree-state note (used when no plan was captured). */
export function renderWorktreeNote(
  state: RemainingState,
  opts: { statusLines?: number; toolCalls?: number } = {},
): string {
  const statusLines = opts.statusLines ?? DEFAULT_WORKTREE_STATUS_LINES;
  const toolCalls = opts.toolCalls ?? DEFAULT_RECENT_TOOL_CALLS;
  const lines: string[] = ["No plan was captured before the compaction. Worktree state:"];

  const status = (state.gitStatus ?? "").trim();
  if (status.length === 0) {
    lines.push("  git status --short: (clean, or not a git worktree)");
  } else {
    const shown = status.split("\n").slice(0, statusLines);
    lines.push("  git status --short:");
    for (const l of shown) lines.push(`    ${l}`);
    const total = status.split("\n").length;
    if (total > shown.length) lines.push(`    … (${total - shown.length} more path(s))`);
  }

  const calls = (state.recentToolCalls ?? []).slice(-toolCalls);
  lines.push(
    calls.length > 0
      ? `  last ${calls.length} tool call(s): ${calls.join(", ")}`
      : "  last tool calls: (none observed)",
  );
  return lines.join("\n");
}

/** Build the ONE pinned block re-injected after a compaction. Bounded by
 *  `capChars`. `task` (one-shot) and `standingContract` (persistent) are
 *  mutually exclusive; whichever is set is the contract that is restored. */
export function buildPinnedBlock(opts: {
  task?: string;
  standingContract?: string;
  state: RemainingState;
  capChars?: number;
  /** The compaction reason (threshold/overflow/manual), for the header. */
  reason?: string;
  /** 1-based compaction counter, for the header. */
  count?: number;
}): string {
  const cap = opts.capChars ?? DEFAULT_PINNED_CAP_CHARS;
  const contractLabel = opts.standingContract !== undefined ? "STANDING CONTRACT" : "TASK";
  const contract = (opts.standingContract ?? opts.task ?? "").trim();
  const heading =
    `[BOB ${contractLabel} — re-injected after context compaction` +
    `${opts.count ? ` #${opts.count}` : ""}${opts.reason ? ` (${opts.reason})` : ""}; cap ${cap} chars]`;

  const plan = (opts.state.lastStatedPlan ?? "").trim();
  const remaining =
    plan.length > 0 ? `Last plan you stated:\n${plan}` : renderWorktreeNote(opts.state);

  const body = [
    heading,
    "The conversation above was compacted. That is NOT completion — the task is still open.",
    "",
    `${contractLabel}:`,
    contract.length > 0 ? contract : "(none recorded)",
    "",
    "WHAT REMAINS:",
    remaining,
    "",
    "Continue from the state above. Finish the task, then end with a final message stating what you did.",
  ].join("\n");
  return capText(body, cap);
}

/** Build the standing contract for the PERSISTENT runtime from the agent's
 *  bob.yaml `agent:` block and its declared `cron:` duties. */
export function buildStandingContract(opts: {
  name?: string;
  role?: string;
  duties?: ReadonlyArray<{ name?: string; schedule?: string; prompt?: string }>;
}): string {
  const who = opts.name?.trim() || "this agent";
  const role = opts.role?.trim();
  const lines = [
    `You are ${who}${role ? `, on duty as ${role}` : ""} for this office.`,
    "This is your standing contract: keep working your duties. A context compaction is not the",
    "end of your shift.",
  ];
  const duties = (opts.duties ?? []).filter((d) => d && (d.prompt || d.name));
  if (duties.length > 0) {
    lines.push("Standing duties:");
    for (const d of duties) {
      const label = [d.name, d.schedule ? `(${d.schedule})` : undefined].filter(Boolean).join(" ");
      lines.push(`- ${label}: ${(d.prompt ?? "").trim()}`);
    }
  }
  return lines.join("\n");
}

/** A minimal structural view of the pi session event stream the contract reads.
 *  Only the fields the reinjector touches — a real AgentSessionEvent and a test
 *  fake both satisfy it. */
export interface SessionEventLike {
  type?: string;
  aborted?: boolean;
  reason?: string;
  message?: { role?: string; content?: unknown } | null;
  assistantMessageEvent?: { type?: string; delta?: string } | null;
  toolName?: string;
  args?: unknown;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") {
      out += block;
      continue;
    }
    const b = block as { type?: string; text?: string };
    if (b && b.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

export interface CompactionReinjectorOptions {
  /** One-shot task prompt (mutually exclusive with standingContract). */
  task?: string;
  /** Persistent standing contract (mutually exclusive with task). */
  standingContract?: string;
  /** Cap on the pinned block (default DEFAULT_PINNED_CAP_CHARS). */
  capChars?: number;
  /** How to re-inject the block into the live session (a steer/follow-up turn). */
  inject: (text: string) => void | Promise<void>;
  /** `git status --short` for the agent's worktree; "" outside a repo. */
  worktreeStatus?: () => string;
  /** How many recent tool calls to list (default DEFAULT_RECENT_TOOL_CALLS). */
  recentToolCalls?: number;
  /** Logger (never logs a secret — this module sees none). */
  log?: (msg: string) => void;
}

export interface CompactionReinjector {
  /** Feed every session event here (subscribe once). */
  observe(event: unknown): void;
  /** Number of non-aborted compactions observed. */
  compactions(): number;
  /** The last pinned block injected (for tests/telemetry). */
  lastBlock(): string | undefined;
}

/**
 * Observe the session event stream and re-inject ONE pinned block after every
 * non-aborted `compaction_end`. Captures "what remains" as it goes: the agent's
 * last stated plan (the last assistant text) and the last few tool calls, plus a
 * `git status --short` probe taken at re-injection time.
 */
export function createCompactionReinjector(
  opts: CompactionReinjectorOptions,
): CompactionReinjector {
  if (opts.task !== undefined && opts.standingContract !== undefined) {
    throw new Error("compaction contract: pass task OR standingContract, not both");
  }
  const log = opts.log ?? (() => {});
  const capChars = opts.capChars ?? DEFAULT_PINNED_CAP_CHARS;
  const recentToolCalls = opts.recentToolCalls ?? DEFAULT_RECENT_TOOL_CALLS;

  let compactions = 0;
  let lastBlock: string | undefined;
  // Assistant text accumulated from text_delta since the last message_end —
  // the "last plan the agent stated" when the provider streams.
  let deltaBuffer = "";
  let lastStatedPlan: string | undefined;
  const toolCalls: string[] = [];

  return {
    compactions: () => compactions,
    lastBlock: () => lastBlock,
    observe(event: unknown): void {
      const e = (event ?? {}) as SessionEventLike;
      switch (e.type) {
        case "compaction_end": {
          if (e.aborted) return; // an aborted compaction changed nothing to restore
          compactions += 1;
          const block = buildPinnedBlock({
            task: opts.task,
            standingContract: opts.standingContract,
            state: {
              lastStatedPlan,
              gitStatus: opts.worktreeStatus?.() ?? "",
              recentToolCalls: toolCalls.slice(-recentToolCalls),
            },
            capChars,
            reason: e.reason,
            count: compactions,
          });
          lastBlock = block;
          log(
            `bob: context compacted${e.reason ? ` (${e.reason})` : ""}; re-injecting the pinned ` +
              `${opts.standingContract !== undefined ? "standing contract" : "task"} block (${block.length} chars)`,
          );
          try {
            const r = opts.inject(block);
            if (r && typeof (r as Promise<void>).catch === "function") {
              (r as Promise<void>).catch((err) =>
                log(
                  `bob: could not re-inject the pinned block: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
            }
          } catch (err) {
            log(
              `bob: could not re-inject the pinned block: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return;
        }
        case "message_update": {
          const d = e.assistantMessageEvent;
          if (d?.type === "text_delta" && typeof d.delta === "string") deltaBuffer += d.delta;
          return;
        }
        case "message_end": {
          // The last assistant message's text is the best "what remains" we can
          // capture without understanding the agent's plan ourselves.
          if (e.message?.role === "assistant") {
            const text = textFromContent(e.message.content).trim() || deltaBuffer.trim();
            if (text.length > 0) lastStatedPlan = text;
          }
          deltaBuffer = "";
          return;
        }
        case "tool_execution_start": {
          if (typeof e.toolName === "string" && e.toolName.length > 0) {
            toolCalls.push(e.toolName);
            if (toolCalls.length > 50) toolCalls.splice(0, toolCalls.length - 50);
          }
          return;
        }
        default:
          return;
      }
    },
  };
}

/**
 * The one-shot completion contract. `ok` only when the final assistant text is
 * non-empty AND (when an expected shape is declared) matches it. On silence the
 * reason names whether a compaction was seen, so the caller can retry once and
 * then exit non-zero with `settled_after_compaction` / `no_final_message`.
 */
export function evaluateCompletion(opts: {
  capturedText: string;
  compactions: number;
  expectedFinal?: (text: string) => boolean;
}): { ok: boolean; reason?: SilenceReason } {
  const text = opts.capturedText.trim();
  const meetsShape = text.length > 0 && (opts.expectedFinal ? opts.expectedFinal(text) : true);
  if (meetsShape) return { ok: true };
  return {
    ok: false,
    reason: opts.compactions > 0 ? "settled_after_compaction" : "no_final_message",
  };
}

/**
 * `git status --short` for `cwd`. Returns "" when cwd is not a git worktree (or
 * any git failure) — a dirty-path note is best-effort, never fatal. Bounded: a
 * repo with thousands of paths still yields a short note.
 */
export function readWorktreeStatus(cwd: string, maxLines = DEFAULT_WORKTREE_STATUS_LINES): string {
  try {
    const r = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
    if (r.status !== 0 || typeof r.stdout !== "string") return "";
    return r.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .slice(0, maxLines)
      .join("\n");
  } catch {
    return "";
  }
}
