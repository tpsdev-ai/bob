import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnboard, type SpawnFn } from "../src/onboard.js";

// Fake ChildProcess that emits 'exit' on next tick. The test controls
// what soul.md looks like before vs. after the "child" runs by writing
// to soul.md from inside the spawn callback.
function fakeSpawn(opts: {
  exitCode?: number;
  onSpawn?: (cmd: string, args: readonly string[]) => void;
}): SpawnFn {
  return (cmd, args) => {
    const ee = new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
    opts.onSpawn?.(cmd, args as readonly string[]);
    queueMicrotask(() => ee.emit("exit", opts.exitCode ?? 0));
    // biome-ignore lint/suspicious/noExplicitAny: minimal ChildProcess stub
    return ee as any;
  };
}

describe("runOnboard", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "bob-onboard-"));
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    mkdirSync(join(agentDir, "work"), { recursive: true });
    writeFileSync(join(agentDir, "soul.md"), "seed persona\n");
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("spawns pi with the onboarding meta-prompt", async () => {
    let capturedArgs: readonly string[] = [];
    const spawnFn = fakeSpawn({
      onSpawn: (_cmd, args) => {
        capturedArgs = args;
      },
    });
    await runOnboard({
      name: "testbot",
      role: "ea",
      agentDir,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      spawnFn,
    });
    expect(capturedArgs).toContain("--append-system-prompt");
    const sysIdx = capturedArgs.indexOf("--append-system-prompt");
    expect(capturedArgs[sysIdx + 1]).toContain("hiring interview");
    expect(capturedArgs[sysIdx + 1]).toContain("testbot");
    expect(capturedArgs[sysIdx + 1]).toContain("ea");
  });

  it("passes provider + model + session-dir through to pi", async () => {
    let capturedArgs: readonly string[] = [];
    const spawnFn = fakeSpawn({
      onSpawn: (_cmd, args) => {
        capturedArgs = args;
      },
    });
    await runOnboard({
      name: "testbot",
      role: "ea",
      agentDir,
      provider: "anthropic",
      model: "claude-opus-4-7",
      spawnFn,
    });
    expect(capturedArgs).toContain("--provider");
    expect(capturedArgs[capturedArgs.indexOf("--provider") + 1]).toBe("anthropic");
    expect(capturedArgs).toContain("--model");
    expect(capturedArgs[capturedArgs.indexOf("--model") + 1]).toBe("claude-opus-4-7");
    expect(capturedArgs).toContain("--session-dir");
    expect(capturedArgs[capturedArgs.indexOf("--session-dir") + 1]).toBe(
      join(agentDir, ".pi-agent"),
    );
  });

  it("reports soulUpdated=true when soul.md changes during the session", async () => {
    const spawnFn = fakeSpawn({
      onSpawn: () => {
        // Simulate the agent rewriting soul.md
        writeFileSync(join(agentDir, "soul.md"), "refined persona\n");
      },
    });
    const res = await runOnboard({
      name: "testbot",
      role: "ea",
      agentDir,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      spawnFn,
    });
    expect(res.soulUpdated).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.soulHashBefore).not.toBe(res.soulHashAfter);
  });

  it("reports soulUpdated=false when the agent never touched soul.md", async () => {
    const spawnFn = fakeSpawn({});
    const res = await runOnboard({
      name: "testbot",
      role: "ea",
      agentDir,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      spawnFn,
    });
    expect(res.soulUpdated).toBe(false);
    expect(res.soulHashBefore).toBe(res.soulHashAfter);
  });

  it("propagates non-zero exit codes from pi", async () => {
    const spawnFn = fakeSpawn({ exitCode: 130 }); // SIGINT exit code
    const res = await runOnboard({
      name: "testbot",
      role: "ea",
      agentDir,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      spawnFn,
    });
    expect(res.exitCode).toBe(130);
  });
});
