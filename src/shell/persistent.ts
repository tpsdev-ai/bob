// Persistent run — the agent keeps running as one warm pi AgentSession.
//
// This is the "persistent" lifespan from the spec (§3/§5): unlike `bob run`
// (ephemeral: one prompt, exit), the agent's process does NOT exit after a
// prompt. It stands up ONE warm `createAgentSession` (the same builder as
// `bob run`, only with a DURABLE SessionManager) with the agent's capabilities
// loaded — including the discord capability, whose gateway listener feeds
// inbound messages into the session via `pi.sendUserMessage()` over the
// session's whole lifetime, and routes each reply back to the originating
// channel (see src/capabilities/discord).
//
// WHY this stays alive (researched against pi 0.73.1 SDK, docs/sdk.md +
// docs/extensions.md + the installed .d.ts): an `AgentSession` is multi-prompt
// by design. `session.prompt()` / `pi.sendUserMessage()` resolve when a run
// finishes; the session then sits idle, retaining conversation state, ready for
// the next prompt (the lifecycle diagram loops "agent_end → user sends another
// prompt"). It does NOT tear down between prompts. So the only thing the
// process needs is to NOT exit — there's no event loop the SDK keeps alive on
// its own once a prompt settles and the gateway is the only live handle. We
// keep the process alive with an unresolved promise (a bare `setInterval`
// does NOT keep bun's loop alive — it exits ~150ms after the last await; see
// the TPS branch keepalive bug). A SIGTERM/SIGINT handler disposes the session
// cleanly so `bob restart` is graceful.
//
// `onboard` installs a launchd unit that runs THIS (KeepAlive + RunAtLoad), so
// the agent self-runs. Bob installs it; Bob doesn't babysit the process.

import { homedir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  buildStandingContract,
  createCompactionReinjector,
  readWorktreeStatus,
} from "./compaction-contract.js";
import { type CronSchedulerHandle, startCronScheduler } from "./cron.js";
import {
  createPiRunSession,
  type RunSession,
  type RunSessionConfig,
  type RunSessionFactory,
  resolveRunConfig,
} from "./run.js";

export interface RunPersistentOptions {
  // Agent name. Config lives at <agentsRoot>/<name>/.
  name: string;
  // Optional model override (wins over bob.yaml) for every turn this process
  // runs. Same semantics as `bob run --model`.
  model?: string;
  // Override the agents root dir (tests). Defaults to ~/agents.
  agentsRoot?: string;
  // Inject the session factory (tests). Defaults to the real SDK factory with a
  // DURABLE SessionManager (persisted on disk under the agent's cwd).
  sessionFactory?: RunSessionFactory;
  // Install OS signal handlers for graceful shutdown. Defaults to true in
  // production; tests pass false and drive `handle.shutdown()` directly.
  installSignalHandlers?: boolean;
  // The "keep alive" primitive. Production returns a promise that never
  // resolves (so the process stays up until a signal disposes + exits). Tests
  // pass a promise they control (or an already-resolved one) so the call
  // returns without hanging. Defaults to a never-resolving promise.
  keepAlive?: () => Promise<void>;
  // Logger seam. Defaults to console.error (stderr — launchd captures it).
  log?: (msg: string) => void;
  // Process exit seam (tests). Defaults to process.exit.
  exit?: (code: number) => void;
}

// A handle the caller (or a test) can use to drive a clean shutdown without a
// real OS signal. `shutdown()` is idempotent and awaits in-flight work before
// disposing — the graceful path `bob restart` relies on.
export interface PersistentHandle {
  // The warm session (so tests can assert it stays usable across prompts).
  session: RunSession;
  // Resolved provider/model for diagnostics.
  provider: string;
  model: string;
  // Dispose the session cleanly: wait for any in-flight turn to settle, then
  // session.dispose(). Idempotent. Returns once disposed.
  shutdown(): Promise<void>;
}

