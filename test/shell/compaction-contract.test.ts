// The completion contract and the best-effort "what remains" note (#145).
//
// The CONTRACT lives in the system prompt (system-prompt-contract.ts); what is
// pinned here is the other half: the ONE judge a one-shot run's exit code comes
// from, and the note that accompanies a compaction without ever being
// load-bearing.
import { describe, expect, it } from "bun:test";
import {
  buildRemainingNote,
  buildStandingContract,
  capText,
  createCompactionObserver,
  DEFAULT_REMAINING_NOTE_CAP_CHARS,
  evaluateCompletion,
  readWorktreeStatus,
  renderWorktreeNote,
} from "../../src/shell/compaction-contract.js";

/** One assistant turn: streamed deltas, then the message that ENDS it. */
function assistantTurn(text: string, opts: { deltas?: string[]; stopReason?: string } = {}) {
  const events: unknown[] = [
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: opts.deltas?.[0] ?? text },
    },
  ];
  events.push({
    type: "message_end",
    message: {
      role: "assistant",
      content: opts.stopReason === "error" ? [] : [{ type: "text", text }],
      stopReason: opts.stopReason ?? "stop",
    },
  });
  return events;
}

describe("evaluateCompletion — the one judge", () => {
  it("passes with a final message", () => {
    expect(
      evaluateCompletion({ capturedText: "done: committed and pushed", compactions: 0 }),
    ).toEqual({
      ok: true,
    });
  });

  it("names silence WITHOUT a compaction as no_final_message", () => {
    expect(evaluateCompletion({ capturedText: "", compactions: 0 })).toEqual({
      ok: false,
      reason: "no_final_message",
    });
  });

  it("names silence AFTER a compaction as settled_after_compaction", () => {
    expect(evaluateCompletion({ capturedText: "  \n ", compactions: 2 })).toEqual({
      ok: false,
      reason: "settled_after_compaction",
    });
  });

  it("gives a message that misses the declared shape its OWN reason (it is not silence)", () => {
    expect(
      evaluateCompletion({
        capturedText: "I think I am done",
        compactions: 1,
        expectedFinal: (t) => t.includes("COMMITTED:"),
      }),
    ).toEqual({ ok: false, reason: "final_shape_mismatch" });
  });

  it("decides emptiness on the TRIM, but hands expectedFinal the VERBATIM text", () => {
    // Only emptiness is judged on the trimmed text: an all-whitespace message is
    // no final message …
    expect(evaluateCompletion({ capturedText: "\n\n", compactions: 0 }).ok).toBe(false);
    // … while a shape predicate sees exactly what the message ended with.
    const seen: string[] = [];
    expect(
      evaluateCompletion({
        capturedText: "  padded \n",
        compactions: 0,
        expectedFinal: (t) => {
          seen.push(t);
          return t === "  padded \n";
        },
      }).ok,
    ).toBe(true);
    expect(seen).toEqual(["  padded \n"]);
  });
});

