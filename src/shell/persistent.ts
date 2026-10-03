// Persistent run — the agent keeps running as one warm pi AgentSession.
//
// This is the "persistent" lifespan from the spec (§3/§5): unlike `bob run`
// (ephemeral: one prompt, exit), the agent's process does NOT exit after a
// prompt. It stands up ONE warm `createAgentSession` (the same builder as
// `bob run`, only with a DURABLE SessionManager) with the agent's capabilities
// loaded — including the discord capability, whose gateway listener feeds
// inbound messages into bob's FIFO admission over the
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
import { TPS_MAIL_CAPABILITY } from "../capabilities/tps-mail/config.js";
import {
  buildStandingContract,
  createCompactionObserver,
  readWorktreeStatus,
} from "./compaction-contract.js";
import { type CronSchedulerHandle, startCronScheduler } from "./cron.js";
import { gatedNoteInjection } from "./data-class.js";
import {
  createTpsMailConsumer,
  type MailConsumer,
  type MailConsumerOptions,
} from "./mail-consumer.js";
import {
  attachFlairBootstrap,
  createPiRunSession,
  type RunSession,
  type RunSessionConfig,
  type RunSessionFactory,
  resolveRunConfig,
} from "./run.js";
import { createTurnAdmission, type TurnAdmission } from "./turn-admission.js";

export interface RunPersistentOptions {
  // Agent name. Config lives at <agentsRoot>/<name>/.
  name: string;
  // Optional model override (wins over bob.yaml) for every turn this process
  // runs. Same semantics as `bob run --model`.
  model?: string;
  // Override the agents root dir (tests). Defaults to ~/agents.
  agentsRoot?: string;
  // Inject the session factory (tests). Defaults to the real SDK factory with a
  // DURABLE SessionManager (persisted under the agent's .pi-agent/sessions).
  sessionFactory?: RunSessionFactory;
  // Scheduler seam: tests release a real fire callback during shutdown.
  cronSchedulerFactory?: typeof startCronScheduler;
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
  // bob#200 test seams for the tps-mail consumer (home dir for ~/.bob and a
  // `~/` inbox, and consumer overrides such as the turn runner and the reply
  // sender). Production passes neither.
  mailHome?: string;
  mailConsumer?: Partial<MailConsumerOptions>;
}

// A handle the caller (or a test) can use to drive a clean shutdown without a
// real OS signal. `shutdown()` is idempotent and awaits in-flight work before
// disposing — the graceful path `bob restart` relies on.
export interface PersistentHandle {
  // The warm session (so tests can assert it stays usable across prompts).
  session: RunSession;
  admitTurn: TurnAdmission["admitTurn"];
  // Resolved provider/model for diagnostics.
  provider: string;
  model: string;
  // The tps-mail inbox consumer, when the agent declares the capability.
  mailConsumer?: MailConsumer;
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
  const {
    provider,
    model,
    config,
    cron,
    agent,
    capabilities,
    agentDir,
    flairBootstrapTarget,
    toolLoopLimit,
  } = resolveRunConfig({
    name: opts.name,
    agentsRoot: root,
    model: opts.model,
    // The persistent runtime is resident by definition: this process stays up
    // behind the agent's service unit with nobody at the keyboard, which is
    // what the resident tool policy keys off (tool-allowlist.ts). A bob.yaml
    // `resident: true` says the same thing for the one-shot path.
    persistent: true,
  });

  // Mark this as the persistent runtime so "serving" capabilities (discord's
  // inbound gateway) open their connection — createPiRunSession surfaces it as
  // BOB_PERSISTENT before loading extensions. A one-shot `bob run` leaves it
  // falsy and stays outbound-only.
  config.persistent = true;
  // #145: the STANDING CONTRACT, and it lives in the SYSTEM PROMPT — the one
  // place pi's compaction cannot reach. It is built from the agent's bob.yaml
  // `agent:` block plus its declared cron duties, and the factory appends it as
  // literal text on every session it builds (creation, and again for every
  // /new, /resume, /fork, /clone and /import), so a resident agent that hits
  // the context threshold mid-task keeps its role and its duties in front of
  // the model without any attach step that could fail.
  config.standingContract = buildStandingContract({
    name: agent.name ?? opts.name,
    role: agent.role,
    duties: cron,
  });
  // bob#254 — the warm session builds a system prompt like every other entry
  // path, so it loads the Flair bootstrap too. It serves cron and Discord
  // inbound, so those turns carry the same context. A failure attaches the
  // one-line "could not load" note rather than stopping the runtime.
  await attachFlairBootstrap(flairBootstrapTarget, config, log);
  // bob#200: the tps-mail inbox consumer. It answers each accepted mail with
  // ONE turn in a FRESH session through the agent's launcher, so mail never
  // enters this warm session. Started BEFORE the warm session so a second
  // runtime for the same agent fails on the consumer lock before it logs in
  // anywhere; a failed session start releases the lock again.
  //
  // PRESENCE (bob#147): a mail turn is NOT reflected in presence. Presence beats
  // from the warm session's own turn events (its admission origin), and that
  // roster slot holds one activity; a mail turn runs concurrently in another
  // process, so beating it into the same slot would let a warm turn's idle beat
  // erase a running mail turn (and the reverse). The liveness beacon is
  // unaffected. Reporting mail as a `{kind:"mail"}` origin needs a
  // runtime-level arbiter over concurrent busy sources — a follow-up, and never
  // by routing mail through the warm session's admission.
  const mailCapability = capabilities.find((c) => c.name === TPS_MAIL_CAPABILITY);
  let mailConsumer: MailConsumer | undefined;
  if (mailCapability) {
    mailConsumer = createTpsMailConsumer({
      name: opts.name,
      agentDir,
      config: mailCapability.config,
      log,
      ...(opts.mailHome ? { home: opts.mailHome } : {}),
      ...(opts.mailConsumer ? { overrides: opts.mailConsumer } : {}),
    });
    mailConsumer.start();
    log(`[bob] tps-mail consumer up for ${opts.name}: one fresh-session turn per accepted mail`);
  }

