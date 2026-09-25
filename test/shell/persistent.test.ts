import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PiLike, wireDiscordCapability } from "../../src/capabilities/discord/capability.js";
import type { DiscordClient, DiscordMessage } from "../../src/shell/discord-types.js";
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
    // pi does NOT refuse a prompt after dispose (its dispose() sets no flag and
    // its prompt() has no guard) — round 11 removed the fake that pretended it
    // did; the runtime's admission gate is what refuses a prompt on a stopped
    // session.
    async prompt(text: string) {
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

// cli#145 round 11, item 3: the REAL discord capability, driven through a pi
// adapter that mirrors pi's own routing. The capability's inbound listener calls
// `pi.sendUserMessage(content)`, and pi's extension API routes that to the
// session's `sendUserMessage` — the entry point the runtime installs its
// admission gate on. Pointing the adapter at the runtime's session is what makes
// the capability's call (not a direct test call) pass that gate.
function piRoutingTo(session: RunSession): PiLike {
  return {
    registerTool() {},
    on() {},
    sendUserMessage(content: string) {
      void session.sendUserMessage?.(content);
    },
  } as unknown as PiLike;
}

// A minimal DiscordClient: records the gateway listener so a test can fire an
// inbound message through the capability's real `message` handler.
function discordClientFake(): {
  client: DiscordClient;
  fire: (content: string, id?: string) => void;
} {
  let handler: ((msg: DiscordMessage) => void) | undefined;
  const client: DiscordClient = {
    on(_event, h) {
      handler = h;
    },
    async connect() {},
    async disconnect() {},
    async reply() {},
    async react() {},
    async fetchRecent() {
      return [];
    },
    async sendTyping() {},
  };
  return {
    client,
    fire: (content, id = "m1") =>
      handler?.({
        id,
        channelId: "channel-A",
        authorId: "u1",
        authorName: "user",
        content,
        mentionsBot: true,
      }),
  };
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
    const session: RunSession = {
      subscribe(listener) {
        const l = listener as (event: unknown) => void;
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      // pi does not refuse a prompt on a disposed session (round 11, item 4),
      // so this fake records what REACHES it; the runtime's admission gate is
      // what the assertion below rests on.
      async prompt(text: string) {
        prompts.push(text);
      },
      async sendCustomMessage(message) {
        custom.push(message);
        return Promise.reject(new Error("the gateway dropped the attach"));
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
    // …so no later inbound prompt (a Discord reply, a mail, a cron fire) can run
    // on the session that lost its contract. pi does NOT refuse it (round 11,
    // item 4: the fake that pretended it did is gone) — the runtime's own
    // admission gate refuses it: the call returns without reaching the session's
    // prompt, and the refusal is logged.
    await handle.session.prompt("inbound from discord");
    expect(prompts, "no prompt was ever sent to the lost-contract session").toHaveLength(0);
    expect(logs.join("\n"), "and the refusal is named, not silent").toContain(
      "not issuing a prompt",
    );
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

  // ── cli#145 round 10: ONE prompt path ──────────────────────────────

  it("cli#145 round 10: a cron fire parked on the idle barrier never prompts a session that fail-closed during that wait", async () => {
    // The fire checked `stopped`, then awaited the idle barrier, then prompted
    // regardless — so a session that fail-closed DURING that wait (its standing
    // contract could not be attached, and the runtime is disposing it) was still
    // driven a turn. That is the silent service round 9 exists to prevent. Every
    // prompt the runtime issues now goes through one function that re-reads
    // `stopped` IMMEDIATELY before session.prompt, after EVERY await.

    // A schedule due within a second: croner takes an optional seconds field, and
    // the scheduler clamps the delay to >= 1s, so the REAL scheduler delivers a
    // tick without a test-only seam.
    writeFileSync(
      join(root, "pulse", "bob.yaml"),
      [
        "agent:",
        "  id: pulse",
        "provider:",
        "  name: anthropic",
        "  model: claude-x",
        "",
        "cron:",
        "  - name: heartbeat",
        '    schedule: "* * * * * *"',
        '    prompt: "post the brief"',
        "",
      ].join("\n"),
    );

    const listeners: Array<(event: unknown) => void> = [];
    const prompts: string[] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    let disposed = false;
    let idleWaits = 0;
    // EVERY waiter that parked on idle, so releasing the barrier resumes ALL of
    // them — releasing only the newest would leave the fire parked and make the
    // "never prompts" assertion pass for the wrong reason.
    const idleReleases: Array<() => void> = [];
    const session: RunSession = {
      subscribe(listener) {
        const l = listener as (event: unknown) => void;
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      // Recorded UNCONDITIONALLY (and never throwing on a disposed session): the
      // defect under test is a prompt REACHING the session, whatever it then
      // does with it.
      async prompt(text: string) {
        prompts.push(text);
      },
      waitForIdle() {
        idleWaits += 1;
        return new Promise<void>((resolve) => {
          idleReleases.push(resolve);
        });
      },
      sendCustomMessage() {
        return Promise.reject(new Error("the gateway dropped the attach"));
      },
      dispose() {
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

    // Wait for the real tick to park on the idle barrier. Bounded, so a missed
    // tick fails loudly instead of reading as a pass.
    const deadline = Date.now() + 15_000;
    while (idleWaits < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      idleWaits,
      `the cron tick reached the idle barrier (logs: ${JSON.stringify(logs)})`,
    ).toBeGreaterThanOrEqual(1);

    // The attach fails WHILE the fire sits on the barrier.
    for (const listener of listeners) {
      listener({ type: "compaction_end", reason: "threshold", result: {}, aborted: false });
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(exits, "the fail-closed shutdown is itself parked on the idle barrier").toHaveLength(0);

    // Release it: the fire resumes, and the runtime finishes disposing.
    for (const release of idleReleases.splice(0)) release();
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));

    expect(prompts, "no prompt reaches a session that stopped serving").toEqual([]);
    expect(exits, "the runtime still ends itself, non-zero").toEqual([1]);
    expect(disposed, "and the session is disposed").toBe(true);
    const joined = logs.join("\n");
    expect(joined, "the named reason is logged").toContain("reinjection_failed");
    expect(joined, "the stop was seen BEFORE the prompt, not after it").toContain(
      "it stopped while this prompt waited to go idle",
    );
    await handle.shutdown();
  });

  // ── cli#145 round 11: ONE admission gate for EVERY prompt source ────

  it("cli#145 round 11: an inbound Discord message that arrives while the standing contract is still attaching waits, then runs WITH the contract attached", async () => {
    // Round 10 covered the prompts the runtime issues itself (cron). The discord
    // capability's inbound listener calls `pi.sendUserMessage()` directly, which
    // pi routes to `AgentSession.sendUserMessage` -> `prompt()` — a path bob
    // never sees, and one pi does not refuse on a disposed session either. The
    // gate lives on the session INSTANCE's prompt entry points, so this message
    // passes it: while the standing contract is still attaching it WAITS, and it
    // is prompted only once the block has landed.
    const listeners: Array<(event: unknown) => void> = [];
    const events: string[] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    let released: (() => void) | undefined;
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
        events.push(`prompt:${text}`);
      },
      // Mirrors pi: `pi.sendUserMessage` ends up in `prompt()` on this same
      // session, so the gate is passed twice — which must not double-admit, and
      // must not prompt twice.
      async sendUserMessage(content: string) {
        await this.prompt(content);
      },
      sendCustomMessage() {
        return new Promise<void>((resolve) => {
          released = () => {
            events.push("attach-settled");
            resolve();
          };
        });
      },
      dispose() {},
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
    const { client, fire } = discordClientFake();
    wireDiscordCapability({
      pi: piRoutingTo(session),
      client,
      config: { tokenFile: "/secrets/bot.token", channelIds: ["channel-A"], dispatchAll: false },
      log: (m) => logs.push(m),
      typingIntervalMs: 5,
      typingMaxMs: 20,
    });
    fire("<@123> the brief?");
    await new Promise((r) => setTimeout(r, 10));
    expect(events, "nothing is prompted while the contract is still attaching").toEqual([]);
    expect(exits, "and nothing stopped").toEqual([]);

    released?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(events, "the attach lands FIRST, then the message runs").toEqual([
      "attach-settled",
      "prompt:the brief?",
    ]);
    expect(exits, "a landed attach keeps it serving").toEqual([]);
    await handle.shutdown();
  });

  it("cli#145 round 11: an inbound Discord message whose wait ends in a FAILED attach never reaches pi's prompt", async () => {
    // The other half: the message waits on the pending attach, and that attach
    // FAILS. The gate re-checks after the wait, sees the stopped runtime, and
    // refuses — the message never reaches the session's prompt. pi would not
    // refuse it (its dispose() sets no flag), which is why the gate is what the
    // stop has to rely on.
    const listeners: Array<(event: unknown) => void> = [];
    const events: string[] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    let disposeCount = 0;
    let failAttach: (() => void) | undefined;
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
        events.push(`prompt:${text}`);
      },
      async sendUserMessage(content: string) {
        await this.prompt(content);
      },
      sendCustomMessage() {
        return new Promise<void>((_resolve, reject) => {
          failAttach = () => reject(new Error("the gateway dropped the attach"));
        });
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
      listener({ type: "compaction_end", reason: "threshold", result: {}, aborted: false });
    }
    const { client, fire } = discordClientFake();
    wireDiscordCapability({
      pi: piRoutingTo(session),
      client,
      config: { tokenFile: "/secrets/bot.token", channelIds: ["channel-A"], dispatchAll: false },
      log: (m) => logs.push(m),
      typingIntervalMs: 5,
      typingMaxMs: 20,
    });
    fire("<@123> are you still there?");
    await new Promise((r) => setTimeout(r, 10));
    expect(events, "the message is waiting on the attach, not prompted").toEqual([]);

    // The attach FAILS: the runtime stops serving and the gate closes.
    failAttach?.();
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));

    expect(events, "the inbound message never reaches a prompt").toEqual([]);
    expect(exits, "the runtime still ends itself, non-zero").toEqual([1]);
    expect(disposeCount, "and the session is disposed").toBe(1);
    const joined = logs.join("\n");
    expect(joined, "the named reason is logged").toContain("reinjection_failed");
    expect(joined, "and the inbound refusal is named too").toContain("not issuing a prompt");
    await handle.shutdown();
  });
});
