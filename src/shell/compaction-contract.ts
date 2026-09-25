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
//      the thing that tips the context back over the threshold: a cap below
//      MIN_PINNED_CAP_CHARS is refused outright, and within the cap the TASK is
//      truncated before the "what remains" body (never the section headers), so
//      the block always carries "WHAT REMAINS" and never exceeds its cap.
//   2. The completion contract for a one-shot run: it settles `exitCode 0` only
//      with a final assistant message — EXACTLY the text of the last assistant
//      message that ENDED after the last compaction (never rebuilt from streamed
//      deltas; an empty ending, or one whose stop reason is an error, is no final
//      message) — and matches an expected shape when one is declared. Settling
//      silently after a compaction retries ONCE with an explicit "continue from
//      the state above" turn; if it still settles without meeting the contract
//      the run exits non-zero with a named reason (`settled_after_compaction` /
//      `no_final_message`). Never exit 0 for silence.
//
// Everything here is pure/injectable so it is unit-testable without pi: the
// session wiring lives in run.ts / persistent.ts and passes the event stream in.

import { spawnSync } from "node:child_process";

/** Cap on the re-injected pinned block, in characters. Generous enough to carry
 *  a task + a plan, small enough that the re-injection cannot itself trip the
 *  context threshold. The cap is named in the block's own header. */
export const DEFAULT_PINNED_CAP_CHARS = 6000;

/** The SMALLEST cap the pinned block may be given. Below this the block cannot
 *  carry both of its sections (its headers plus some content), so a smaller cap
 *  is REJECTED at validation rather than silently producing a block with neither
 *  section (round 3, item 2). */
export const MIN_PINNED_CAP_CHARS = 512;

/** How many recent tool calls the generated worktree note lists. */
export const DEFAULT_RECENT_TOOL_CALLS = 5;

/** How many `git status --short` lines the generated worktree note lists. */
export const DEFAULT_WORKTREE_STATUS_LINES = 30;

/** The named reasons a one-shot run may refuse to report success. */
export type SilenceReason =
  | "settled_after_compaction"
  | "no_final_message"
  // A final message EXISTS but does not match the declared expected shape — it is
  // not silence, so it gets its own reason (round 2, item 3).
  | "final_shape_mismatch";

/** The pinned block's cap: a finite number of characters, at least
 *  MIN_PINNED_CAP_CHARS. A cap of 0 or less is REJECTED, not treated as "no cap"
 *  (round 2, item 2): an uncapped re-injection is the thing that would tip the
 *  context back over the threshold. A cap BELOW the minimum is rejected too
 *  (round 3, item 2) — the block cannot carry both of its sections in less, so
 *  accepting it only produces a block with neither section. */
export function assertPinnedCap(cap: unknown): number {
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap < MIN_PINNED_CAP_CHARS) {
    throw new Error(
      `compaction contract: the pinned-block cap must be a positive number of characters and at least ${MIN_PINNED_CAP_CHARS} (got ${String(cap)}) — a smaller block cannot carry both of its sections, and there is no "no cap"`,
    );
  }
  return cap;
}

/** The explicit continue turn sent as the single retry. */
export const CONTINUE_TURN =
  "[BOB CONTINUE — the previous turn ended without a final message after a context compaction]\n" +
  "Context was compacted and your last turn ended silently. Continue from the state above: " +
  "restate what remains in one line, finish the task, and end with a final message describing " +
  "the outcome (including any commit/push the task asked for).";

/** Truncate `text` to at most `cap` characters, marking the cut. A cap of 0 or
 *  less yields "" — never the untruncated text (an unbounded block is exactly
 *  what capText exists to prevent; returning the text unchanged there was what
 *  let a small cap overflow and get the whole block cut, round 3, item 2). A cap
 *  too small for the marker cuts hard, so the result never exceeds `cap`. */