  const factory = opts.sessionFactory ?? defaultPersistentFactory;
  // bob#147's FIFO admission is for the WARM session only (cron and Discord).
  // Mail turns never enter it (bob#200 §1): each runs in a fresh session through
  // the launcher, so the consumer above neither holds nor submits to it.
  const admission = createTurnAdmission({ log, toolLoopLimit, name: opts.name });
  config.turnAdmission = admission;
  let session: RunSession;
  try {
    session = await factory(config);
    admission.bind(session);
  } catch (error) {
    // A failed start leaves nothing running: close the admission (it also
    // releases startup admissions) and release the mail consumer's lock.
    admission.close();
    await mailConsumer?.stop();
    throw error;
  }

  log(`[bob] persistent session up for ${opts.name} (${provider}/${model})`);

  // #145: the observer attempts to send a best-effort compaction note except after
  // `agent_end` with stopReason "stop", no tool calls, compaction willRetry false,
  // and final text satisfying the completion contract (or an aborted compaction).
  // The standing contract is
  // in the system prompt, so a note that fails to send is logged and the
  // runtime keeps serving. The note uses pi's steer path; it does not
  // submit a new bob admission or supply an origin.
  const observer = createCompactionObserver({
    worktreeStatus: () => readWorktreeStatus(config.cwd),
    // bob#244: refused in a web session (the note carries workspace data).
    inject: gatedNoteInjection(config, "compaction-note", (text) =>
      session.prompt(text, { streamingBehavior: "steer" }),
    ),
    log,
  });
  const unsubscribeContract = session.subscribe((event) => observer.observe(event));

  // Every scheduled turn goes through the same admission as inbound Discord.
  let cronScheduler: CronSchedulerHandle | undefined;
  if (cron.length > 0) {
    log(`[bob] scheduling ${cron.length} cron job(s) for ${opts.name}`);
    cronScheduler = (opts.cronSchedulerFactory ?? startCronScheduler)({
      entries: cron,
      fire: async (entry) => {
        await admission.admitTurn({ kind: "cron", job: entry.name }, entry.prompt);
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
      // Close synchronously FIRST: even a fire already inside its callback
      // cannot start a prompt after this point. Then stop every intake — cron,
      // and the mail consumer — BEFORE draining admitted warm work, so no new
      // turn of either kind starts during the drain. Drain before dispose.
      admission.close();
      cronScheduler?.stop();
      // An in-flight mail turn is killed and its mail stays in new/, so the
      // next runtime re-delivers it (post-before-ack); the lock is released.
      await mailConsumer?.stop();
      unsubscribeContract();
      await admission.drain();
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

  return {
    session,
    admitTurn: admission.admitTurn,
    provider,
    model,
    shutdown,
    ...(mailConsumer ? { mailConsumer } : {}),
  };
}

// Run persistently and BLOCK until a shutdown signal (or the injected
// keepAlive) resolves. `bob run <name>` invokes this; the service unit runs that.
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
  const session = await createPiRunSession(config, (cwd) =>
    SessionManager.create(cwd, join(config.piAgentDir, "sessions")),
  );
  if (typeof session.waitForIdle !== "function") {
    const agent = (session as unknown as { agent?: { waitForIdle?: () => Promise<void> } }).agent;
    if (agent && typeof agent.waitForIdle === "function") {
      (session as RunSession).waitForIdle = () => agent.waitForIdle?.() ?? Promise.resolve();
    }
  }
  return session;
};