describe("createCompactionObserver", () => {
  it("counts non-aborted compactions only", () => {
    const observer = createCompactionObserver();
    observer.observe({ type: "compaction_end", reason: "threshold", aborted: false });
    observer.observe({ type: "compaction_end", reason: "manual", aborted: true });
    observer.observe({ type: "compaction_end", reason: "overflow" });
    expect(observer.compactions()).toBe(2);
  });

  it("reads the final message from the ENDED message, never from the streamed deltas", () => {
    const observer = createCompactionObserver();
    const [update, ended] = assistantTurn("assembled text", { deltas: ["assembl"] });
    observer.observe(update);
    expect(observer.finalText()).toBe("");
    expect(observer.assistantEnded()).toBe(false);
    observer.observe(ended);
    expect(observer.finalText()).toBe("assembled text");
    expect(observer.assistantEnded()).toBe(true);
  });

  it("treats an error-ended message as no final message, and its partial text as no plan", () => {
    const observer = createCompactionObserver();
    observer.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    });
    expect(observer.finalText()).toBe("");
    expect(observer.assistantEnded()).toBe(true);
    // The plan capture ignores a failed stream's partial text too: the next
    // compaction's note has nothing to quote.
    const injected: string[] = [];
    const second = createCompactionObserver({ inject: (t) => injected.push(t) });
    second.observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "half" },
    });
    second.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    });
    second.observe({ type: "compaction_end", reason: "threshold" });
    expect(injected[0]).toContain("No plan was captured");
  });

  it("never lets streamed deltas stand in for a FAILURE-ended message", () => {
    // pi ends a failed stream by ending the assistant message with EMPTY content.
    // The deltas streamed before that are not the message — substituting them is
    // how a failed run could claim a final message it never had.
    const observer = createCompactionObserver();
    observer.observe({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "half a sentence" },
    });
    observer.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    });
    expect(observer.finalText()).toBe("");
    expect(observer.assistantEnded()).toBe(true);
  });

  it("clears the capture at a compaction (text before it is not the final message)", () => {
    const observer = createCompactionObserver();
    observer.observe({ type: "compaction_end", reason: "threshold" });
    expect(observer.compactions()).toBe(1);
    for (const event of assistantTurn("before the compaction")) observer.observe(event);
    expect(observer.finalText()).toBe("before the compaction");
    observer.observe({ type: "compaction_end", reason: "threshold" });
    expect(observer.finalText()).toBe("");
    expect(observer.assistantEnded()).toBe(false);
  });

  it("clears the capture at startTurn (the retry is its own turn)", () => {
    const observer = createCompactionObserver();
    for (const event of assistantTurn("first turn")) observer.observe(event);
    expect(observer.finalText()).toBe("first turn");
    observer.startTurn();
    expect(observer.finalText()).toBe("");
  });

  it("sends ONE best-effort note per compaction, quoting the plan it captured", () => {
    const injected: string[] = [];
    const observer = createCompactionObserver({ inject: (t) => injected.push(t) });
    for (const event of assistantTurn("Step 1: write the file; step 2: commit")) {
      observer.observe(event);
    }
    observer.observe({ type: "compaction_end", reason: "threshold", aborted: false });
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("WHAT REMAINS");
    expect(injected[0]).toContain("Step 1: write the file; step 2: commit");
    expect(injected[0]).toContain("system prompt");
    // An aborted compaction changed nothing, so nothing is sent.
    observer.observe({ type: "compaction_end", reason: "manual", aborted: true });
    expect(injected).toHaveLength(1);
  });

  it("falls back to a worktree note (git status + recent tool calls) when no plan was captured", () => {
    const injected: string[] = [];
    const observer = createCompactionObserver({
      inject: (t) => injected.push(t),
      worktreeStatus: () => " M src/a.ts\n?? src/b.ts",
    });
    observer.observe({ type: "tool_execution_start", toolName: "write" });
    observer.observe({ type: "tool_execution_start", toolName: "bash" });
    observer.observe({ type: "compaction_end", reason: "threshold" });
    expect(injected[0]).toContain("No plan was captured");
    expect(injected[0]).toContain("git status --short:");
    expect(injected[0]).toContain("M src/a.ts");
    expect(injected[0]).toContain("write, bash");
  });

  it("LOGS a failed note and nothing else happens (it is not load-bearing)", () => {
    const logs: string[] = [];
    const observer = createCompactionObserver({
      inject: () => {
        throw new Error("the session refused the steer");
      },
      log: (m) => logs.push(m),
    });
    for (const event of assistantTurn("a plan")) observer.observe(event);
    expect(() => observer.observe({ type: "compaction_end", reason: "threshold" })).not.toThrow();
    expect(logs.join("\n")).toContain('could not send the "what remains" note');
    expect(logs.join("\n")).toContain("the session refused the steer");
    expect(logs.join("\n")).toContain("best-effort");
  });

  it("LOGS an async rejection from the note too, and still does not throw", () => {
    const logs: string[] = [];
    const observer = createCompactionObserver({
      inject: () => Promise.reject(new Error("late rejection")),
      log: (m) => logs.push(m),
    });
    observer.observe({ type: "compaction_end", reason: "threshold" });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(logs.join("\n")).toContain("late rejection");
        resolve();
      }, 0);
    });
  });

  it("keeps a note it sends inside its cap", () => {
    const injected: string[] = [];
    const observer = createCompactionObserver({
      inject: (t) => injected.push(t),
      noteCapChars: 700,
    });
    for (const event of assistantTurn("plan ".repeat(2000))) observer.observe(event);
    observer.observe({ type: "compaction_end", reason: "threshold" });
    expect(injected[0].length).toBeLessThanOrEqual(700);
    expect(injected[0]).toContain("[truncated]");
  });
});

describe("buildStandingContract (the persistent runtime's text)", () => {
  it("names the agent, its role and its duties", () => {
    const contract = buildStandingContract({
      name: "testbot",
      role: "ea",
      duties: [
        { name: "inbox sweep", schedule: "*/5 * * * *", prompt: "sweep the inbox" },
        { name: "no schedule", prompt: "do the thing" },
      ],
    });
    expect(contract).toContain("You are testbot, on duty as ea for this office.");
    expect(contract).toContain("Standing duties:");
    expect(contract).toContain("- inbox sweep (*/5 * * * *): sweep the inbox");
    expect(contract).toContain("- no schedule: do the thing");
  });

  it('falls back to "this agent" and omits the duty list when there are none', () => {
    const contract = buildStandingContract({});
    expect(contract).toContain("You are this agent for this office.");
    expect(contract).not.toContain("Standing duties:");
  });
});

describe("the note's building blocks", () => {
  it("renderWorktreeNote bounds the status lines and the tool calls", () => {
    const note = renderWorktreeNote(
      {
        gitStatus: Array.from({ length: 5 }, (_, i) => ` M file${i}.ts`).join("\n"),
        recentToolCalls: ["a", "b", "c", "d", "e", "f"],
      },
      { statusLines: 2, toolCalls: 3 },
    );
    expect(note).toContain(" M file0.ts");
    expect(note).toContain(" M file1.ts");
    expect(note).not.toContain("file2.ts");
    expect(note).toContain("… (3 more path(s))");
    expect(note).toContain("last 3 tool call(s): d, e, f");
  });

  it("buildRemainingNote never exceeds its cap, marker included", () => {
    const note = buildRemainingNote({ lastStatedPlan: "p".repeat(5000) }, 400);
    expect(note.length).toBeLessThanOrEqual(400);
    expect(note.startsWith("[BOB WHAT REMAINS")).toBe(true);
    expect(note.length).toBeLessThanOrEqual(DEFAULT_REMAINING_NOTE_CAP_CHARS);
  });

  it('capText cuts hard when there is no room for the marker, and yields "" for no cap', () => {
    expect(capText("abcdefgh", 4)).toBe("abcd"); // marker does not fit
    expect(capText("abcdefgh", 0)).toBe("");
    expect(capText("short", 100)).toBe("short");
  });

  it('readWorktreeStatus is best-effort: a non-repo directory yields ""', () => {
    expect(readWorktreeStatus("/definitely/not/a/repo/at/all")).toBe("");
  });
});
