import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAlign } from "../src/align.js";
import type { SpawnFn } from "../src/onboard.js";

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

describe("runAlign", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "bob-align-"));
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    mkdirSync(join(agentDir, "work"), { recursive: true });
    writeFileSync(join(agentDir, "soul.md"), "current persona\n");
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("refuses to run when soul.md does not exist", async () => {
    rmSync(join(agentDir, "soul.md"));
    await expect(
      runAlign({
        name: "testbot",
        agentDir,
        provider: "ollama-cloud",
        model: "kimi-k2.6",
        spawnFn: fakeSpawn({}),
      }),
    ).rejects.toThrow(/cannot align/);
  });

  it("spawns pi with the alignment meta-prompt", async () => {
    let capturedArgs: readonly string[] = [];
    const spawnFn = fakeSpawn({
      onSpawn: (_cmd, args) => {
        capturedArgs = args;
      },
    });
    await runAlign({
      name: "testbot",
      agentDir,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      spawnFn,
    });
    expect(capturedArgs).toContain("--append-system-prompt");
    const sysIdx = capturedArgs.indexOf("--append-system-prompt");
    expect(capturedArgs[sysIdx + 1]).toContain("alignment check");
    expect(capturedArgs[sysIdx + 1]).toContain("drift");
    expect(capturedArgs[sysIdx + 1]).toContain("testbot");
  });

  it("reports soulUpdated=true when soul.md changes during the session", async () => {
    const spawnFn = fakeSpawn({
      onSpawn: () => {
        writeFileSync(join(agentDir, "soul.md"), "updated persona\n");
      },
    });
    const res = await runAlign({
      name: "testbot",
      agentDir,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      spawnFn,
    });
    expect(res.soulUpdated).toBe(true);
    expect(res.soulHashBefore).not.toBe(res.soulHashAfter);
  });

  it("reports soulUpdated=false when nothing was changed", async () => {
    const spawnFn = fakeSpawn({});
    const res = await runAlign({
      name: "testbot",
      agentDir,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      spawnFn,
    });
    expect(res.soulUpdated).toBe(false);
  });
});
