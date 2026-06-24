import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPersistent, startPersistent } from "../src/persistent.js";
import type { RunSession, RunSessionConfig, RunSessionFactory } from "../src/run.js";

// A fake warm AgentSession. Records every prompt, tracks idle/dispose, and
// emits canned assistant text via the documented agent_end-style flow. Lets us
// prove the session stays usable across MULTIPLE prompts without an LLM.
function fakeWarmSession(): {
  session: RunSession;
  prompts: string[];
  disposed: () => boolean;
  idleWaits: () => number;
} {
  const prompts: string[] = [];
  let disposed = false;
  let idleWaits = 0;
  const session: RunSession = {
    subscribe() {
      return () => {};
    },
    async prompt(text: string) {
      if (disposed) throw new Error("prompt() after dispose() — session was torn down");
      prompts.push(text);
    },
    async waitForIdle() {
      // The persistent runtime awaits this before disposing so a SIGTERM
      // doesn't cut off an in-flight turn.
      idleWaits += 1;
    },
    dispose() {
      disposed = true;
    },
  };
  return {
    session,
    prompts,
    disposed: () => disposed,
    idleWaits: () => idleWaits,
  };
}

// A minimal on-disk agent so resolveRunConfig (bob.yaml + dirs) succeeds without
// touching ~/agents. No capabilities declared — the persistent path is exercised
// with the injected fake factory, so no real extension load.
function scaffoldAgent(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(join(dir, "work"), { recursive: true });
  mkdirSync(join(dir, ".pi-agent"), { recursive: true });
  writeFileSync(
    join(dir, "bob.yaml"),
    ["agent:", `  id: ${name}`, "provider:", "  name: anthropic", "  model: claude-x", ""].join(
      "\n",
    ),
  );
}

