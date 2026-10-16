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

// Identifies one admitted operation: one `admitTurn` call. Opaque, compared by
// identity. The same token is returned for the whole operation, including every
// prompt its automatic continuations send; two admissions never share one.
export type AdmissionToken = object;

export interface TurnAdmission {
  // Resolves with this admission's messages, for the inbound source's reply.
  admitTurn(origin: TurnOrigin, text: string): Promise<unknown[]>;
  // The origin of the admitted turn whose prompt the caller runs inside, from
  // admission until that prompt settles — never cleared mid-prompt by an
  // agent_end, a loop break, or a later admission. Elsewhere: run.
  readOrigin(): TurnOrigin;
  // The admission the caller's prompt belongs to, from admission until that
  // operation's prompt chain SETTLES. Undefined outside any admission (a bare
  // prompt), and undefined from the instant the operation settles — including
  // from a descendant async context that inherited the caller's turn before the
  // settle. One `admitTurn` call yields one token, returned unchanged across
  // the operation's retries and automatic continuations — so a lifecycle hook
  // can tell a continuation of the same operation from a new admission.
  activeAdmission(): AdmissionToken | undefined;
  // bob#356: the same binding, WITHOUT the default. The origin of the admitted
  // turn the caller runs inside, or undefined anywhere else — a prompt outside
  // every admission, or a turn whose prompt has settled. A gate that grants by
  // origin reads this, so a missing admission can never pass as `run`.
  readAdmittedOrigin(): TurnOrigin | undefined;
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
    // Set when the prompt settled and the origin binding was released.
    released?: boolean;
    messages: unknown[];
    detector: ToolLoopDetector;
    token: AdmissionToken;
    // False once the operation's prompt chain settles; the token is absent
    // from then on, even to a context that inherited this turn earlier.
    live: boolean;
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
      // bob#356 V1: the `voice` kind exists so the union, its validation, its
      // projection and its label land together, but no voice-origin turn is
      // admitted yet. A voice turn needs the tool admission that leaves it only
      // `reachy_say` (D1) and the fresh, allowlisted session it runs in (D2);
      // neither ships in V1, and the resident session holds every other tool
      // and the private context. Refused before queuing, so nothing is prompted.
      // Pinned for V2 (Sherlock NEW-7): that disposable session REPLACES pi's
      // assembled system prompt — `systemPromptOverride` set to bob's fixed
      // voice instruction, as the web session does (session.ts, bob#244) —
      // because pi's own template names workspace paths.
      if (approved.kind === "voice") {
        return Promise.reject(
          new Error(
            "bob: voice-origin turns are not admitted yet: they need the voice tool admission and disposable session of bob#356 V2",
          ),
        );
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
          token: {},
          live: true,
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
            turn.live = false;
            turn.origin = { kind: "run" };
            turn.released = true;
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
    activeAdmission(): AdmissionToken | undefined {
      // Keyed on the caller's own turn, like readOrigin, and gated on the turn
      // still being live: the token is present only while the operation's prompt
      // chain is in flight. A loop-broken prompt that outlives its admission
      // keeps it — release runs when that prompt settles — but a settled
      // operation returns nothing here, even from a descendant context that
      // inherited the turn before release.
      const turn = context.getStore();
      return turn?.live ? turn.token : undefined;
    },
    readAdmittedOrigin(): TurnOrigin | undefined {
      const turn = context.getStore();
      if (!turn || turn.released) return undefined;
      return { ...turn.origin };
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
// bob#356: the origin the RUNTIME declares for a session no admission serves —
// today only an operator's one-shot `bob run` ({kind:"run"}). Absent for every
// other session (a mail turn, an interactive launch), so nothing defaults to it.
const SESSION_ORIGIN_SERVICE = "bob:session-origin";

export function admissionEventBus(admission: TurnAdmission): EventBus {
  return runtimeEventBus({ admission });
}

/** The loader's event bus carrying whichever runtime services this session has:
 *  the turn admission (persistent runtime) and/or the declared session origin
 *  (one-shot run). */
export function runtimeEventBus(services: {
  admission?: TurnAdmission;
  sessionOrigin?: TurnOrigin;
}): EventBus {
  const bus = createEventBus();
  const { admission, sessionOrigin } = services;
  if (admission) {
    bus.on(SERVICE, (receive) => {
      (receive as (value: TurnAdmission) => void)(admission);
    });
  }
  if (sessionOrigin) {
    const frozen = approvedOrigin(sessionOrigin);
    bus.on(SESSION_ORIGIN_SERVICE, (receive) => {
      (receive as (value: TurnOrigin) => void)({ ...frozen });
    });
  }
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

/** The runtime-declared origin of this session, when the runtime declared one. */
export function getSessionOrigin(pi: { events: Pick<EventBus, "emit"> }): TurnOrigin | undefined {
  let origin: TurnOrigin | undefined;
  pi.events.emit(SESSION_ORIGIN_SERVICE, (value: TurnOrigin) => {
    origin = value;
  });
  return origin;
}

/**
 * bob#356: the origin a tool call is BOUND to, or undefined. In a session an
 * admission serves (the persistent runtime), only an admitted turn binds one:
 * a call outside every admission gets nothing, never `run`. Otherwise only an
 * origin the runtime declared for the whole session binds (an operator's
 * one-shot run). No service at all — undefined.
 */
export function boundOrigin(services: {
  admission?: Pick<TurnAdmission, "readAdmittedOrigin">;
  sessionOrigin?: TurnOrigin;
}): TurnOrigin | undefined {
  if (services.admission) return services.admission.readAdmittedOrigin();
  return services.sessionOrigin ? { ...services.sessionOrigin } : undefined;
}
