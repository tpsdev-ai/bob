import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPinnedBlock,
  buildStandingContract,
  createCompactionReinjector,
  DEFAULT_PINNED_CAP_CHARS,
  evaluateCompletion,
  MAX_HEADER_REASON_CHARS,
  MIN_PINNED_CAP_CHARS,
  readWorktreeStatus,
  renderWorktreeNote,
} from "../../src/shell/compaction-contract.js";

const TMP: string[] = [];
function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMP.push(d);
  return d;
}
afterEach(() => {
  while (TMP.length) rmSync(TMP.pop() as string, { recursive: true, force: true });
});

describe("compaction contract — the pinned block", () => {
  it("carries the task and 'what remains' (the last stated plan)", () => {
    const block = buildPinnedBlock({
      task: "commit the two core files and push",
      state: { lastStatedPlan: "next: commit, then push" },
      reason: "threshold",
      count: 1,
    });
    expect(block).toContain("TASK:");
    expect(block).toContain("commit the two core files and push");
    expect(block).toContain("WHAT REMAINS:");
    expect(block).toContain("next: commit, then push");
    expect(block).toContain("compaction #1");
    expect(block).toContain("threshold");
  });

  it("falls back to the generated worktree note when no plan was captured", () => {
    const block = buildPinnedBlock({
      task: "do the thing",
      state: { gitStatus: " M src/a.ts\n?? new.ts", recentToolCalls: ["edit", "bash"] },
    });
    expect(block).toContain("No plan was captured");
    expect(block).toContain(" M src/a.ts");
    expect(block).toContain("?? new.ts");
    expect(block).toContain("last 2 tool call(s): edit, bash");
  });

  it("uses the standing contract (not the task) for the persistent runtime", () => {
    const block = buildPinnedBlock({
      standingContract: "You are pulse, on duty as ea.",
      state: {},
    });
    expect(block).toContain("STANDING CONTRACT:");
    expect(block).toContain("You are pulse, on duty as ea.");
    expect(block).not.toContain("TASK:");
  });

  it("is BOUNDED by the cap it names", () => {
    const huge = "x".repeat(DEFAULT_PINNED_CAP_CHARS * 2);
    const block = buildPinnedBlock({
      task: huge,
      state: { lastStatedPlan: huge },
      capChars: MIN_PINNED_CAP_CHARS,
    });
    expect(block.length).toBeLessThanOrEqual(MIN_PINNED_CAP_CHARS);
    expect(block).toContain("[truncated]");
  });

  it("at the MINIMUM cap, a long task and a long plan give a block within the cap that still carries WHAT REMAINS (round 3, item 2)", () => {
    // A 300-char cap used to yield a block with neither section, and cap 1
    // yielded 14 characters — the whole block was truncated. Truncation must
    // shrink the TASK first and then the remains BODY, never the headers, and
    // the block must always contain its "WHAT REMAINS" header.
    const cap = MIN_PINNED_CAP_CHARS;
    // Longer than half the body budget (so the old 50/50 split cut it) but
    // short enough to fit the budget on its own: the plan survives IN FULL
    // while the task is the part that gets truncated.
    const plan = `PLAN-START ${"p".repeat(130)} PLAN-END`;
    const block = buildPinnedBlock({
      task: "t".repeat(5000),
      state: { lastStatedPlan: plan },
      capChars: cap,
      reason: "threshold",
      count: 1,
    });
    expect(block.length, "never exceeds the cap").toBeLessThanOrEqual(cap);
    expect(block, "the WHAT REMAINS header is present").toContain("WHAT REMAINS:");
    expect(block, "the TASK header is present too").toContain("TASK:");
    expect(block, "the remains body survived in full").toContain(plan);
    expect(block, "and the TASK is the part that was shrunk").toContain("[truncated]");
  });

  it("shrinks the task before the remains body when the plan alone is over budget (round 3, item 2)", () => {
    // Here the plan alone cannot fit: the remains BODY is the thing truncated
    // (the task gets nothing), and the block still stays within the cap with
    // its headers intact.
    const cap = MIN_PINNED_CAP_CHARS;
    const block = buildPinnedBlock({
      task: "task text that has no room left for it",
      state: { lastStatedPlan: `PLAN-START ${"p".repeat(1000)} PLAN-END` },
      capChars: cap,
    });
    expect(block.length).toBeLessThanOrEqual(cap);
    expect(block).toContain("WHAT REMAINS:");
    expect(block).toContain("TASK:");
    expect(block).toContain("[truncated]");
    expect(block, "the truncated portion is the remains body").toContain("PLAN-START");
    expect(block, "the task was shrunk away entirely").toContain("(none recorded)");
  });

  it("bounds the reason in the header and counts the whole header against the cap (round 4, item 2)", () => {
    // The reason goes in the HEADER, and the header is part of the cap. An
    // unbounded reason overflowed it: a 1,000-character reason produced a
    // 1,315-character block under a 512-character cap.
    const cap = MIN_PINNED_CAP_CHARS;
    const body = { task: "T".repeat(5000), state: { lastStatedPlan: "P".repeat(2000) } };
    const block = buildPinnedBlock({ ...body, capChars: cap, reason: "R".repeat(1000), count: 1 });
    expect(block.length, "never exceeds the cap, whatever the reason says").toBeLessThanOrEqual(
      cap,
    );
    expect(block, "and it still carries WHAT REMAINS").toContain("WHAT REMAINS:");
    expect(block, "and its TASK header").toContain("TASK:");
    const shown = block.slice(block.indexOf("(") + 1, block.indexOf(")"));
    expect(shown.length, "the reason is BOUNDED in the header").toBeLessThanOrEqual(
      MAX_HEADER_REASON_CHARS,
    );
    expect(shown.startsWith("R"), "the reason is still what the header shows").toBe(true);
    expect(shown.endsWith("…"), "and its elision is marked").toBe(true);
    // A reason short enough to fit is carried as-is, and a line break cannot
    // split the header into extra lines.
    expect(buildPinnedBlock({ task: "t", state: {}, reason: "threshold", count: 2 })).toContain(
      "(threshold)",
    );
    const multiline = buildPinnedBlock({
      task: "t",
      state: {},
      reason: "threshold\noverflow",
      count: 2,
    });
    expect(multiline.split("\n")[0], "the header stays ONE line").toContain("(threshold overflow)");
    // The header is not free space: at the same cap, a max-length reason leaves
    // the "what remains" body LESS room than no reason does, and the block is
    // within the cap either way.
    const withReason = buildPinnedBlock({
      ...body,
      capChars: cap,
      reason: "R".repeat(MAX_HEADER_REASON_CHARS),
    });
    const withoutReason = buildPinnedBlock({ ...body, capChars: cap });
    const afterRemains = (b: string): number => (b.split("WHAT REMAINS:")[1] ?? "").length;
    expect(withReason.length).toBeLessThanOrEqual(cap);
    expect(withoutReason.length).toBeLessThanOrEqual(cap);
    expect(
      afterRemains(withoutReason),
      "the header's reason is COUNTED against the cap",
    ).toBeGreaterThan(afterRemains(withReason));
  });

  it("renderWorktreeNote handles a clean tree and no tool calls", () => {
    const note = renderWorktreeNote({});
    expect(note).toContain("(clean, or not a git worktree)");
    expect(note).toContain("(none observed)");
  });

  it("reserves budget for 'what remains' and truncates the TASK first (round 2, item 2)", () => {
    // The task comes first in the block; a naive whole-block truncation would
    // leave no plan or worktree note at all. The remaining section is budgeted
    // FIRST, and the task is cut to fit around it.
    const cap = 1200;
    const block = buildPinnedBlock({
      task: "x".repeat(cap * 3),
      state: { lastStatedPlan: "next: commit the two files, then push" },
      capChars: cap,
    });
    expect(block.length, "the block fits the cap").toBeLessThanOrEqual(cap);
    expect(block, "and it still carries its 'what remains' section").toContain("WHAT REMAINS:");
    expect(block).toContain("next: commit the two files, then push");
    expect(block, "the task portion was the part truncated").toContain("[truncated]");
  });

  it("rejects a cap below the minimum at validation, with a named error (round 3, item 2)", () => {
    // 0 or less is not "no cap"; and a cap smaller than the minimum cannot
    // carry the block's two sections at all, so it is rejected at validation.
    for (const bad of [0, -10, 1, 100, MIN_PINNED_CAP_CHARS - 1]) {
      expect(() => buildPinnedBlock({ task: "t", state: {}, capChars: bad })).toThrow(
        /at least 512/,
      );
    }
    expect(() => buildPinnedBlock({ task: "t", state: {}, capChars: Number.NaN })).toThrow(
      /at least 512/,
    );
    expect(() =>
      createCompactionReinjector({ task: "t", capChars: 100, inject: () => {} }),
    ).toThrow(/at least 512/);
    // The minimum itself is accepted.
    expect(() =>
      buildPinnedBlock({ task: "t", state: {}, capChars: MIN_PINNED_CAP_CHARS }),
    ).not.toThrow();
  });

  it("buildStandingContract renders the agent and its scheduled duties", () => {
    const s = buildStandingContract({
      name: "pulse",
      role: "ea",
      duties: [{ name: "morning_briefing", schedule: "0 9 * * *", prompt: "Compose the brief." }],
    });
    expect(s).toContain("You are pulse, on duty as ea");
    expect(s).toContain("morning_briefing (0 9 * * *)");
    expect(s).toContain("Compose the brief.");
  });
});

