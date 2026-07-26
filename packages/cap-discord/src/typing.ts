// The "agent is thinking" affordance — a typing-indicator heartbeat.
//
// THE PROBLEM: an agent turn is model latency plus tool calls, routinely tens
// of seconds. For that whole window Discord showed nothing at all, so a human
// could not tell "working on it" from "the process is dead" — the reply just
// arrived, eventually, or didn't.
//
// WHY A HEARTBEAT AND NOT ONE CALL: Discord's POST /channels/:id/typing lights
// the indicator for about TEN SECONDS and then it silently expires. There is no
// "stop typing" endpoint and no long-lived variant. So a single call at dispatch
// is worse than useless for a 45-second turn: it flickers on, expires, and the
// human is back to staring at an empty channel for the remaining 35 seconds. We
// re-fire just inside the expiry window instead, which keeps the indicator
// continuously lit for exactly as long as the agent is actually working.
//
// COSMETIC BY CONTRACT: every failure here — 429, a missing permission on the
// channel, a dropped connection — is swallowed and logged. A typing request
// must never break, block or delay the reply it was announcing.

import type { DiscordClient } from "@tpsdev-ai/bob-shell";

// Re-fire cadence. The indicator lasts ~10s; 8s leaves ~2s of slack for request
// latency so it never visibly blinks off mid-turn, while staying nowhere near a
// rate that would matter to the REST budget (one request per 8s per active
// turn, and turns are serialized).
export const TYPING_INTERVAL_MS = 8_000;

// Hard ceiling on a single heartbeat. The normal stop is a `finally` in the
// capability's agent_end handler, which covers both the success path and a
// throw. This is the backstop for the abnormal case that no `finally` can
// reach: a turn that never emits agent_end at all. An interval that types
// forever is worse than no indicator, so the heartbeat bounds its own life.
export const TYPING_MAX_MS = 5 * 60_000;

export interface TypingHeartbeatOptions {
  // Only the typing call is needed — narrowed so tests can pass a one-method
  // stub and so it's obvious this can't reply, react or read.
  client: Pick<DiscordClient, "sendTyping">;
  // Re-fire cadence (default TYPING_INTERVAL_MS). Tests inject a few ms.
  intervalMs?: number;
  // Self-stop ceiling (default TYPING_MAX_MS).
  maxMs?: number;
  // Logger seam — defaults to silent. A cosmetic failure shouldn't spam stderr
  // unless the caller wants it.
  log?: (msg: string) => void;
}

// A SINGLE-SLOT heartbeat: at most one interval is ever live. `start` on an
// already-running heartbeat replaces it rather than stacking a second timer,
// which mirrors the capability's single `pending` pointer (pi serializes turns,
// so there is only ever one turn to announce).
export interface TypingHeartbeat {
  start(channelId: string): void;
  // Idempotent — safe to call when nothing is running, and safe to call twice.
  stop(): void;
}

export function createTypingHeartbeat(opts: TypingHeartbeatOptions): TypingHeartbeat {
  const intervalMs = opts.intervalMs ?? TYPING_INTERVAL_MS;
  const maxMs = opts.maxMs ?? TYPING_MAX_MS;
  const log = opts.log ?? ((_m: string) => {});
  let timer: ReturnType<typeof setInterval> | undefined;
  let deadline = 0;

  const swallow = (channelId: string, err: unknown): void => {
    const reason = err instanceof Error ? err.message : "typing request failed";
    log(`discord: typing indicator failed for ${channelId}: ${reason}`);
  };

  // Fire one pulse. Issued SYNCHRONOUSLY (not deferred through a microtask — the
  // request should be in flight the instant the message lands), never awaited by
  // the caller, and never allowed to escape: `.catch` contains an async
  // rejection, the surrounding try/catch contains a client implementation that
  // throws before it ever returns a promise.
  const pulse = (channelId: string): void => {
    try {
      void opts.client.sendTyping(channelId).catch((err: unknown) => swallow(channelId, err));
    } catch (err) {
      swallow(channelId, err);
    }
  };

  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  return {
    start(channelId: string): void {
      stop();
      deadline = Date.now() + maxMs;
      // Light it immediately — the point is that the human sees something the
      // moment the message lands, not one interval later.
      pulse(channelId);
      timer = setInterval(() => {
        if (Date.now() >= deadline) {
          log(`discord: typing indicator for ${channelId} hit its ${maxMs}ms ceiling; stopping`);
          stop();
          return;
        }
        pulse(channelId);
      }, intervalMs);
      // A cosmetic timer must never be the reason the process stays up.
      if (typeof timer.unref === "function") timer.unref();
    },
    stop,
  };
}
