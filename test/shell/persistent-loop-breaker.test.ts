// persistent-loop-breaker.test.ts — bob#143 item 3. The persistent turn path
// (promptless `bob run` → startPersistent) wires the configured loop limit into
// its admission, fails the affected turn and asks the session to stop, the same
// way a one-shot `bob run` ends on a repeated call. Driven with a fake warm
// session that emits tool_execution_start events during a prompt.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPersistent } from "../../src/shell/persistent.js";
import type { RunSession } from "../../src/shell/run.js";
import { ToolLoopError } from "../../src/shell/tool-loop.js";

interface Call {
  toolName: string;
  args: unknown;
}

// A fake warm session that replays a fixed list of tool calls inside each
// prompt, then returns. `subscribe` lets the admission watch those events.
function loopSession(calls: Call[]): { session: RunSession; aborts: () => number } {
  const listeners: Array<(event: unknown) => void> = [];
  let aborts = 0;
  const session: RunSession = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    async prompt() {
      for (const call of calls) {
        for (const listener of listeners) {
          listener({
            type: "tool_execution_start",
            toolCallId: "t",
            toolName: call.toolName,
            args: call.args,
          });
        }
      }
    },
    async abort() {
      aborts += 1;
    },
    dispose() {
      // no-op
    },
  };
  return { session, aborts: () => aborts };
}

function scaffold(root: string, name: string, extra = ""): void {
  const dir = join(root, name);
  mkdirSync(join(dir, "work"), { recursive: true });
  mkdirSync(join(dir, ".pi-agent"), { recursive: true });
  writeFileSync(
    join(dir, "bob.yaml"),
    [
      "agent:",
      `  id: ${name}`,
      `  name: ${name}`,
      "  role: coder",
      "",
      "provider:",
      "  name: anthropic",
      "  model: claude-x",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
      extra,
    ].join("\n"),
  );
}

const editCall: Call = { toolName: "edit", args: { path: "f.ts", oldText: "a" } };

describe("persistent turn path — the loop breaker", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-persistent-loop-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("aborts the admitted turn at N (default limit) and not at N-1", async () => {
    scaffold(root, "pulse");
    // Default limit is 4: three repeats must NOT fire...
    const short = loopSession([editCall, editCall, editCall]);
    const handleShort = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => short.session,
      log: () => {},
    });
    await handleShort.admitTurn({ kind: "cron", job: "a" }, "hi");
    expect(short.aborts()).toBe(0);
    await handleShort.shutdown();

    // ...four do.
    const full = loopSession([editCall, editCall, editCall, editCall]);
    const handleFull = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => full.session,
      log: () => {},
    });
    await expect(handleFull.admitTurn({ kind: "cron", job: "b" }, "hi")).rejects.toBeInstanceOf(
      ToolLoopError,
    );
    expect(full.aborts()).toBe(1);
    await handleFull.shutdown();
  }, 15_000);

  it("does not fire one short of the limit", async () => {
    scaffold(root, "pulse");
    const fake = loopSession([editCall, editCall, editCall]);
    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => fake.session,
      log: () => {},
    });
    // Default limit 4: three repeats resolve and abort nothing.
    const messages = await handle.admitTurn({ kind: "cron", job: "short" }, "hi");
    expect(messages).toEqual([]);
    expect(fake.aborts()).toBe(0);
    await handle.shutdown();
  }, 15_000);

  it("a different call resets the run, so a broken repeat never fires", async () => {
    scaffold(root, "pulse", "run:\n  tool_loop_limit: 2\n");
    const fake = loopSession([
      editCall,
      { toolName: "read", args: { path: "f.ts" } },
      editCall,
      { toolName: "read", args: { path: "f.ts" } },
      editCall,
    ]);
    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => fake.session,
      log: () => {},
    });
    // limit 2, but no TWO identical calls in a row: the read resets each pair.
    await handle.admitTurn({ kind: "cron", job: "reset" }, "hi");
    expect(fake.aborts()).toBe(0);
    await handle.shutdown();
  }, 15_000);

  it("honours a bob.yaml-configured limit (the configured path, not the default)", async () => {
    // Two identical calls: the default limit of 4 would NOT fire, so this case
    // fails if the YAML value is not threaded into the persistent admission.
    scaffold(root, "pulse", "run:\n  tool_loop_limit: 2\n");
    const fake = loopSession([editCall, editCall]);
    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => fake.session,
      log: () => {},
    });
    await expect(handle.admitTurn({ kind: "cron", job: "yaml" }, "hi")).rejects.toBeInstanceOf(
      ToolLoopError,
    );
    expect(fake.aborts()).toBe(1);
    await handle.shutdown();
  }, 15_000);
});