describe("runPersistent / startPersistent", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-persistent-"));
    scaffoldAgent(root, "pulse");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("builds ONE warm session that stays usable across multiple prompts", async () => {
    const fake = fakeWarmSession();
    const factory: RunSessionFactory = async () => fake.session;

    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: factory,
      log: () => {},
    });

    // The session is reused — multiple sendUserMessage-equivalent prompts over
    // its lifetime, no re-creation, no dispose between them.
    await handle.session.prompt("first");
    await handle.session.prompt("second");
    await handle.session.prompt("third");
    expect(fake.prompts).toEqual(["first", "second", "third"]);
    expect(fake.disposed()).toBe(false);

    await handle.shutdown();
    expect(fake.disposed()).toBe(true);
  });

  it("passes the resolved provider/model through", async () => {
    const fake = fakeWarmSession();
    let seen: RunSessionConfig | undefined;
    const factory: RunSessionFactory = async (config) => {
      seen = config;
      return fake.session;
    };
    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: factory,
      log: () => {},
    });
    expect(handle.provider).toBe("anthropic");
    expect(handle.model).toBe("claude-x");
    expect(seen?.provider).toBe("anthropic");
    await handle.shutdown();
  });

  it("a per-call model override wins over bob.yaml", async () => {
    const fake = fakeWarmSession();
    const factory: RunSessionFactory = async () => fake.session;
    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      model: "claude-fast",
      sessionFactory: factory,
      log: () => {},
    });
    expect(handle.model).toBe("claude-fast");
    await handle.shutdown();
  });

  it("shutdown() awaits in-flight work (waitForIdle) before disposing", async () => {
    const fake = fakeWarmSession();
    const factory: RunSessionFactory = async () => fake.session;
    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: factory,
      log: () => {},
    });
    await handle.shutdown();
    expect(fake.idleWaits()).toBe(1); // awaited idle exactly once
    expect(fake.disposed()).toBe(true);
  });

  it("shutdown() is idempotent (a second SIGTERM doesn't double-dispose)", async () => {
    let disposeCount = 0;
    const session: RunSession = {
      subscribe: () => () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      dispose: () => {
        disposeCount += 1;
      },
    };
    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => session,
      log: () => {},
    });
    await Promise.all([handle.shutdown(), handle.shutdown()]);
    await handle.shutdown();
    expect(disposeCount).toBe(1);
  });

  it("runPersistent returns once the injected keepAlive resolves, disposing the session", async () => {
    const fake = fakeWarmSession();
    let exited: number | undefined;
    await runPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => fake.session,
      installSignalHandlers: false, // don't touch real process signals in tests
      keepAlive: () => Promise.resolve(), // resolve immediately so the call returns
      exit: (c) => {
        exited = c;
      },
      log: () => {},
    });
    // No signal fired, so exit() not called; but the session is disposed on return.
    expect(exited).toBeUndefined();
    expect(fake.disposed()).toBe(true);
  });

  it("the default keepAlive holds NODE's event loop alive (ops-d7t1 restart-loop)", () => {
    // Regression for the systemd restart-loop. The keep-alive used to be a bare
    // `new Promise(() => {})`. On NODE that is NOT enough: with nothing else in
    // the loop (the persistent runtime's signal handlers are `process.once`,
    // which do not count as active handles) Node sees an empty loop and EXITS 0
    // → systemd Restart=always loops `bob run <name>` every few seconds, so the
    // agent never stays up to receive work.
    //
    // This MUST run under real `node` to catch the bug: bun blocks on a bare
    // never-resolving promise (the inverse trap), so a same-process bun test
    // can't distinguish the broken form from the fixed one. We spawn node on a
    // script that uses the SHIPPED default keep-alive (an active interval handle
    // inside a never-resolving promise) and assert the process is still running
    // after a grace window (timeout kills it → non-zero), vs. the old bare-
    // promise form which we assert exits ~immediately with code 0.
    const fixed = [
      'process.once("SIGTERM", () => process.exit(0));',
      "async function keepAlive(){ await new Promise(() => { setInterval(() => {}, 1 << 30); }); }",
      "keepAlive();",
    ].join("\n");
    const broken = [
      'process.once("SIGTERM", () => process.exit(0));',
      "async function keepAlive(){ await new Promise(() => {}); }",
      "keepAlive();",
    ].join("\n");

    // The fixed form stays alive → spawnSync's `timeout` kills it, reported as
    // `error.code === "ETIMEDOUT"`. The broken form exits on its own before the
    // window, so there is no timeout error.
    const runFixed = spawnSync(process.execPath, ["-e", fixed], { timeout: 1500 });
    const runBroken = spawnSync(process.execPath, ["-e", broken], { timeout: 1500 });

    // Broken: node exited on its own (no timeout kill) — the restart-loop bug.
    expect(runBroken.error).toBeUndefined();
    // Fixed: node was still alive at the timeout → killed by spawnSync.
    expect((runFixed.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
  });

  it("throws (fast) when the agent dir is missing — no silent under-equipped run", async () => {
    await expect(
      startPersistent({
        name: "ghost",
        agentsRoot: root,
        sessionFactory: async () => fakeWarmSession().session,
        log: () => {},
      }),
    ).rejects.toThrow(/agent dir not found/);
  });

  it("a real SIGTERM triggers a graceful dispose then exit(0)", async () => {
    const fake = fakeWarmSession();
    let exited: number | undefined;
    let keepAliveResolve: (() => void) | undefined;
    const keepAlive = () =>
      new Promise<void>((resolve) => {
        keepAliveResolve = resolve;
      });

    const done = runPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => fake.session,
      installSignalHandlers: true,
      keepAlive,
      exit: (c) => {
        exited = c;
        // Release the keepAlive so runPersistent can return after the handler.
        keepAliveResolve?.();
      },
      log: () => {},
    });

    // Let startPersistent + handler registration settle.
    await new Promise((r) => setTimeout(r, 10));
    // Fire a real SIGTERM at this process; runPersistent registered a
    // process.once("SIGTERM") handler that disposes + exits.
    process.emit("SIGTERM");

    await done;
    expect(exited).toBe(0);
    expect(fake.disposed()).toBe(true);
  });
});
