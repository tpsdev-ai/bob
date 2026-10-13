// bob#356 round 1: which sessions the RUNTIME declares an origin for. Only an
// operator's one-shot `bob run` declares `run`; a mail turn (its sender is not
// an operator) and the persistent runtime (served by turn admission) declare
// none — so a tool call there is bound only by an admitted turn, or not at all.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeMailTurnInput } from "../../src/capabilities/tps-mail/prompt.js";
import { startPersistent } from "../../src/shell/persistent.js";
import {
  type RunSession,
  type RunSessionConfig,
  runAgent,
  runMailTurnLaunch,
} from "../../src/shell/run.js";

let agentsRoot: string;
beforeEach(() => {
  agentsRoot = mkdtempSync(join(tmpdir(), "bob-origin-356-"));
  const agentDir = join(agentsRoot, "testbot");
  mkdirSync(join(agentDir, "work"), { recursive: true });
  mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
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
      "  context_window: 200000",
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

function capture(): {
  factory: (c: RunSessionConfig) => Promise<RunSession>;
  seen: RunSessionConfig[];
} {
  const seen: RunSessionConfig[] = [];
  const listeners: Array<(e: unknown) => void> = [];
  const session: RunSession = {
    subscribe(l) {
      listeners.push(l as (e: unknown) => void);
      return () => {};
    },
    async prompt() {
      for (const l of listeners) {
        l({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
          },
        });
      }
    },
    dispose() {},
  };
  return {
    seen,
    factory: async (c) => {
      seen.push(c);
      return session;
    },
  };
}

describe("bob#356 round 1 — the runtime-declared session origin", () => {
  it("a one-shot `bob run` declares `run`", async () => {
    const c = capture();
    await runAgent({ name: "testbot", prompt: "hi", agentsRoot, sessionFactory: c.factory });
    expect(c.seen[0]?.sessionOrigin).toEqual({ kind: "run" });
  });

  it("a MAIL turn declares nothing (its sender is not an operator)", async () => {
    const c = capture();
    const code = await runMailTurnLaunch({
      name: "testbot",
      input: serializeMailTurnInput({ sender: "flint", messageId: "m-1", body: "hello" }),
      agentsRoot,
      sessionFactory: c.factory,
      write: async () => {},
    });
    expect(code).toBe(0);
    expect(c.seen[0]?.sessionOrigin).toBeUndefined();
  });

  it("the PERSISTENT runtime declares nothing: its turn admission binds origins", async () => {
    const c = capture();
    const handle = await startPersistent({
      name: "testbot",
      agentsRoot,
      installSignalHandlers: false,
      keepAlive: async () => {},
      sessionFactory: c.factory,
    });
    try {
      expect(c.seen[0]?.sessionOrigin).toBeUndefined();
      expect(c.seen[0]?.turnAdmission).toBeDefined();
    } finally {
      await handle.shutdown();
    }
  });
});