export function capText(text: string, cap: number): string {
  if (!Number.isFinite(cap) || cap <= 0) return "";
  if (text.length <= cap) return text;
  const marker = "\n… [truncated]";
  if (cap <= marker.length) return text.slice(0, cap);
  return text.slice(0, cap - marker.length) + marker;
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
  // A cap of 0 or less is REJECTED (round 2, item 2) — never "no cap".
  const cap = assertPinnedCap(opts.capChars ?? DEFAULT_PINNED_CAP_CHARS);
  const contractLabel = opts.standingContract !== undefined ? "STANDING CONTRACT" : "TASK";
  const contract = (opts.standingContract ?? opts.task ?? "").trim();
  const heading =
    `[BOB ${contractLabel} — re-injected after context compaction` +
    `${opts.count ? ` #${opts.count}` : ""}${opts.reason ? ` (${opts.reason})` : ""}; cap ${cap} chars]`;
  const intro =
    "The conversation above was compacted. That is NOT completion — the task is still open.";
  const footer =
    "Continue from the state above. Finish the task, then end with a final message stating what you did.";

  const plan = (opts.state.lastStatedPlan ?? "").trim();
  const remaining = (
    plan.length > 0 ? `Last plan you stated:\n${plan}` : renderWorktreeNote(opts.state)
  ).trim();

  // Compose with the two variable sections as arguments, so the FIXED skeleton's
  // length can be measured once (with placeholders — conservative).
  const compose = (taskShown: string, remainingShown: string): string =>
    [
      heading,
      intro,
      "",
      `${contractLabel}:`,
      taskShown.length > 0 ? taskShown : "(none recorded)",
      "",
      "WHAT REMAINS:",
      remainingShown.length > 0 ? remainingShown : "(nothing captured)",
      "",
      footer,
    ].join("\n");

  const overhead = compose("", "").length;
  const bodyBudget = Math.max(0, cap - overhead);

  // "What remains" is budgeted FIRST — it is the point of the block — and takes
  // whatever it needs up to the whole body budget; the TASK is then truncated
  // into what is left. Truncation therefore always shrinks the TASK first and
  // only then the remains BODY, and both section headers live in the fixed
  // skeleton above, so a header is never the part that gets cut (round 3,
  // item 2). By construction `overhead + the two bodies <= cap`, so there is no
  // whole-block truncation — that is what used to erase "WHAT REMAINS".
  const remainingShown = capText(remaining, bodyBudget);
  const taskShown = capText(contract, Math.max(0, bodyBudget - remainingShown.length));
  return compose(taskShown, remainingShown);
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
  message?: { role?: string; content?: unknown; stopReason?: string } | null;
  assistantMessageEvent?: { type?: string; delta?: string } | null;
  toolName?: string;
  args?: unknown;
}

/** pi ends a failed or aborted stream with a final assistant message whose
 *  stopReason is "error" or "aborted" (pi-agent-core's StreamFn contract:
 *  failures are encoded in the stream, not thrown). Such an ending is NOT a
 *  final message — its content is empty or partial (round 3, item 1). */
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
  /**
   * Start of a turn: the FINAL message is per-turn, so the capture starts fresh
   * (round 2, item 1). Call before every prompt the runtime issues.
   */
  startTurn(): void;
  /**
   * The text of the last assistant TURN that ENDED since the last compaction (or
   * the last startTurn) — the completion contract's "final message" (round 2
   * item 1, round 3 item 1). It is exactly the content of the message that
   * ended: streamed deltas are never substituted for it.
   */
  finalText(): string;
  /**
   * True when at least one assistant message has ENDED since the boundary, so an
   * empty `finalText()` means the agent went silent rather than that the
   * transport omitted its message.
   */
  assistantEnded(): boolean;
}

