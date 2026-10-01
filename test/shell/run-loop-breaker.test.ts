// run-loop-breaker.test.ts — bob#143 item 3. Through runAgent with a fake
// session that emits tool_execution_start events: a run of identical calls ends
// the run non-zero, one short of the limit does not, a different call resets
// the run, and an abort that fails, is missing or does not settle is reported.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSession, RunSessionFactory } from "../../src/shell/run.js";
import { runAgent } from "../../src/shell/run.js";
import { LOOP_ABORT_GRACE_MS } from "../../src/shell/tool-loop.js";

interface Call {
  toolName: string;
  args: unknown;
}

function makeSession(opts: {
  calls: Call[];
  resolve: boolean;
  abort?: "rejects" | "missing" | "pending";
}): {
  session: RunSession;
  aborts: () => number;
} {
  const listeners: Array<(event: unknown) => void> = [];
  let aborts = 0;
  const session: RunSession = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt() {
      for (const call of opts.calls) {
        for (const listener of listeners) {
          listener({
            type: "tool_execution_start",
            toolCallId: "t",
            toolName: call.toolName,
            args: call.args,
          });
        }
      }
      if (opts.resolve) {
        for (const listener of listeners) {
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              stopReason: "stop",
            },
          });
        }
        return;
      }
      return new Promise<void>(() => {});
    },
    async abort() {
      aborts += 1;
      if (opts.abort === "rejects") throw new Error("abort failed");
      if (opts.abort === "pending") await new Promise<void>(() => {});
    },
    dispose() {
      // no-op
    },
  };
  if (opts.abort === "missing") delete session.abort;
  return { session, aborts: () => aborts };
}

function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
}

describe("runAgent loop breaker", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-loop-"));
    const agentDir = join(agentsRoot, "testbot");
    mkdirSync(join(agentDir, "work"), { recursive: true });
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  name: Testbot",
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
    writeFileSync(join(agentDir, "soul.md"), "You are Testbot.");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  const editCall: Call = {
    toolName: "edit",
    args: { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] },
  };

  it("ends the run non-zero when the same call repeats to the limit", async () => {
    const fake = makeSession({ calls: [editCall, editCall, editCall], resolve: false });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      toolLoopLimit: 3,
    });
    expect(res.exitCode).toBe(1);
    expect(res.loopBreaker).toEqual({ toolName: "edit", count: 3 });
    expect(res.failed).toBe(true);
    expect(fake.aborts()).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("reports an abort that fails or is missing, and still ends the run non-zero", async () => {
    for (const abort of ["rejects", "missing"] as const) {
      const fake = makeSession({ calls: [editCall, editCall, editCall], resolve: false, abort });
      const stderr: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let res: Awaited<ReturnType<typeof runAgent>>;
      try {
        res = await runAgent({
          name: "testbot",
          prompt: "hi",
          agentsRoot,
          sessionFactory: factoryReturning(fake.session),
          toolLoopLimit: 3,
        });
      } finally {
        process.stderr.write = write;
      }
      expect(res.exitCode).toBe(1);
      expect(res.loopBreaker).toEqual({ toolName: "edit", count: 3 });
      expect(stderr.join("")).toContain(
        abort === "rejects"
          ? "bob run testbot: could not stop the repeated turn — abort failed"
          : "bob run testbot: could not stop the repeated turn — the session has no abort()",
      );
    }
  }, 15_000);

  it("ends the run non-zero when the abort never settles, within the bound", async () => {
    const fake = makeSession({
      calls: [editCall, editCall, editCall],
      resolve: false,
      abort: "pending",
    });
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const started = Date.now();
    let res: Awaited<ReturnType<typeof runAgent>>;
    try {
      res = await runAgent({
        name: "testbot",
        prompt: "hi",
        agentsRoot,
        sessionFactory: factoryReturning(fake.session),
        toolLoopLimit: 3,
      });
    } finally {
      process.stderr.write = write;
    }
    expect(Date.now() - started).toBeLessThan(LOOP_ABORT_GRACE_MS + 5_000);
    expect(res.exitCode).toBe(1);
    expect(res.loopBreaker).toEqual({ toolName: "edit", count: 3 });
    expect(fake.aborts()).toBe(1);
    expect(stderr.join("")).toContain(
      `bob run testbot: the stop request did not settle within ${LOOP_ABORT_GRACE_MS}ms; ending the run anyway`,
    );
  }, 15_000);

  it("does not fire one short of the limit", async () => {
    const fake = makeSession({ calls: [editCall, editCall], resolve: true });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      toolLoopLimit: 3,
    });
    expect(res.exitCode).toBe(0);
    expect(res.loopBreaker).toBeUndefined();
  }, 15_000);

  it("a different call resets the run, so a broken repeat never fires", async () => {
    const fake = makeSession({
      calls: [editCall, editCall, { toolName: "read", args: { path: "f.ts" } }, editCall, editCall],
      resolve: true,
    });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      toolLoopLimit: 3,
    });
    expect(res.exitCode).toBe(0);
    expect(res.loopBreaker).toBeUndefined();
  }, 15_000);

  it("different arguments are a different call", async () => {
    const fake = makeSession({
      calls: [
        { toolName: "edit", args: { a: 1 } },
        { toolName: "edit", args: { a: 2 } },
        { toolName: "edit", args: { a: 1 } },
      ],
      resolve: true,
    });
    const res = await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionFactory: factoryReturning(fake.session),
      toolLoopLimit: 2,
    });
    expect(res.exitCode).toBe(0);
    expect(res.loopBreaker).toBeUndefined();
  }, 15_000);
});
