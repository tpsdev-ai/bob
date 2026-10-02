import { AsyncLocalStorage } from "node:async_hooks";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantEndingTracker } from "./compaction-contract.js";
import { ReasoningOnlyExhaustedError, repromptWhileReasoningOnly } from "./reasoning-retry.js";
import type { RunSession } from "./run.js";
import { promptSession } from "./session.js";
import {
  DEFAULT_TOOL_LOOP_LIMIT,
  LOOP_ABORT_GRACE_MS,
  loopBreakMessage,
  ToolLoopDetector,
  ToolLoopError,
} from "./tool-loop.js";
import { approvedOrigin, type TurnOrigin } from "./turn-origin.js";

export interface TurnAdmission {
  // Resolves with this admission's messages, for the inbound source's reply.
  admitTurn(origin: TurnOrigin, text: string): Promise<unknown[]>;
  // The origin of the admitted turn whose prompt the caller runs inside, from
  // admission until that prompt settles — never cleared mid-prompt by an
  // agent_end, a loop break, or a later admission. Elsewhere: run.
  readOrigin(): TurnOrigin;
}

// One runtime owns one FIFO. Async context binds the origin to the actual
// prompt call, including its preflight awaits. A bare prompt outside this call
// reads run, even while an admitted prompt is paused before before_agent_start.
//
// Every admitted turn is also re-prompted while its last turn ends with
// reasoning only (bob#256), bounded; an exhausted admitted turn FAILS the turn
// (it throws), so a cron/Discord turn cannot end the agent mid-task either.
//
// bob#143 item 3: every admitted turn runs the same loop breaker as a one-shot
// `bob run`. The detector counts consecutive identical tool calls within the
// turn; at the configured limit the session is asked to stop and the admission
// fails with `ToolLoopError`. The turn's origin binding lasts until its prompt
// settles, which can be after the admission fails.
export function createTurnAdmission(
  opts: {
    log?: (m: string) => void;
    toolLoopLimit?: number;
    name?: string;
    // How long admitTurn waits for a loop-broken prompt to settle before it
    // rejects anyway (test seam; default LOOP_ABORT_GRACE_MS). The binding is
    // kept until the prompt settles either way.
    loopAbortGraceMs?: number;
  } = {},
) {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const limit = opts.toolLoopLimit ?? DEFAULT_TOOL_LOOP_LIMIT;
  const graceMs = opts.loopAbortGraceMs ?? LOOP_ABORT_GRACE_MS;
  const agentName = opts.name ?? "agent";
  type Turn = {
    origin: TurnOrigin;
    messages: unknown[];
    detector: ToolLoopDetector;
    abort?: (err: Error) => void;
  };
  const context = new AsyncLocalStorage<Turn>();
  const endings = createAssistantEndingTracker();
  let active: Turn | undefined;
  let session: RunSession | undefined;
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let ready!: () => void;
  const bound = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const admission = {
    bind(value: RunSession): void {
      session = value;
      value.subscribe((event) => {
        endings.observe(event);
        if (event.type === "tool_execution_start") {
          const turn = context.getStore();
          if (turn && turn === active) {
            const { toolName, args } = event as unknown as { toolName: string; args: unknown };
            const observation = turn.detector.observe(toolName, args);
            if (observation.fire && turn.abort) {
              const abort = turn.abort;
              turn.abort = undefined;
              log(loopBreakMessage(agentName, toolName, args, observation.count));
              abort(new ToolLoopError(toolName, observation.count));
              // Ask the session to stop. The binding does not depend on the
              // answer: admitTurn releases it only when the prompt settles.
              requestStop(session, log);
            }
          }
        }
        if (event.type !== "agent_end") return;
        const turn = context.getStore();
        if (turn !== active || !turn) return;
        // agent_end fires INSIDE a prompt more than once (retries and
        // continuations), so it only CAPTURES the turn's messages here — it must
        // not clear the origin. The admitted origin stays current from admission
        // until the admitted prompt settles, which readOrigin() relies on: the
        // discord tools bind a turn's outbound reach to readOrigin(), and a
        // cleared origin mid-turn would restore their allowlist reach. The
        // origin is cleared once, after the admitted prompt has resolved or
        // rejected (see admitTurn's finally).
        turn.messages = event.messages;
      });
      ready();
    },
    admitTurn(origin: TurnOrigin, text: string): Promise<unknown[]> {
      // Copy before queuing: neither extra fields nor later caller mutations
      // may alter metadata. Closing is synchronous, including during preflight.
      let approved: TurnOrigin;
      try {
        approved = approvedOrigin(origin);
      } catch (err) {
        return Promise.reject(err);
      }
      const run = async (): Promise<unknown[]> => {
        await bound;
        if (closed) throw new Error("bob: turn admission is closed");
        const target = session;
        if (!target) throw new Error("bob: turn admission has no session");
        await target.waitForIdle?.();
        if (closed) throw new Error("bob: turn admission is closed");
        const turn: Turn = {
          origin: approved,
          messages: [],
          detector: new ToolLoopDetector(limit),
        };
        let abortTurn!: (err: Error) => void;
        const loopAbort = new Promise<never>((_resolve, reject) => {
          abortTurn = reject;
        });
        turn.abort = (err) => abortTurn(err);
        active = turn;
        // The prompt itself, tracked apart from the race and from the abort:
        // only its settlement releases the turn's origin binding.
        let prompt: Promise<void> = Promise.resolve();
        try {
          // No await between installing the context and invoking the prompt.
          prompt = context.run(turn, () => {
            endings.reset();
            return (async () => {
              await promptSession(target, text);
              // bob#256: continue through reasoning-only turns, bounded. Exhaustion
              // is a FAILED turn — thrown so the callers (the cron scheduler, the
              // Discord inbound listener) handle it as a failure rather than a
              // successful fire/reply.
              const reasoning = await repromptWhileReasoningOnly({
                session: target,
                readEnding: () => endings.current(),
                beginTurn: () => endings.reset(),
                onReprompt: (n, max) =>
                  log(
                    `[bob] turn ended with reasoning only (no text beyond whitespace, no tool call) — re-prompting (${n}/${max})`,
                  ),
              });
              if (reasoning.endedReasoningOnly) {
                throw new ReasoningOnlyExhaustedError(reasoning.reprompts);
              }
            })();
          });
          // Race the turn against the loop breaker: when the detector fires,
          // `loopAbort` rejects and the turn fails, the same way a one-shot
          // `bob run` ends on a repeated call.
          await Promise.race([prompt, loopAbort]);
          return turn.messages;
        } finally {
          // bob#143: the origin binding is released only when the PROMPT
          // settles. A loop break rejects `loopAbort` the moment the detector
          // fires, while pi's prompt may still be running: its parallel tool
          // path can execute a call prepared before the stop request, and the
          // session's abort() may be missing or fail. admitTurn waits for the
          // prompt at most `graceMs`; past that it keeps the binding, reports
          // it, and releases it when the prompt settles. The binding belongs to
          // the turn (readOrigin), so a queued admission cannot replace it.
          const release = (): void => {
            turn.origin = { kind: "run" };
            if (active === turn) active = undefined;
          };
          if (await settledWithin(prompt, graceMs)) {
            release();
          } else {
            log(
              `[bob] loop breaker: the loop-broken turn's prompt did not settle within ${graceMs}ms; keeping its origin binding until it settles`,
            );
            prompt.then(release, release);
          }
        }
      };
      if (closed) return Promise.reject(new Error("bob: turn admission is closed"));
      const result = tail.then(run);
      tail = result.catch(() => {});
      return result;
    },
    readOrigin(): TurnOrigin {
      // Keyed on the caller's own turn, not on `active`: a loop-broken prompt
      // that outlives its admission keeps its origin after the next admission
      // starts. A settled turn's origin was reset to run.
      const turn = context.getStore();
      return turn ? { ...turn.origin } : { kind: "run" };
    },
    close(): void {
      closed = true;
      // An already started prompt keeps its metadata through agent_end.
      ready(); // also releases startup admissions if session creation failed
    },
    async drain(): Promise<void> {
      await tail;
    },
  };
  return admission;
}