describe("compaction contract — the reinjector", () => {
  it("re-injects ONE pinned block per non-aborted compaction_end", () => {
    const injected: string[] = [];
    const r = createCompactionReinjector({
      task: "finish the release notes",
      worktreeStatus: () => " M notes.md",
      inject: (t) => {
        injected.push(t);
      },
    });
    r.observe({ type: "compaction_end", reason: "threshold", aborted: false });
    r.observe({ type: "compaction_end", reason: "threshold", aborted: true }); // aborted → nothing
    r.observe({ type: "compaction_end", reason: "overflow", aborted: false });
    expect(r.compactions()).toBe(2);
    expect(injected).toHaveLength(2);
    expect(injected[0]).toContain("finish the release notes");
    expect(injected[1]).toContain("overflow");
  });

  it("captures the agent's last stated plan (assistant text) for 'what remains'", () => {
    const injected: string[] = [];
    const r = createCompactionReinjector({
      task: "task",
      worktreeStatus: () => "",
      inject: (t) => {
        injected.push(t);
      },
    });
    r.observe({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "plan: edit then commit" }] },
    });
    r.observe({ type: "compaction_end", reason: "threshold", aborted: false });
    expect(injected[0]).toContain("plan: edit then commit");
    expect(injected[0]).not.toContain("No plan was captured");
  });

  it("captures streamed text_delta into the plan when the provider streams", () => {
    const injected: string[] = [];
    const r = createCompactionReinjector({
      task: "task",
      worktreeStatus: () => "",
      inject: (t) => {
        injected.push(t);
      },
    });
    r.observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "next: " },
    });
    r.observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "commit" },
    });
    r.observe({ type: "message_end", message: { role: "assistant", content: [] } });
    r.observe({ type: "compaction_end", aborted: false });
    expect(injected[0]).toContain("next: commit");
  });

  it("lists the recent tool calls when no plan was captured", () => {
    const injected: string[] = [];
    const r = createCompactionReinjector({
      task: "task",
      worktreeStatus: () => "",
      inject: (t) => {
        injected.push(t);
      },
    });
    r.observe({ type: "tool_execution_start", toolName: "read" });
    r.observe({ type: "tool_execution_start", toolName: "edit" });
    r.observe({ type: "compaction_end", aborted: false });
    expect(injected[0]).toContain("last 2 tool call(s): read, edit");
  });

  it("refuses to be constructed with both a task and a standing contract", () => {
    expect(() =>
      createCompactionReinjector({ task: "a", standingContract: "b", inject: () => {} }),
    ).toThrow(/task OR standingContract/);
  });

  it("records a REJECTED re-injection and reports it only for the LAST compaction (round 8)", async () => {
    const logged: string[] = [];
    // Compaction #1 rejects, compaction #2 succeeds: the run's last compaction
    // left the task restored, so nothing is reported.
    const r = createCompactionReinjector({
      task: "finish the release notes",
      inject: (t) => {
        if (t.includes("compaction #1")) return Promise.reject(new Error("steer refused"));
        return undefined;
      },
      log: (m) => logged.push(m),
    });
    r.observe({ type: "compaction_end", reason: "threshold", aborted: false });
    await r.settled();
    expect(r.reinjectionFailure()).toBe("steer refused");
    expect(logged.join("\n")).toContain("could not re-inject the pinned block: steer refused");

    r.observe({ type: "compaction_end", reason: "overflow", aborted: false });
    await r.settled();
    expect(r.reinjectionFailure(), "the newer injection restores the task").toBeUndefined();
  });

  it("a late rejection from an OLDER compaction cannot speak for a newer one (round 8)", async () => {
    // Ordering hazard: attempt #1's promise is still pending when #2 lands and
    // fails. The failure that must be reported is #2's, not the stale one.
    let releaseFirst: (() => void) | undefined;
    const r = createCompactionReinjector({
      task: "task",
      inject: (t) => {
        if (t.includes("compaction #1")) {
          return new Promise<void>((_res, rej) => {
            releaseFirst = () => rej(new Error("stale failure"));
          });
        }
        return Promise.reject(new Error("current failure"));
      },
      log: () => {},
    });
    r.observe({ type: "compaction_end", reason: "threshold", aborted: false });
    r.observe({ type: "compaction_end", reason: "overflow", aborted: false });
    // #1 is still pending, so `settled()` would block on it: let the microtask
    // queue drain instead, which is enough for #2's rejection to be recorded.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.reinjectionFailure()).toBe("current failure");
    releaseFirst?.();
    await r.settled();
    expect(r.reinjectionFailure(), "a stale attempt cannot outvote the last one").toBe(
      "current failure",
    );
  });

  it("records a SYNCHRONOUSLY thrown re-injection without letting it escape (round 8)", () => {
    const logged: string[] = [];
    const r = createCompactionReinjector({
      task: "task",
      inject: () => {
        throw new Error("the session refused the re-injection");
      },
      log: (m) => logged.push(m),
    });
    // observe() must not rethrow: the throw is the reinjector's to record.
    expect(() => r.observe({ type: "compaction_end", aborted: false })).not.toThrow();
    expect(r.reinjectionFailure()).toBe("the session refused the re-injection");
    expect(logged.join("\n")).toContain(
      "could not re-inject the pinned block: the session refused the re-injection",
    );
  });

  it("reports no failure for a re-injection that resolves (round 8)", async () => {
    const r = createCompactionReinjector({
      task: "task",
      inject: () => Promise.resolve(),
      log: () => {},
    });
    r.observe({ type: "compaction_end", aborted: false });
    await r.settled();
    expect(r.reinjectionFailure()).toBeUndefined();
  });

  it("settled() resolves once an in-flight re-injection settles — no failure is judged early (round 8)", async () => {
    let release: ((err?: Error) => void) | undefined;
    const r = createCompactionReinjector({
      task: "task",
      inject: () =>
        new Promise<void>((res, rej) => {
          release = (err) => (err ? rej(err) : res());
        }),
      log: () => {},
    });
    r.observe({ type: "compaction_end", aborted: false });
    let done = false;
    const waiting = r.settled().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done, "still pending: nothing to judge yet").toBe(false);
    release?.(new Error("late rejection"));
    await waiting;
    expect(r.reinjectionFailure()).toBe("late rejection");
  });

  it("clears the final-message capture at the compaction boundary, and deltas alone are never the final message (round 2 + round 3, item 1)", () => {
    const r = createCompactionReinjector({ task: "t", worktreeStatus: () => "", inject: () => {} });
    r.startTurn();
    r.observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "review, then commit" },
    });
    expect(
      r.finalText(),
      "streamed deltas are not the final message — only the text of an ENDED message is",
    ).toBe("");

    // The message ENDS, carrying its own text: that is the final message.
    r.observe({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "review, then commit" }] },
    });
    expect(r.finalText()).toBe("review, then commit");

    // …and the compaction boundary clears it again.
    r.observe({ type: "compaction_end", reason: "threshold", aborted: false });
    expect(r.finalText(), "text that ENDED before the compaction is not the final message").toBe(
      "",
    );

    // A new turn starts with an empty capture too (deltas still do not count).
    r.observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "after" },
    });
    r.startTurn();
    expect(r.finalText()).toBe("");
  });

  it("an empty ending, or one whose stop reason is an error, is NO final message (round 3, item 1)", () => {
    const r = createCompactionReinjector({ task: "t", inject: () => {} });

    // The repro: a stream emits deltas and then fails. pi ends the assistant
    // message with EMPTY content and stopReason "error" — the deltas are never
    // the final message.
    r.startTurn();
    r.observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial text from a failed stream" },
    });
    r.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    });
    expect(r.finalText(), "a failed stream is not a final message").toBe("");
    expect(r.assistantEnded(), "but the message DID end (no session-state fallback)").toBe(true);

    // Even with text present, an error stop reason is not a final message.
    r.startTurn();
    r.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "half a sentence" }],
        stopReason: "error",
      },
    });
    expect(r.finalText()).toBe("");

    // An aborted ending is no final message either.
    r.startTurn();
    r.observe({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "aborted text" }],
        stopReason: "aborted",
      },
    });
    expect(r.finalText()).toBe("");

    // An empty (non-errored) ending is no final message either.
    r.startTurn();
    r.observe({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
    expect(r.finalText()).toBe("");

    // …but a normal ending with text still is.
    r.startTurn();
    r.observe({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done: committed" }] },
    });
    expect(r.finalText()).toBe("done: committed");
  });

  it("keeps the final text EXACTLY as it ended, and judges emptiness on trim() only (round 4, item 1)", () => {
    const r = createCompactionReinjector({ task: "t", inject: () => {} });
    r.startTurn();
    // The message ENDS with leading spaces and a trailing blank line: the
    // completion text is the content that ended, whitespace included — not a
    // trimmed rewrite of it.
    r.observe({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "  done: shipped\n\n" }] },
    });
    expect(r.finalText(), "kept verbatim, as it ended").toBe("  done: shipped\n\n");
    // An exact expectedFinal must MATCH the verbatim text…
    expect(
      evaluateCompletion({
        capturedText: r.finalText(),
        compactions: 1,
        expectedFinal: (t) => t === "  done: shipped\n\n",
      }),
      "an exact predicate sees the text as it ended",
    ).toEqual({ ok: true });
    // …and the trimmed copy is genuinely different, so this is a real contract:
    expect(
      evaluateCompletion({
        capturedText: r.finalText().trim(),
        compactions: 1,
        expectedFinal: (t) => t === "  done: shipped\n\n",
      }),
    ).toEqual({ ok: false, reason: "final_shape_mismatch" });
    // Emptiness is still judged on the TRIMMED text: whitespace-only is no
    // final message, even though it is kept as it ended.
    r.startTurn();
    r.observe({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "  \n\t " }] },
    });
    expect(r.finalText(), "whitespace-only is still kept as it ended…").toBe("  \n\t ");
    expect(
      evaluateCompletion({ capturedText: r.finalText(), compactions: 1 }),
      "…but it is NO final message",
    ).toEqual({ ok: false, reason: "settled_after_compaction" });
  });

  it("tracks whether an assistant message ENDED since the boundary (round 2, item 1)", () => {
    const r = createCompactionReinjector({ task: "t", inject: () => {} });
    r.startTurn();
    expect(r.assistantEnded()).toBe(false);
    r.observe({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
    expect(r.assistantEnded()).toBe(true);
    r.observe({ type: "compaction_end", aborted: false });
    expect(r.assistantEnded(), "the boundary resets it").toBe(false);
  });
});

