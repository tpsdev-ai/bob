// The completion contract (issue #145), and the best-effort note that
// accompanies it.
//
// The CONTRACT itself now lives in the system prompt (see
// system-prompt-contract.ts): the task, or the persistent agent's standing
// contract, is appended there as literal text and cannot be compacted away.
// What remains here is the other half of the fix, and it is deliberately small:
//
//   * the ONE judge a one-shot run's exit code comes from. `bob run` settles
//     `exitCode 0` only with a final assistant message — EXACTLY the text of the
//     last assistant message that ENDED after the last compaction, never rebuilt
//     from streamed deltas, and an empty or failure-ended message is no final
//     message. Because the task is still in the system prompt after a
//     compaction, the single retry with an explicit continue turn is meaningful.
//     Silence names whether a compaction was seen (`settled_after_compaction`)
//     or not (`no_final_message`); a message that exists but misses a declared
//     shape gets its own reason (`final_shape_mismatch`);
//   * a BEST-EFFORT "what remains" note, injected once after each non-aborted
//     compaction: the last thing the agent said, or a generated note about the
//     worktree (git status --short, the last few tool calls). It is useful and
//     it is NEVER load-bearing: it is a steer, its failure is logged and
//     nothing else happens, and no exit code depends on it. (The machinery that
//     existed only because the contract could be lost — the persistent attach,
//     the admission gate, failClosed and its exit, the per-compaction failure
//     records — is gone with the shape change.)
//
// Everything here is pure/injectable so it is unit-testable without pi: the
// session wiring lives in run.ts / persistent.ts and passes the event stream in.

import { spawnSync } from "node:child_process";

/** The explicit continue turn sent as the single retry. */
export const CONTINUE_TURN =
  "[BOB CONTINUE — the previous turn ended without a final message after a context compaction]\n" +
  "Context was compacted and your last turn ended silently. Continue from the state above: " +
  "restate what remains in one line, finish the task, and end with a final message describing " +
  "the outcome (including any commit/push the task asked for).";

/** How many recent tool calls the generated worktree note lists. */
export const DEFAULT_RECENT_TOOL_CALLS = 5;

/** How many `git status --short` lines the generated worktree note lists. */
export const DEFAULT_WORKTREE_STATUS_LINES = 30;

/** Cap on the best-effort "what remains" note, in characters. The note is a
 *  steer into a live session, so it is bounded like any other bob-authored
 *  turn: a note that dwarfs the conversation would be its own defect. */
export const DEFAULT_REMAINING_NOTE_CAP_CHARS = 2000;

/** The named reasons a one-shot run may refuse to report success. */
export type SilenceReason =
  | "settled_after_compaction"
  | "no_final_message"
  // A final message EXISTS but does not match the declared expected shape — it
  // is not silence, so it gets its own reason.
  | "final_shape_mismatch";

/** Truncate `text` to at most `cap` characters, marking the cut. A cap of 0 or
 *  less yields "" — never the untruncated text. */
export function capText(text: string, cap: number): string {
  if (!Number.isFinite(cap) || cap <= 0) return "";
  if (text.length <= cap) return text;
  const marker = "\n… [truncated]";
  if (cap <= marker.length) return text.slice(0, cap);
  return text.slice(0, cap - marker.length) + marker;
}

/** The "what remains" inputs: the last thing the agent said, and/or the
 *  generated worktree state (git status + recent tool calls). */
export interface RemainingState {
  /** The text of the last assistant message that ENDED before the compaction,
   *  when bob captured one. It is whatever the agent last said — a plan, a
   *  question, a one-word acknowledgement — so the note does not call it a
   *  plan. */
  lastSaidText?: string;
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
    const all = status.split("\n");
    const shown = all.slice(0, statusLines);
    lines.push("  git status --short:");
    for (const l of shown) lines.push(`    ${l}`);
    if (all.length > shown.length) lines.push(`    … (${all.length - shown.length} more path(s))`);
  }

  const calls = (state.recentToolCalls ?? []).slice(-toolCalls);
  lines.push(
    calls.length > 0
      ? `  last ${calls.length} tool call(s): ${calls.join(", ")}`
      : "  last tool calls: (none observed)",
  );
  return lines.join("\n");
}