// Ask the session to stop a loop-broken prompt. A missing or rejected abort()
// is logged; nothing waits on it.
function requestStop(session: RunSession | undefined, log: (m: string) => void): void {
  Promise.resolve()
    .then(() => {
      if (typeof session?.abort !== "function") throw new Error("the session has no abort()");
      return session.abort();
    })
    .catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      log(
        `[bob] loop breaker: could not signal the session to stop (${m}); the turn keeps its origin binding until its prompt settles`,
      );
    });
}

// Wait at most `ms` for `p`; true when it settled (either way), false when the
// bound elapsed first. The timer is cleared either way, so a settled turn
// leaves nothing holding the event loop.
async function settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Dependency injection through pi's per-loader event bus. This passes the
// runtime-owned service at extension load, never per-turn metadata. No module
// singleton, environment payload, or prompt tag crosses the loader boundary.
const SERVICE = "bob:turn-admission";
export function admissionEventBus(admission: TurnAdmission): EventBus {
  const bus = createEventBus();
  bus.on(SERVICE, (receive) => {
    (receive as (value: TurnAdmission) => void)(admission);
  });
  return bus;
}

export function getTurnAdmission(pi: {
  events: Pick<EventBus, "emit">;
}): TurnAdmission | undefined {
  let admission: TurnAdmission | undefined;
  pi.events.emit(SERVICE, (value: TurnAdmission) => {
    admission = value;
  });
  return admission;
}
