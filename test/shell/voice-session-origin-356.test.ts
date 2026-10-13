// bob#356: which sessions the RUNTIME declares an origin for. Only an
// operator's one-shot `bob run` (the CLI entry) declares `run`; a prompted
// `bob launch`, a mail turn (its sender is not an operator) and the persistent
// runtime (served by turn admission) declare none — so a tool call there is
// bound only by an admitted turn, or not at all.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeMailTurnInput } from "../../src/capabilities/tps-mail/prompt.js";
import { startPersistent } from "../../src/shell/persistent.js";
import {
  type RunSession,
  type RunSessionConfig,
  runAgent,
  runLaunch,
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

describe("bob#356 — the runtime-declared session origin", () => {
  it("runAgent declares `run` ONLY when its caller (the `bob run` CLI entry) says so", async () => {
    const declared = capture();
    await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot,
      sessionOrigin: { kind: "run" },
      sessionFactory: declared.factory,
    });
    expect(declared.seen[0]?.sessionOrigin).toEqual({ kind: "run" });
    const plain = capture();
    await runAgent({ name: "testbot", prompt: "hi", agentsRoot, sessionFactory: plain.factory });
    expect(plain.seen[0]?.sessionOrigin).toBeUndefined();
  });

  it("a PROMPTED `bob launch` declares nothing: its tool calls are unbound", async () => {
    const c = capture();
    const code = await runLaunch({
      name: "testbot",
      prompt: "say hello",
      agentsRoot,
      sessionFactory: c.factory,
    });
    expect(code).toBe(0);
    expect(c.seen[0]).toBeDefined();
    expect(c.seen[0]?.sessionOrigin).toBeUndefined();
  });

  it("the `bob run` CLI entry is the one caller that passes the `run` origin", () => {
    // src/cli.ts runs on import, so this reads its source: the one-shot
    // runAgent call in run() declares the origin, and nothing else in the CLI
    // or in runLaunch does.
    const cli = readFileSync(join(import.meta.dirname, "..", "..", "src", "cli.ts"), "utf8");
    const runFn = cli.slice(
      cli.indexOf("async function run("),
      cli.indexOf("async function installServiceCmd"),
    );
    expect(runFn).toContain('sessionOrigin: { kind: "run" }');
    expect(cli.split('sessionOrigin: { kind: "run" }').length - 1).toBe(1);
    const runTs = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "shell", "run.ts"),
      "utf8",
    );
    const launch = runTs.slice(
      runTs.indexOf("export async function runLaunch"),
      runTs.indexOf("export function watchParent"),
    );
    expect(launch).not.toContain("sessionOrigin");
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