/**
 * The best-effort "what remains" note. It says what it is: a note about the
 * state, not the contract (which is in the system prompt and cannot be lost),
 * so nothing about the run depends on it arriving.
 */
export function buildRemainingNote(state: RemainingState, capChars?: number): string {
  const cap = capChars ?? DEFAULT_REMAINING_NOTE_CAP_CHARS;
  const said = (state.lastSaidText ?? "").trim();
  const body = said.length > 0 ? `The last thing you said:\n${said}` : renderWorktreeNote(state);
  const skeleton = [
    "[BOB WHAT REMAINS — context was compacted; this note is best-effort]",
    "The conversation above was compacted. That is NOT completion. Your task/contract is in your system prompt.",
    "",
    "",
    "",
    "Continue from the state above and end with a final message describing what you did.",
  ].join("\n");
  return [
    "[BOB WHAT REMAINS — context was compacted; this note is best-effort]",
    "The conversation above was compacted. That is NOT completion. Your task/contract is in your system prompt.",
    "",
    capText(body, Math.max(0, cap - skeleton.length)),
    "",
    "Continue from the state above and end with a final message describing what you did.",
  ].join("\n");
}

/** A minimal structural view of the pi session event stream this module reads.
 *  Only the fields it touches — a real AgentSessionEvent and a test fake both
 *  satisfy it. */
export interface SessionEventLike {
  type?: string;
  aborted?: boolean;
  reason?: string;
  message?: { role?: string; content?: unknown; stopReason?: string } | null;
  assistantMessageEvent?: { type?: string; delta?: string } | null;
  toolName?: string;
  args?: unknown;
}

/** pi ends a failed or aborted stream with a final assistant message whose
 *  stopReason is "error" or "aborted" (pi-agent-core's StreamFn contract:
 *  failures are encoded in the stream, not thrown). Such an ending is NOT a
 *  final message — its content is empty or partial. */