describe("compaction contract — the completion contract", () => {
  it("a non-empty final message meets the contract", () => {
    expect(evaluateCompletion({ capturedText: "done: committed", compactions: 1 })).toEqual({
      ok: true,
    });
  });

  it("silence AFTER a compaction names settled_after_compaction", () => {
    expect(evaluateCompletion({ capturedText: "   ", compactions: 1 })).toEqual({
      ok: false,
      reason: "settled_after_compaction",
    });
  });

  it("silence with NO compaction names no_final_message", () => {
    expect(evaluateCompletion({ capturedText: "", compactions: 0 })).toEqual({
      ok: false,
      reason: "no_final_message",
    });
  });

  it("an expected final shape is honored", () => {
    const expectedFinal = (t: string) => t.includes("MERGED");
    expect(evaluateCompletion({ capturedText: "not done", compactions: 0, expectedFinal }).ok).toBe(
      false,
    );
    expect(evaluateCompletion({ capturedText: "MERGED", compactions: 0, expectedFinal }).ok).toBe(
      true,
    );
  });

  it("a message that does not match the shape gets its OWN reason — not silence (round 2, item 3)", () => {
    const expectedFinal = (t: string) => t.includes("MERGED");
    expect(
      evaluateCompletion({ capturedText: "I could not finish", compactions: 0, expectedFinal }),
    ).toEqual({ ok: false, reason: "final_shape_mismatch" });
    // Even after a compaction: a message EXISTS, so it is not settled_after_compaction.
    expect(
      evaluateCompletion({ capturedText: "wrong shape", compactions: 2, expectedFinal }).reason,
    ).toBe("final_shape_mismatch");
  });

  it("a failed re-injection OUTRANKS a nonempty final message (round 8)", () => {
    // The whole point of the finding: text alone is not evidence of completion
    // once the task was never re-injected — the agent continued without it.
    expect(
      evaluateCompletion({
        capturedText: "all done, nothing left to do",
        compactions: 1,
        reinjectionFailure: "the session rejected the re-injection",
      }),
    ).toEqual({ ok: false, reason: "reinjection_failed" });
    // It also outranks an expected shape (that predicate would have matched)…
    expect(
      evaluateCompletion({
        capturedText: "MERGED",
        compactions: 1,
        expectedFinal: (t) => t.includes("MERGED"),
        reinjectionFailure: "steer exploded",
      }),
    ).toEqual({ ok: false, reason: "reinjection_failed" });
    // …and it is NOT silence: the empty-text branch never gets to speak.
    expect(
      evaluateCompletion({ capturedText: "", compactions: 1, reinjectionFailure: "x" }).reason,
    ).toBe("reinjection_failed");
    // A run that never failed to re-inject is unaffected.
    expect(evaluateCompletion({ capturedText: "MERGED", compactions: 1 }).ok).toBe(true);
  });
});

describe("compaction contract — the worktree probe", () => {
  it("lists dirty and untracked paths in a git worktree, and '' outside one", () => {
    const dir = scratch("bob-cc-repo-");
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(dir, "a.txt"), "two\n"); // modified
    writeFileSync(join(dir, "untracked.txt"), "x\n"); // untracked
    const status = readWorktreeStatus(dir);
    expect(status).toContain("M a.txt");
    expect(status).toContain("?? untracked.txt");

    const plain = scratch("bob-cc-plain-");
    mkdirSync(join(plain, "work"), { recursive: true });
    expect(readWorktreeStatus(join(plain, "work"))).toBe("");
  });
});
