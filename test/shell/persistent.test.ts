import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPersistent, startPersistent } from "../../src/shell/persistent.js";
import type { RunSession, RunSessionConfig, RunSessionFactory } from "../../src/shell/run.js";

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
    async sendCustomMessage() {
      // The persistent runtime REQUIRES this seam (round 6: it rejects a session
      // without it at setup, because the standing contract is attached through
      // it). The attachment itself is asserted by the round-2 test below.
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
      sendCustomMessage: async () => {},
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

  it("cli#145 round 2: a post-run compaction starts NO turn — the pinned block rides the NEXT prompt", async () => {
    // pi compacts AFTER a run, once the capability has consumed that turn's reply
    // destination; a steered continuation would drive a turn whose reply has
    // nowhere to go. The block is attached to the session instead, for the NEXT
    // prompt (Discord, cron or mail), which keeps its own reply routing.
    const listeners: Array<(event: unknown) => void> = [];
    const prompts: string[] = [];
    const custom: Array<{
      message: { customType: string; content: string; display: boolean };
      options?: { deliverAs?: string; triggerTurn?: boolean };
    }> = [];
    const session: RunSession = {
      subscribe(listener) {
        const l = listener as (event: unknown) => void;
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      async prompt(text: string) {
        prompts.push(text);
      },
      async sendCustomMessage(message, options) {
        custom.push({ message, options });
      },
      dispose() {},
    };

    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => session,
      log: () => {},
    });

    for (const listener of listeners) {
      listener({
        type: "compaction_end",
        reason: "threshold",
        result: {},
        aborted: false,
        willRetry: false,
      });
    }

    // NO turn starts…
    expect(prompts, "a post-run compaction starts no turn").toHaveLength(0);
    // …the pinned block is attached to the next turn instead…
    expect(custom, "the standing contract is attached for the next prompt").toHaveLength(1);
    const first = custom.at(0);
    expect(first?.message.content).toContain("STANDING CONTRACT");
    expect(first?.message.content).toContain("You are pulse");
    expect(first?.options?.deliverAs).toBe("nextTurn");
    expect(first?.options?.triggerTurn, "and it must NOT trigger a turn").toBeFalsy();
    // …and the runtime does NOT rewrite the next inbound prompt: pi delivers the
    // attached block WITH it, so whatever drives it (Discord, cron, mail) keeps
    // its own reply destination.
    await handle.session.prompt("inbound from discord");
    expect(prompts).toEqual(["inbound from discord"]);

    await handle.shutdown();
  });

  it("cli#145 round 6: a session with no sendCustomMessage is REJECTED at setup, before it serves", async () => {
    // The standing contract is attached through sendCustomMessage, so a session
    // without that seam cannot hold it: it would compact, keep accepting inbound
    // prompts and serve them with the contract silently lost. There is no other
    // attachment API (delivery rides the NEXT prompt by design — see the test
    // above), so a session that cannot attach the block is not supportable for
    // persistent use at all. pi's AgentSession provides the seam; this rejects a
    // degraded implementation, and it must reject it at setup — before the
    // session is announced as up, wired into the event seam, or handed a prompt.
    const listeners: Array<(event: unknown) => void> = [];
    const prompts: string[] = [];
    const logs: string[] = [];
    let subscribed = false;
    let disposeCount = 0;
    const session: RunSession = {
      subscribe(listener) {
        subscribed = true;
        const l = listener as (event: unknown) => void;
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      async prompt(text: string) {
        prompts.push(text);
      },
      dispose() {
        disposeCount += 1;
      },
    };

    let error: unknown;
    try {
      await startPersistent({
        name: "pulse",
        agentsRoot: root,
        sessionFactory: async () => session,
        log: (m) => logs.push(m),
      });
    } catch (e) {
      error = e;
    }

    // The setup rejects it: the runtime never returns a handle for a session
    // that cannot hold the contract.
    expect(error, "setup rejects the session instead of accepting a degraded one").toBeInstanceOf(
      Error,
    );
    // …and the error is actionable — which factory, what is missing, and why it
    // is required.
    const message = (error as Error).message;
    expect(message, "names the missing seam").toContain("sendCustomMessage");
    expect(message, "names the actor — the session factory for this agent").toContain("pulse");
    expect(message, "says persistent use is what requires it").toContain("persistent");
    expect(message, "names the factory as the thing to change").toContain("factory");
    // No prompt is ever sent, the session is never wired into the event seam,
    // and the runtime never announces it as up.
    expect(prompts, "no prompt is ever sent").toHaveLength(0);
    // cli#145 round 7: the session the factory created is handed back exactly
    // once — an unsupported session left running can hold an open connection or
    // timer and keep the process alive after startup failed.
    expect(disposeCount, "the rejected session is disposed exactly once").toBe(1);
    expect(subscribed, "the session is never subscribed to the event seam").toBe(false);
    expect(
      logs.some((m) => m.includes("persistent session up")),
      `the session is never announced as up (saw: ${JSON.stringify(logs)})`,
    ).toBe(false);
  });

  it("cli#145 round 7: a dispose that throws does not replace the rejection", async () => {
    // Cleanup is best-effort. If the rejected session's dispose itself throws,
    // the caller must still get the reason the session was refused (the missing
    // seam) — not the teardown failure — and that failure is logged instead of
    // propagated.
    const logs: string[] = [];
    let disposeCount = 0;
    const session: RunSession = {
      subscribe() {
        return () => {};
      },
      async prompt() {},
      dispose() {
        disposeCount += 1;
        throw new Error("teardown exploded");
      },
    };

    let error: unknown;
    try {
      await startPersistent({
        name: "pulse",
        agentsRoot: root,
        sessionFactory: async () => session,
        log: (m) => logs.push(m),
      });
    } catch (e) {
      error = e;
    }

    expect(disposeCount, "the rejected session is still disposed (once)").toBe(1);
    expect(error, "setup still rejects").toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message, "the caller gets the missing-seam reason").toContain("sendCustomMessage");
    expect(message, "the dispose failure never replaces the rejection").not.toContain(
      "teardown exploded",
    );
    expect(
      logs.some((m) => m.includes("teardown exploded")),
      `the dispose failure is logged (saw: ${JSON.stringify(logs)})`,
    ).toBe(true);
  });

  // ── cli#145 round 9: a lost standing contract stops a RESIDENT runtime ──

  it("cli#145 round 9: a REJECTED standing-contract attach stops the runtime — non-zero exit, session disposed, nothing prompted after", async () => {
    // The persistent half of round 8. pi compacts AFTER a run, so a failed
    // attach leaves a warm session that compacts, keeps accepting inbound
    // prompts, and serves every later one with the standing contract silently
    // gone — the #145 silent-abandonment class, with no exit code to turn red.
    // So the runtime stops serving instead: it disposes the session and exits
    // non-zero with the named reason, and its supervisor restarts it fresh.
    const listeners: Array<(event: unknown) => void> = [];
    const prompts: string[] = [];
    const custom: unknown[] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    let disposeCount = 0;
    let disposed = false;
    const session: RunSession = {
      subscribe(listener) {
        const l = listener as (event: unknown) => void;
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      async prompt(text: string) {
        if (disposed) throw new Error("prompt() after dispose() — session was torn down");
        prompts.push(text);
      },
      async sendCustomMessage(message) {
        custom.push(message);
        return Promise.reject(new Error("the gateway dropped the attach"));
      },
      dispose() {
        disposeCount += 1;
        disposed = true;
      },
    };

    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => session,
      log: (m) => logs.push(m),
      exit: (code) => exits.push(code),
    });

    for (const listener of listeners) {
      listener({ type: "compaction_end", reason: "threshold", result: {}, aborted: false });
    }
    // The attach rejects: let its handler and the fail-closed shutdown run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(custom, "the standing contract WAS offered to the session").toHaveLength(1);
    expect(exits, "the runtime ends itself, exactly once").toHaveLength(1);
    expect(exits[0], "and with a non-zero code").not.toBe(0);
    const joined = logs.join("\n");
    expect(joined, "the named reason is logged").toContain("reinjection_failed");
    expect(joined, "the attach error is named, not swallowed").toContain(
      "the gateway dropped the attach",
    );
    expect(disposeCount, "the session is disposed — not left serving").toBe(1);
    // …so no later inbound prompt (a Discord reply, a mail, a cron fire) can
    // run on the session that lost its contract.
    await expect(handle.session.prompt("inbound from discord")).rejects.toThrow(/after dispose/);
    expect(prompts, "no prompt was ever sent to the lost-contract session").toHaveLength(0);
    await handle.shutdown(); // idempotent: the fail-closed path already disposed
    expect(disposeCount, "and shutdown does not dispose it twice").toBe(1);
  });

  it("cli#145 round 9: a THROWING standing-contract attach stops it the same way", async () => {
    // The other half: `sendCustomMessage` throws synchronously rather than
    // returning a rejected promise. It must not escape as an anonymous crash and
    // must not leave the runtime serving either.
    const listeners: Array<(event: unknown) => void> = [];
    const prompts: string[] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    let disposeCount = 0;
    const session: RunSession = {
      subscribe(listener) {
        const l = listener as (event: unknown) => void;
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      async prompt(text: string) {
        prompts.push(text);
      },
      sendCustomMessage() {
        throw new Error("the session refused the attach");
      },
      dispose() {
        disposeCount += 1;
      },
    };

    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => session,
      log: (m) => logs.push(m),
      exit: (code) => exits.push(code),
    });

    for (const listener of listeners) {
      listener({ type: "compaction_end", reason: "overflow", result: {}, aborted: false });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exits, "the runtime ends itself, exactly once").toHaveLength(1);
    expect(exits[0]).not.toBe(0);
    const joined = logs.join("\n");
    expect(joined).toContain("reinjection_failed");
    expect(joined, "the thrown error is named").toContain("the session refused the attach");
    expect(disposeCount, "the session is disposed").toBe(1);
    expect(prompts, "nothing is prompted on it").toHaveLength(0);
    await handle.shutdown();
  });

  it("cli#145 round 9: a STALE rejection from an older attempt does not stop a runtime whose newest attach succeeded", async () => {
    // Ordering hazard, the persistent half of round 8's guard: attempt #1's
    // promise is still pending when compaction #2 lands and attaches cleanly.
    // #2 is the LAST compaction, so #1's late rejection must not stop the
    // runtime — the session is holding the contract #2 attached.
    const listeners: Array<(event: unknown) => void> = [];
    const prompts: string[] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    let disposeCount = 0;
    let attachCount = 0;
    let releaseFirst: (() => void) | undefined;
    const session: RunSession = {
      subscribe(listener) {
        const l = listener as (event: unknown) => void;
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      async prompt(text: string) {
        prompts.push(text);
      },
      sendCustomMessage() {
        attachCount += 1;
        if (attachCount === 1) {
          return new Promise<void>((_resolve, reject) => {
            releaseFirst = () => reject(new Error("stale attach failure"));
          });
        }
        return Promise.resolve();
      },
      dispose() {
        disposeCount += 1;
      },
    };

    const handle = await startPersistent({
      name: "pulse",
      agentsRoot: root,
      sessionFactory: async () => session,
      log: (m) => logs.push(m),
      exit: (code) => exits.push(code),
    });

    // #1 stays pending; #2 attaches cleanly.
    for (const listener of listeners) {
      listener({ type: "compaction_end", reason: "threshold", result: {}, aborted: false });
      listener({ type: "compaction_end", reason: "overflow", result: {}, aborted: false });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attachCount, "both attempts were made").toBe(2);
    expect(exits, "a clean newest attach keeps it serving").toHaveLength(0);

    // Now the OLD attempt's rejection lands.
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exits, "the stale rejection does not stop the runtime").toHaveLength(0);
    expect(disposeCount, "and does not dispose the session").toBe(0);
    expect(logs.join("\n"), "no named failure is logged").not.toContain("reinjection_failed");
    // Still serving: an inbound prompt goes through.
    await handle.session.prompt("inbound from discord");
    expect(prompts).toEqual(["inbound from discord"]);

    await handle.shutdown();
  });
});
