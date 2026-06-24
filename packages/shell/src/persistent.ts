// Persistent run — the agent keeps running as one warm pi AgentSession.
//
// This is the "persistent" lifespan from the spec (§3/§5): unlike `bob run`
// (ephemeral: one prompt, exit), the agent's process does NOT exit after a
// prompt. It stands up ONE warm `createAgentSession` (the same builder as
// `bob run`, only with a DURABLE SessionManager) with the agent's capabilities
// loaded — including the discord capability, whose gateway listener feeds
// inbound messages into the session via `pi.sendUserMessage()` over the
// session's whole lifetime, and routes each reply back to the originating
// channel (see @tpsdev-ai/bob-cap-discord).
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
import { SessionManager } from "@mariozechner/pi-coding-agent";
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

// Stand up the warm session and return a handle. Does NOT block — call
// `awaitForever` (or rely on the returned blocking promise from runPersistent)
// to keep the process up. Factored out so tests can build the handle, exercise
// multiple prompts, and shut down without keeping a process alive.
export async function startPersistent(opts: RunPersistentOptions): Promise<PersistentHandle> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const root = opts.agentsRoot ?? join(homedir(), "agents");
  const { provider, model, config, cron } = resolveRunConfig({
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

  log(`[bob] persistent session up for ${opts.name} (${provider}/${model})`);

  // Scheduled work: fire each bob.yaml `cron:` prompt INTO this live session on
  // its cadence (one gateway, no second `bob run` process). Await the idle
  // barrier first so a tick doesn't cut into an in-flight inbound turn; fires
  // are serialized by the scheduler. No-op when the agent declares no cron.
  let cronScheduler: CronSchedulerHandle | undefined;
  if (cron.length > 0) {
    log(`[bob] scheduling ${cron.length} cron job(s) for ${opts.name}`);
    cronScheduler = startCronScheduler({
      entries: cron,
      fire: async (entry) => {
        try {
          await session.waitForIdle?.();
        } catch {
          // proceed — pi serializes turns regardless
        }
        await session.prompt(entry.prompt);
      },
      log,
    });
  }

  let disposed = false;
  let disposing: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    if (disposed) return;
    if (disposing) return disposing;
    disposing = (async () => {
      // Stop scheduling first so a pending cron tick can't fire into a session
      // we're about to dispose.
      cronScheduler?.stop();
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
