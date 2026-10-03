// bob#179: preserve nonempty text after `agent_end` only for stopReason "stop",
// no tool calls, compaction willRetry false, and an accepted completion.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCompactionObserver,
  evaluateCompletion,
} from "../../src/shell/compaction-contract.js";
import type { RunSession, RunSessionFactory } from "../../src/shell/run.js";
import { runAgent } from "../../src/shell/run.js";

const assistantEnd = (text: string, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});

describe("createCompactionObserver — a compaction after agent_end (#179)", () => {
  it("sends no note and keeps terminal text when compaction willRetry is false", () => {
    const injected: string[] = [];
    const observer = createCompactionObserver({
      inject: (t) => injected.push(t),
      isComplete: (text) =>
        evaluateCompletion({
          capturedText: text,
          compactions: 1,
          expectedFinal: (text) => text.startsWith("## DONE"),
        }).ok,
    });
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

  it("clears the boundary and sends the note for a shape-mismatched stop response", () => {
    const injected: string[] = [];
    const observer = createCompactionObserver({
      inject: (t) => injected.push(t),
      isComplete: (text) =>
        evaluateCompletion({
          capturedText: text,
          compactions: 1,
          expectedFinal: (text) => text.startsWith("## DONE"),
        }).ok,
    });
    observer.observe(assistantEnd("partial report"));
    observer.observe({ type: "agent_end", messages: [] });
    observer.observe({ type: "compaction_end", reason: "threshold", willRetry: false });
    expect(observer.finalText()).toBe("");
    expect(observer.assistantEnded()).toBe(false);
    expect(observer.lastEnding()).toBeUndefined();
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("WHAT REMAINS");
  });

  for (const scenario of [
    {
      name: "nonempty length text + successful compaction",
      stopReason: "length",
      willRetry: true,
      result: { summary: "compacted" },
    },
    {
      name: "nonempty length text + failed compaction",
      stopReason: "length",
      willRetry: false,
      errorMessage: "compaction failed",
    },
    {
      name: "text + tool-call checkpoint",
      stopReason: "toolUse",
      willRetry: false,
      toolCall: true,
    },
    { name: "stop text + tool call", stopReason: "stop", willRetry: false, toolCall: true },
    { name: "stop text + retrying compaction", stopReason: "stop", willRetry: true },
    { name: "stop text + unspecified compaction retry", stopReason: "stop" },
    { name: "unspecified stop reason", willRetry: false },
  ]) {
    it(`clears the boundary and sends the note for ${scenario.name}`, () => {
      const injected: string[] = [];
      const observer = createCompactionObserver({ inject: (t) => injected.push(t) });
      observer.observe({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: scenario.stopReason,
          content: [
            { type: "text", text: "partial report" },
            ...(scenario.toolCall
              ? [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }]
              : []),
          ],
        },
      });
      observer.observe({ type: "agent_end", messages: [] });
      observer.observe({ type: "compaction_end", reason: "overflow", aborted: false, ...scenario });
      expect(observer.finalText()).toBe("");
      expect(observer.assistantEnded()).toBe(false);
      expect(observer.lastEnding()).toBeUndefined();
      expect(injected).toHaveLength(1);
      expect(injected[0]).toContain("WHAT REMAINS");
    });
  }

  it("still sends the note when the interrupted run had no final message (overflow retry)", () => {
    const injected: string[] = [];
    const observer = createCompactionObserver({ inject: (t) => injected.push(t) });
    // An error-ended message is not a final message, so the run it left is
    // unfinished and the note still fires.
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

describe("runAgent — terminal responses and compaction recovery (#179)", () => {
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

  function scriptedSession(eventsForPrompt: (text: string) => unknown[]) {
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
        for (const event of eventsForPrompt(text)) {
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

  it("settles exit 0 with no note after a terminal response and non-retrying compaction", async () => {
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
      expectedFinal: (text) => text === "## DONE — PR #178, head a2a00b6a",
    });
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(scripted.steers).toHaveLength(0);
    expect(res.stdout).toBe("## DONE — PR #178, head a2a00b6a");
  });

  it("recovers a shape-mismatched stop response after non-retrying threshold compaction", async () => {
    const scripted = scriptedSession((text) =>
      text === "do the thing"
        ? [
            { type: "agent_start" },
            assistantEnd(" partial report "),
            { type: "agent_end", messages: [] },
            { type: "compaction_end", reason: "threshold", willRetry: false },
          ]
        : [{ type: "agent_start" }, assistantEnd("## DONE"), { type: "agent_end", messages: [] }],
    );
    const judged: string[] = [];
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(scripted.session),
      expectedFinal: (text) => {
        judged.push(text);
        return text === "## DONE";
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(res.stdout).toBe("## DONE");
    expect(scripted.steers).toHaveLength(1);
    expect(scripted.steers[0]).toContain("WHAT REMAINS");
    expect(scripted.prompts).toHaveLength(2);
    expect(scripted.prompts[1]).toContain("BOB CONTINUE");
    expect(judged).toEqual([" partial report ", "## DONE"]);
  });

  it("judges the recovered report after nonempty length text and successful compaction", async () => {
    const scripted = scriptedSession(() => [
      { type: "agent_start" },
      assistantEnd("partial report", "length"),
      { type: "agent_end", messages: [] },
      {
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        willRetry: true,
        result: { summary: "compacted" },
      },
      { type: "agent_start" },
      assistantEnd("recovered report"),
      { type: "agent_end", messages: [] },
    ]);
    const judged: string[] = [];
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(scripted.session),
      expectedFinal: (text) => {
        judged.push(text);
        return text === "recovered report";
      },
    });
    expect(scripted.steers).toHaveLength(1);
    expect(scripted.steers[0]).toContain("WHAT REMAINS");
    expect(judged).toEqual(["recovered report"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("recovered report");
  });

  it("never judges partial length text successful when compaction and recovery fail", async () => {
    let prompts = 0;
    const scripted = scriptedSession(() => {
      if (++prompts > 1) throw new Error("recovery failed");
      return [
        { type: "agent_start" },
        assistantEnd("partial report", "length"),
        { type: "agent_end", messages: [] },
        {
          type: "compaction_end",
          reason: "overflow",
          aborted: false,
          willRetry: false,
          errorMessage: "compaction failed",
        },
      ];
    });
    const judged: string[] = [];
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(scripted.session),
      expectedFinal: (text) => {
        judged.push(text);
        return true;
      },
    });
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("settled_after_compaction");
    expect(res.stdout).toBe("");
    expect(judged).toEqual([]);
    expect(scripted.prompts).toHaveLength(2);
    expect(scripted.steers).toHaveLength(1);
    expect(scripted.steers[0]).toContain("WHAT REMAINS");
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
