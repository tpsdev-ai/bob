// Scheduled work for the PERSISTENT runtime — `cron:` in bob.yaml.
//
// Bob's persistent session (`bob serve`) can run prompts on a schedule: each
// bob.yaml `cron:` entry { name, schedule (cron expr), prompt } fires its prompt
// INTO the live session on its cadence. This is how an agent does proactive work
// (e.g. Pulse's daily intel brief) without a second process — and crucially
// without a second Discord gateway connection (a `bob run` per tick would open a
// duplicate login for the same bot token and fight the persistent session). The
// scheduled prompt drives the same warm session that handles inbound, so the
// agent can use its capabilities (discord_reply, flair_*) to act on the tick.
//
// CONCURRENCY: fires are SERIALIZED through a single promise chain so two cron
// entries never run at once, and `fire` itself (in persistent.ts) awaits the
// session's idle barrier before prompting so a tick doesn't cut into an in-
// flight inbound turn. pi's AgentSession processes one turn at a time.
//
// TESTABILITY: croner only computes the next fire time; the clock + timers + the
// fire callback are all injected, so tests drive ticks deterministically with no
// real wall-clock wait and no LLM.

import { Cron } from "croner";
import type { CronEntry } from "./index.js";

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface CronSchedulerDeps {
  // The agent's cron entries (from bob.yaml `cron:`).
  entries: CronEntry[];
  // What to do when an entry fires. In production this awaits the session's
  // idle barrier then `session.prompt(entry.prompt)`. Serialized by the
  // scheduler — never called concurrently with itself.
  fire: (entry: CronEntry) => Promise<void>;
  // Logger seam. Defaults to console.error.
  log?: (msg: string) => void;
  // Clock seam (ms since epoch). Defaults to Date.now.
  now?: () => number;
  // Timer seams. Default to setTimeout/clearTimeout. Tests inject fakes to fire
  // ticks deterministically.
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
}

export interface CronSchedulerHandle {
  // Cancel all pending timers. Idempotent. The persistent runtime calls this on
  // shutdown so a pending tick can't fire into a disposed session.
  stop(): void;
}

// Cron's smallest unit is 1 minute; clamp the computed delay so a slightly-past
// or clock-skewed nextRun can't busy-loop with a 0ms timer.
const MIN_DELAY_MS = 1_000;

// Start scheduling the entries. Returns a handle whose stop() cancels everything.
// Each entry self-reschedules after firing (compute next → set a timer). An entry
// with an invalid cron expression is logged + skipped (it never fires) rather
// than taking down the whole scheduler.
export function startCronScheduler(deps: CronSchedulerDeps): CronSchedulerHandle {
  const log = deps.log ?? ((m: string) => console.error(m));
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));

  let stopped = false;
  const timers = new Set<TimerHandle>();
  // Single promise chain — serializes all fires so two entries (or a re-entrant
  // tick) never run concurrently.
  let chain: Promise<void> = Promise.resolve();

  const scheduleNext = (entry: CronEntry, cron: Cron): void => {
    if (stopped) return;
    const next = cron.nextRun(new Date(now()));
    if (!next) {
      log(`cron: ${entry.name} has no future run — not rescheduling`);
      return;
    }
    const delay = Math.max(MIN_DELAY_MS, next.getTime() - now());
    const handle = setTimer(() => {
      timers.delete(handle);
      if (stopped) return;
      // Enqueue the fire on the serial chain, then reschedule the NEXT run.
      chain = chain
        .then(() => (stopped ? undefined : fireOne(entry)))
        .catch((err) => {
          const reason = err instanceof Error ? err.message : "cron fire failed";
          log(`cron: ${entry.name} fire error: ${reason}`);
        })
        .finally(() => scheduleNext(entry, cron));
    }, delay);
    timers.add(handle);
  };

  const fireOne = async (entry: CronEntry): Promise<void> => {
    log(`cron: firing ${entry.name}`);
    await deps.fire(entry);
  };

  for (const entry of deps.entries) {
    let cron: Cron;
    try {
      cron = new Cron(entry.schedule);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid cron expression";
      log(`cron: skipping ${entry.name} — bad schedule "${entry.schedule}": ${reason}`);
      continue;
    }
    scheduleNext(entry, cron);
  }

  return {
    stop(): void {
      stopped = true;
      for (const h of timers) clearTimer(h);
      timers.clear();
    },
  };
}
