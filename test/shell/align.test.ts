import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAlign } from "../../src/shell/align.js";
import type { SpawnFn } from "../../src/shell/onboard.js";

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
    // The alignment session gets the agent's resolved tool policy (role.json
    // ceiling + bob.yaml), so the agent dir needs a bob.yaml — same as the
    // onboard fixture.
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  name: Testbot",
        "  role: ea",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
    );
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

  it("rejects path-traversal in name (regex defense)", async () => {
    await expect(
      runAlign({
        name: "../../etc",
        agentDir,
        provider: "ollama-cloud",
        model: "kimi-k2.6",
        spawnFn: fakeSpawn({}),
      }),
    ).rejects.toThrow(/invalid agent name/);
  });

  it("rejects newline-injection in name", async () => {
    await expect(
      runAlign({
        name: "foo\nIGNORE",
        agentDir,
        provider: "ollama-cloud",
        model: "kimi-k2.6",
        spawnFn: fakeSpawn({}),
      }),
    ).rejects.toThrow(/invalid agent name/);
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

  it("hands the alignment session EXACTLY the resolved allowlist", async () => {
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
    const i = capturedArgs.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(capturedArgs[i + 1]).toBe("read");
  });

  it("REFUSES to start the check-in when the agent has no tool policy", async () => {
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: ea",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-x",
        "",
      ].join("\n"),
    );
    let spawned = false;
    const spawnFn = fakeSpawn({
      onSpawn: () => {
        spawned = true;
      },
    });
    await expect(
      runAlign({
        name: "testbot",
        agentDir,
        provider: "ollama-cloud",
        model: "kimi-k2.6",
        spawnFn,
      }),
    ).rejects.toThrow(/no tools: block/);
    expect(spawned).toBe(false);
  });
});