/**
 * Observe the session event stream and re-inject ONE pinned block after every
 * non-aborted `compaction_end`. Captures "what remains" as it goes: the agent's
 * last stated plan (the last assistant text) and the last few tool calls, plus a
 * `git status --short` probe taken at re-injection time.
 *
 * It also tracks the FINAL MESSAGE boundary (round 2, item 1): text streamed
 * before a compaction must never satisfy the completion contract, so the capture
 * is cleared on every `compaction_end` and at every `startTurn()`.
 */
export function createCompactionReinjector(
  opts: CompactionReinjectorOptions,
): CompactionReinjector {
  if (opts.task !== undefined && opts.standingContract !== undefined) {
    throw new Error("compaction contract: pass task OR standingContract, not both");
  }
  const log = opts.log ?? (() => {});
  const capChars = assertPinnedCap(opts.capChars ?? DEFAULT_PINNED_CAP_CHARS);
  const recentToolCalls = opts.recentToolCalls ?? DEFAULT_RECENT_TOOL_CALLS;

  let compactions = 0;
  let lastBlock: string | undefined;
  // Assistant text accumulated from text_delta since the last message_end —
  // the "last plan the agent stated" when the provider streams.
  let deltaBuffer = "";
  let lastStatedPlan: string | undefined;
  const toolCalls: string[] = [];
  // The final-message boundary: text the LAST assistant message emitted since
  // the last compaction / turn start.
  let finalMessage = "";
  let sawAssistantEnd = false;

  const clearCapture = (): void => {
    finalMessage = "";
    sawAssistantEnd = false;
    deltaBuffer = "";
  };

  return {
    compactions: () => compactions,
    lastBlock: () => lastBlock,
    startTurn: () => clearCapture(),
    // The LAST message that ENDED. Streamed deltas are never substituted for it
    // (round 3, item 1): a message still in flight, or one that ended empty or
    // with a failure stop reason, leaves this empty.
    finalText: () => finalMessage.trim(),
    assistantEnded: () => sawAssistantEnd,
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
          // The boundary: everything streamed BEFORE this compaction is not the
          // run's final message (round 2, item 1).
          clearCapture();
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
          // A message that ENDED. When it is an ASSISTANT message its own text is
          // (a) the best "what remains" we can capture without understanding the
          // agent's plan ourselves, and (b) the run's current final message.
          if (e.message?.role === "assistant") {
            // The text of the message that ENDED — NEVER rebuilt from the
            // streamed deltas (round 3, item 1). A stream that fails ends the
            // assistant message with EMPTY content and lets the prompt settle;
            // substituting the deltas for that content is what let a failed run
            // report success.
            const ended = textFromContent(e.message.content).trim();
            const failed = isFailureStopReason(e.message.stopReason);
            // "What remains" is best-effort and separate from the completion
            // contract: a message that ended without assembled content still
            // leaves its streamed text as the last plan the agent stated — but a
            // FAILED stream's partial text is not a plan the agent stated.
            if (!failed) {
              const plan = ended || deltaBuffer.trim();
              if (plan.length > 0) lastStatedPlan = plan;
            }
            // The final message: exactly this message's text, and never an empty
            // or failure-ended one (round 3, item 1). `sawAssistantEnd` records
            // that a message DID end, so the session-state fallback cannot
            // resurrect an EARLIER message in its place.
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
 * non-empty AND (when an expected shape is declared) matches it. The text is the
 * content of the last assistant message that ENDED after the boundary — streamed
 * deltas are never substituted for it, and an empty or failure-ended message is
 * no final message (round 3, item 1), so this function only classifies what the
 * caller captured. Silence names whether a compaction was seen
 * (`settled_after_compaction` / `no_final_message`); a message that EXISTS but
 * does not match gets its OWN reason (`final_shape_mismatch`, round 2 item 3) —
 * it is not silence.
 */
export function evaluateCompletion(opts: {
  capturedText: string;
  compactions: number;
  expectedFinal?: (text: string) => boolean;
}): { ok: boolean; reason?: SilenceReason } {
  const text = opts.capturedText.trim();
  if (text.length === 0) {
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
