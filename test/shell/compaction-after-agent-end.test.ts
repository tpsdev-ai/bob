// bob#179: a compaction that starts AFTER `agent_end` must not re-prompt a
// finished run. The run's completion is recorded at `agent_end`; a later
// compaction neither clears that final message nor queues the "what remains"
// note (which would start another turn). A compaction that interrupts a live
// run still sends the note.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompactionObserver } from "../../src/shell/compaction-contract.js";
import type { RunSession, RunSessionFactory } from "../../src/shell/run.js";
import { runAgent } from "../../src/shell/run.js";

const assistantEnd = (text: string, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});

describe("createCompactionObserver — a compaction after agent_end (#179)", () => {
  it("sends no note and keeps the final message when the agent ended before the compaction", () => {
    const injected: string[] = [];
    const observer = createCompactionObserver({ inject: (t) => injected.push(t) });
    observer.observe(assistantEnd("## DONE — PR #178, head a2a00b6a"));
    observer.observe({ type: "agent_end", messages: [] });
    observer.observe({ type: "compaction_start", reason: "overflow" });
    observer.observe({
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: false,
    });
    expect(injected).toHaveLength(0);
    // The completion the run already recorded survives the post-completion compaction.
    expect(observer.finalText()).toBe("## DONE — PR #178, head a2a00b6a");
  });

  it("still sends the note when the interrupted run had no final message (overflow retry)", () => {
    const injected: string[] = [];
    const observer = createCompactionObserver({ inject: (t) => injected.push(t) });
    // A failed/length-stopped message is not a final message, so the run is unfinished.
    observer.observe({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    });
    observer.observe({ type: "agent_end", messages: [] });
    observer.observe({ type: "compaction_end", reason: "overflow", willRetry: true });
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("WHAT REMAINS");
  });

  it("still sends the note when the compaction interrupts a live run (no agent_end yet)", () => {
    const injected: string[] = [];
    const observer = createCompactionObserver({ inject: (t) => injected.push(t) });
    observer.observe({ type: "agent_start" });
    observer.observe({ type: "compaction_end", reason: "threshold" });
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("WHAT REMAINS");
  });
});

describe("runAgent — a compaction after agent_end ends the run (#179)", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-run-179-"));
    const agentDir = join(agentsRoot, "testbot");
    mkdirSync(join(agentDir, "work"), { recursive: true });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-sonnet-4-6",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  /** A session that emits scripted events on each real prompt and records the
   *  steers it is asked for. A steer never becomes a turn here. */
  function scriptedSession(eventsForPrompt: () => unknown[]) {
    const prompts: string[] = [];
    const steers: string[] = [];
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => {};
      },
      async steer(text: string) {
        steers.push(text);
      },
      async prompt(text: string, options?: unknown) {
        const streaming = (options as { streamingBehavior?: string } | undefined)
          ?.streamingBehavior;
        if (streaming !== undefined) return;
        prompts.push(text);
        for (const event of eventsForPrompt()) {
          for (const listener of listeners) listener(event);
        }
      },
      dispose() {},
    } as unknown as RunSession;
    return { session, prompts, steers };
  }

  const factoryReturning =
    (session: RunSession): RunSessionFactory =>
    async () =>
      session;

  it("settles exit 0 with no note and no second turn when the compaction lands after agent_end", async () => {
    const scripted = scriptedSession(() => [
      { type: "agent_start" },
      assistantEnd("## DONE — PR #178, head a2a00b6a"),
      { type: "agent_end", messages: [] },
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", aborted: false, willRetry: false },
    ]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(scripted.session),
    });
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(scripted.steers).toHaveLength(0);
    expect(scripted.prompts).toHaveLength(1);
    expect(res.stdout).toBe("## DONE — PR #178, head a2a00b6a");
  });

  it('still sends the "what remains" note when the compaction interrupts an unfinished run', async () => {
    const scripted = scriptedSession(() => [
      { type: "agent_start" },
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false },
      assistantEnd("carried on after the compaction"),
    ]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: factoryReturning(scripted.session),
    });
    expect(res.exitCode).toBe(0);
    expect(scripted.steers).toHaveLength(1);
    expect(scripted.steers[0]).toContain("WHAT REMAINS");
    expect(scripted.prompts).toHaveLength(1);
  });
});