function isFailureStopReason(reason: unknown): boolean {
  return reason === "error" || reason === "aborted";
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

export interface CompactionObserverOptions {
  /** `git status --short` for the agent's worktree; "" outside a repo. */
  worktreeStatus?: () => string;
  /** How to deliver the note (a steer into the live session). Omit for a pure
   *  tracker (a test, or a path that only needs the completion boundary). */
  inject?: (text: string) => void | Promise<void>;
  /** How many recent tool calls to list. */
  recentToolCalls?: number;
  /** Cap on the injected note. */
  noteCapChars?: number;
  /** Logger. It is given the note's SIZE (never the note), and a failed
   *  injection's message verbatim. */
  log?: (msg: string) => void;
}

export interface CompactionObserver {
  /** Feed every session event here (subscribe once). */
  observe(event: unknown): void;
  /** Number of non-aborted compactions observed. */
  compactions(): number;
  /** Start of a turn: the FINAL message is per-turn, so the capture starts
   *  fresh. Call before every prompt the runtime issues. */
  startTurn(): void;
  /** The text of the last assistant message that ENDED since the last
   *  compaction (or the last startTurn) — the completion contract's "final
   *  message". It is exactly the content of the message that ended, KEPT AS IT
   *  ENDED: streamed deltas are never substituted for it, and it is never
   *  trimmed — the judge decides emptiness on `trim()`. */
  finalText(): string;
  /** True when at least one assistant message has ENDED since the boundary, so
   *  an empty `finalText()` means the agent went silent rather than that the
   *  transport omitted its message. */
  assistantEnded(): boolean;
}

/**
 * Observe the session event stream: track the compaction count and the final
 * message boundary, capture "what remains" as it goes (the agent's last stated
 * plan and the last few tool calls), and — when an `inject` seam is given —
 * send ONE best-effort note after every non-aborted `compaction_end`.
 *
 * A failed note is LOGGED and nothing else happens. There is no verdict, no
 * refusal and no exit code attached to it: the contract it accompanies is in
 * the system prompt, so a lost note loses the plan's *reminder*, not the task.
 */
export function createCompactionObserver(opts: CompactionObserverOptions = {}): CompactionObserver {
  const log = opts.log ?? (() => {});
  const recentToolCalls = opts.recentToolCalls ?? DEFAULT_RECENT_TOOL_CALLS;

  let compactions = 0;
  // Assistant text accumulated from text_delta since the last message_end —
  // the last thing the agent said, when the provider streams.
  let deltaBuffer = "";
  let lastSaidText: string | undefined;
  const toolCalls: string[] = [];
  let finalMessage = "";
  let sawAssistantEnd = false;

  const clearCapture = (): void => {
    finalMessage = "";
    sawAssistantEnd = false;
    deltaBuffer = "";
  };

  const noteFor = (): string =>
    buildRemainingNote(
      {
        lastSaidText,
        gitStatus: opts.worktreeStatus?.() ?? "",
        recentToolCalls: toolCalls.slice(-recentToolCalls),
      },
      opts.noteCapChars,
    );

  return {
    compactions: () => compactions,
    startTurn: () => clearCapture(),
    finalText: () => finalMessage,
    assistantEnded: () => sawAssistantEnd,
    observe(event: unknown): void {
      const e = (event ?? {}) as SessionEventLike;
      switch (e.type) {
        case "compaction_end": {
          if (e.aborted) return; // an aborted compaction changed nothing to restore
          compactions += 1;
          // The boundary: everything streamed BEFORE this compaction is not the
          // run's final message.
          clearCapture();
          log(`bob: context compacted${e.reason ? ` (${e.reason})` : ""}`);
          if (opts.inject === undefined) return;
          const note = noteFor();
          log(`bob: sending the best-effort "what remains" note (${note.length} chars)`);
          try {
            // A synchronous throw and an async rejection are the SAME outcome
            // here: logged, and nothing else.
            void Promise.resolve(opts.inject(note)).catch((err) => {
              log(
                `bob: could not send the "what remains" note: ${err instanceof Error ? err.message : String(err)} (this is best-effort; the task is in the system prompt)`,
              );
            });
          } catch (err) {
            log(
              `bob: could not send the "what remains" note: ${err instanceof Error ? err.message : String(err)} (this is best-effort; the task is in the system prompt)`,
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
          // A message that ENDED. When it is an ASSISTANT message its own text
          // is the best "what remains" bob can capture without understanding
          // the agent's intent, and it is the run's current final message.
          if (e.message?.role === "assistant") {
            const ended = textFromContent(e.message.content);
            const failed = isFailureStopReason(e.message.stopReason);
            // "What remains" is display text and is trimmed; a FAILED stream's
            // partial text is not something the agent said.
            if (!failed) {
              const said = ended.trim() || deltaBuffer.trim();
              if (said.length > 0) lastSaidText = said;
            }
            // The final message: exactly this message's text, and never an
            // empty or failure-ended one.
            finalMessage = failed ? "" : ended;
            sawAssistantEnd = true;
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
 * non-empty AND (when an expected shape is declared) matches it. The text is
 * the content of the last assistant message that ENDED after the boundary —
 * streamed deltas are never substituted for it, and an empty or failure-ended
 * message is no final message, so this function only classifies what the caller
 * captured. That text is judged EXACTLY as it ended: only EMPTINESS is decided
 * on the trimmed text, and `expectedFinal` sees the verbatim content.
 */
export function evaluateCompletion(opts: {
  capturedText: string;
  compactions: number;
  expectedFinal?: (text: string) => boolean;
}): { ok: boolean; reason?: SilenceReason } {
  const text = opts.capturedText;
  if (text.trim().length === 0) {
    return {
      ok: false,
      reason: opts.compactions > 0 ? "settled_after_compaction" : "no_final_message",
    };
  }
  if (opts.expectedFinal && !opts.expectedFinal(text)) {
    return { ok: false, reason: "final_shape_mismatch" };
  }
  return { ok: true };
}

/**
 * Build the standing contract for the PERSISTENT runtime from the agent's
 * bob.yaml `agent:` block and its declared `cron:` duties. It is the text that
 * goes into the system prompt, so it is written for the model to read.
 */
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