// The default keep-alive: a promise that never resolves AND holds an active
// timer handle so the event loop stays alive.
//
// A bare `new Promise<void>(() => {})` is NOT enough on Node: with no pending
// work in the loop, Node detects the empty loop and EXITS (the persistent
// process's signal handlers are `process.once`, which do not count as active
// handles). That was the bug — `bob run <name>` logged "persistent session up"
// then exited 0, and systemd's Restart=always looped it. (`setInterval` alone
// fails to hold *bun*'s loop — the inverse trap — so we need both: an active
// interval handle to satisfy Node AND a never-resolving promise so the await
// genuinely blocks regardless of runtime.) The interval is never cleared: the
// process leaves this only via a signal handler calling exit() after
// shutdown(). A huge period means the empty callback effectively never fires.
function neverResolves(): Promise<void> {
  return new Promise<void>(() => {
    setInterval(() => {}, 1 << 30);
  });
}

// cli#145 round 9: the named reason and non-zero exit code a PERSISTENT runtime
// stops with when it cannot attach its standing contract. Same reason the
// one-shot runtime refuses with — one name for one failure.
const REINJECTION_FAILURE_REASON = "reinjection_failed";
const EXIT_REINJECTION_FAILED = 1;

// Stand up the warm session and return a handle. Does NOT block — call
// `awaitForever` (or rely on the returned blocking promise from runPersistent)
// to keep the process up. Factored out so tests can build the handle, exercise
// multiple prompts, and shut down without keeping a process alive.
export async function startPersistent(opts: RunPersistentOptions): Promise<PersistentHandle> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const root = opts.agentsRoot ?? join(homedir(), "agents");
  const { provider, model, config, cron, agent } = resolveRunConfig({
    name: opts.name,
    agentsRoot: root,
    model: opts.model,
  });

  // Mark this as the persistent runtime so "serving" capabilities (discord's
  // inbound gateway) open their connection — createPiRunSession surfaces it as
  // BOB_PERSISTENT before loading extensions. A one-shot `bob run` leaves it
  // falsy and stays outbound-only.
  config.persistent = true;
  const factory = opts.sessionFactory ?? defaultPersistentFactory;
  const session = await factory(config);

  // cli#145 round 6: a session that cannot attach the pinned block is not
  // accepted for persistent use at all. The standing contract rides
  // `sendCustomMessage` (delivered WITH the next prompt — see the reinjector
  // below); a session without that seam would compact, keep accepting inbound
  // prompts and serve them with the contract silently lost. There is no other
  // attachment API, so that mode is not supported — reject it at setup, BEFORE
  // the session is announced as up or wired into a prompt path. pi's
  // AgentSession provides the seam, so this rejects a bespoke implementation,
  // not production.
  //
  // cli#145 round 7: hand back the session the factory already created before
  // refusing it — an unsupported session left running can hold an open
  // connection or timer and keep the process alive after startup failed. The
  // dispose is best-effort and must not replace the rejection: a dispose that
  // throws is logged, and the caller still gets the sendCustomMessage reason.
  if (typeof session.sendCustomMessage !== "function") {
    try {
      session.dispose();
    } catch (err) {
      log(
        `[bob] disposing the rejected session for ${opts.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw new Error(
      `the session factory for "${opts.name}" returned a session with no sendCustomMessage: persistent use requires it, because the standing contract is attached to the session for its next prompt. Use a session factory whose session provides sendCustomMessage (pi's AgentSession does).`,
    );
  }
  // Narrowed once, here after the guard; the injector below never re-checks.
  const sendCustomMessage = session.sendCustomMessage.bind(session);

  log(`[bob] persistent session up for ${opts.name} (${provider}/${model})`);

  // ── the state every serving path shares ──────────────────────────────
  let disposed = false;
  let disposing: Promise<void> | undefined;
  // cli#145 round 9: the named reason this runtime STOPPED SERVING. Set when its
  // standing contract could not be attached — synchronously, which is what
  // closes the admission gate (round 11) — and from then on no prompt from any
  // source is issued: the gate refuses it, and the session is disposed.
  let stopped: string | undefined;
  let cronScheduler: CronSchedulerHandle | undefined;
  // Process exit seam (tests). Defaults to process.exit — production fail-closed
  // really ends the process so launchd restarts it.
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  const shutdown = async (): Promise<void> => {
    if (disposed) return;
    if (disposing) return disposing;
    disposing = (async () => {
      // Stop scheduling first so a pending cron tick can't fire into a session
      // we're about to dispose.
      cronScheduler?.stop();
      unsubscribeContract();
      // Await any in-flight turn so we don't cut off a reply mid-stream. The
      // RunSession seam exposes `prompt` but not an idle barrier; production's
      // pi AgentSession has `agent.waitForIdle()`. We call it best-effort
      // through the optional hook so a fake session in tests need not implement
      // it.
      try {
        await session.waitForIdle?.();
      } catch {
        // ignore — proceed to dispose regardless
      }
      session.dispose();
      disposed = true;
      log(`[bob] persistent session for ${opts.name} disposed cleanly`);
    })();
    return disposing;
  };

  // cli#145 round 9: FAIL CLOSED. If the pinned standing contract could not be
  // attached — the attach rejected, or it threw — then the session compacts,
  // keeps accepting inbound prompts, and serves every later one with the
  // contract silently gone. That is the #145 silent-abandonment class, and a
  // resident agent has no exit code to go red: the failure would be one log line
  // in a stream nobody reads. So the runtime stops serving instead. CLOSING THE
  // ADMISSION GATE is the first thing it does, synchronously, before anything is
  // awaited (round 11, item 3): pi does not guard a prompt on a disposed session
  // (`dispose()` sets no flag and `prompt()` has no guard), so the gate — not the
  // disposal — is what makes the stop effective for a prompt already on its way.
  // Then it stops the scheduler, unsubscribes, drains idle, disposes the session,
  // and exits non-zero with the named reason and the error in the log; its
  // supervisor (launchd KeepAlive + RunAtLoad) then restarts it with a FRESH
  // session whose standing contract is intact from the start.
  const failClosed = (failure: string): void => {
    if (stopped !== undefined) return; // already stopping — the first reason stands
    // Close the gate FIRST, synchronously: this write is what the gate reads, and
    // everything below is async — it may not have run when a prompt arrives.
    stopped = failure;
    log(
      `[bob] ${REINJECTION_FAILURE_REASON}: the standing contract could not be attached — ${failure}`,
    );
    log(
      `[bob] ${REINJECTION_FAILURE_REASON}: stopping ${opts.name} so it is restarted with a fresh session`,
    );
    void (async () => {
      await shutdown();
      exit(EXIT_REINJECTION_FAILED);
    })();
  };

  // cli#145: subscribe to the SAME event seam the discord capability uses for
  // agent_end. A resident agent that hits the context threshold mid-task used to
  // go silent with its standing duties erased; after every non-aborted
  // compaction the reinjector hands it back the standing contract (its role +
  // scheduled duties) plus "what remains". Additive: it does not touch the
  // capability's reply routing, which still keys off agent_end.
  const reinjector = createCompactionReinjector({
    standingContract: buildStandingContract({
      name: agent.name ?? opts.name,
      role: agent.role,
      duties: cron,
    }),
    worktreeStatus: () => readWorktreeStatus(config.cwd),
    inject: (text) => {
      // cli#145 round 2, item 4: pi compacts AFTER a run, once the capability has
      // already consumed that turn's reply destination, so a STEERED continuation
      // would drive a turn whose reply has nowhere to go. Attach the pinned block
      // to the NEXT turn instead — pi appends it to the session and delivers it
      // with the next prompt (Discord, cron or mail), which keeps its own reply
      // routing. The one-shot runtime keeps the steer. (A session without this
      // seam never reaches here: setup rejects it — there is no drop path.)
      return sendCustomMessage(
        { customType: "bob-compaction-contract", content: text, display: false },
        { deliverAs: "nextTurn" },
      );
    },
    log,
    // Round 9: a failed attach stops the runtime. The verdict is per-compaction,
    // so a rejection arriving late from an older attempt reports undefined here
    // and cannot stop a runtime whose newest attach succeeded.
    onInjectionSettled: (failure) => {
      if (failure !== undefined) failClosed(failure);
    },
  });
  const unsubscribeContract = session.subscribe((event) => reinjector.observe(event));

  // cli#145 round 11, item 3: ONE ADMISSION GATE FOR EVERY PROMPT SOURCE. Round
  // 10 covered the prompts THIS runtime issues (a cron fire). The discord
  // capability's inbound listener calls `pi.sendUserMessage()` directly, which pi
  // routes to `AgentSession.sendUserMessage` and on to `prompt()` — a path bob
  // never sees. And pi does not close that door on dispose: `dispose()` sets no
  // flag and `prompt()` has no guard, so nothing below us refuses a prompt on a
  // session bob has stopped serving. So the gate is installed on the session
  // INSTANCE's prompt entry points, where every caller must pass it whatever it
  // is — the scheduler, the discord inbound handler, a future mail consumer —
  // with no capability code touched.
  //
  // The gate refuses once the runtime has stopped, and while an attach is still
  // in flight (after a compaction, until the standing contract settles) it WAITS
  // — then RE-CHECKS, because that attach failing is exactly what stops the
  // runtime. `stopped` is therefore re-read after every wait, and the last read
  // is the last thing before the prompt is issued.
  const refusePrompt = (when: string): void => {
    log(
      `[bob] ${REINJECTION_FAILURE_REASON}: not issuing a prompt — this session stopped serving${when}`,
    );
  };
  const gate = async (issue: () => Promise<void>): Promise<void> => {
    for (;;) {
      if (stopped !== undefined) {
        refusePrompt("");
        return;
      }
      const attaching = reinjector.pendingInjection();
      if (attaching === undefined) break;
      // The standing contract is still being attached: let it land first, then
      // loop. If it FAILED the runtime has stopped serving, so this prompt is
      // refused rather than driven into the session that lost its contract.
      await attaching;
    }
    await issue();
  };
  const originalPrompt = session.prompt.bind(session);
  session.prompt = (text, options) => gate(() => originalPrompt(text, options));
  // `sendUserMessage` delegates to `prompt` INSIDE pi (AgentSession awaits
  // `this.prompt(...)`), so a call that arrives this way passes the gate twice:
  // once here and once at the prompt wrapper. That is not a double admission —
  // the inner pass re-checks the same two conditions immediately before pi's own
  // prompt, which is exactly what round 10 asked for — and a refusal returns
  // before calling through, so it is logged once. Wrapping both means the gate
  // does not depend on that delegation.
  const originalSendUserMessage = session.sendUserMessage?.bind(session);
  if (originalSendUserMessage !== undefined) {
    session.sendUserMessage = (content, options) =>
      gate(() => originalSendUserMessage(content, options));
  }

  // cli#145 round 10: ONE prompt path for the prompts THIS runtime issues. Every
  // one goes through here, and `stopped` is re-read IMMEDIATELY before
  // session.prompt — after EVERY await. A fire used to check `stopped`, then wait
  // for idle, then prompt regardless: a session that fail-closed DURING that wait
  // (its standing contract could not be attached, so the runtime is disposing it)
  // would still be driven a turn — exactly the silent service round 9 exists to
  // prevent. The final check is the last thing before the prompt; nothing runs
  // between them. (A scheduler-side check stays here for its own wording; the
  // session-boundary gate above is what covers EVERY source.)
  const issuePrompt = async (prompt: string): Promise<void> => {
    const refuse = (when: string): void => {
      log(
        `[bob] ${REINJECTION_FAILURE_REASON}: not issuing a scheduled prompt — this session stopped serving${when}`,
      );
    };
    if (stopped !== undefined) {
      // The session lost its standing contract and is being disposed: a prompt
      // now is exactly the silent service round 9 exists to prevent. (pi does NOT
      // refuse it — see the admission gate above — so this check and the gate are
      // what stand between a stopped runtime and a driven turn.)
      refuse("");
      return;
    }
    try {
      await session.waitForIdle?.();
    } catch {
      // proceed — pi serializes turns regardless
    }
    if (stopped !== undefined) {
      // The attach failed WHILE this prompt waited for the session to go idle.
      refuse(" (it stopped while this prompt waited to go idle)");
      return;
    }
    await session.prompt(prompt);
  };

  // Scheduled work: fire each bob.yaml `cron:` prompt INTO this live session on
  // its cadence (one gateway, no second `bob run` process). Await the idle
  // barrier first so a tick doesn't cut into an in-flight inbound turn; fires
  // are serialized by the scheduler. No-op when the agent declares no cron.
  if (cron.length > 0) {
    log(`[bob] scheduling ${cron.length} cron job(s) for ${opts.name}`);
    cronScheduler = startCronScheduler({
      entries: cron,
      fire: (entry) => issuePrompt(entry.prompt),
      log,
    });
  }

  return { session, provider, model, shutdown };
}

// Run persistently and BLOCK until a shutdown signal (or the injected
// keepAlive) resolves. This is what the launchd unit / `bob serve` invokes.
export async function runPersistent(opts: RunPersistentOptions): Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const handle = await startPersistent(opts);

  const installSignals = opts.installSignalHandlers !== false;
  if (installSignals) {
    // Graceful shutdown on SIGTERM (launchd `bootout` / `kickstart -k`) and
    // SIGINT (Ctrl-C). Dispose the session, then exit 0 so KeepAlive treats it
    // as a clean stop on a deliberate bootout (and a restart on kickstart -k).
    const onSignal = (signal: NodeJS.Signals) => {
      void (async () => {
        (opts.log ?? ((m: string) => console.error(m)))(`[bob] received ${signal}, shutting down`);
        await handle.shutdown();
        exit(0);
      })();
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  }

  // Keep the process alive. Default never resolves; the signal handler is the
  // only exit. Tests inject a resolvable keepAlive so this returns.
  const keepAlive = opts.keepAlive ?? neverResolves;
  await keepAlive();
  // Reached only when an injected keepAlive resolves (tests / a future managed
  // shutdown). Dispose before returning so we never leak a live session.
  await handle.shutdown();
}

// Production factory: build the SAME session as `bob run`, but with a DURABLE
// SessionManager so the warm session persists on disk (the working window).
// Flair remains the long-term store; restart-rehydration from Flair is a
// documented TODO (spec §7) — a clean SIGTERM→dispose is what PR4 guarantees.
//
// We also surface a top-level `waitForIdle()` on the RunSession: pi's
// AgentSession exposes the idle barrier as `session.agent.waitForIdle()` (SDK
// docs), not as a top-level method, so we adapt it here. Best-effort — if the
// shape ever changes, shutdown still proceeds to dispose().
const defaultPersistentFactory: RunSessionFactory = async (config: RunSessionConfig) => {
  const session = await createPiRunSession(config, (cwd) => SessionManager.create(cwd));
  if (typeof session.waitForIdle !== "function") {
    const agent = (session as unknown as { agent?: { waitForIdle?: () => Promise<void> } }).agent;
    if (agent && typeof agent.waitForIdle === "function") {
      (session as RunSession).waitForIdle = () => agent.waitForIdle?.() ?? Promise.resolve();
    }
  }
  return session;
};
