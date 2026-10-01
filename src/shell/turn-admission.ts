import { AsyncLocalStorage } from "node:async_hooks";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantEndingTracker } from "./compaction-contract.js";
import { ReasoningOnlyExhaustedError, repromptWhileReasoningOnly } from "./reasoning-retry.js";
import type { RunSession } from "./run.js";
import { promptSession } from "./session.js";
import {
  DEFAULT_TOOL_LOOP_LIMIT,
  loopBreakMessage,
  ToolLoopDetector,
  ToolLoopError,
} from "./tool-loop.js";
import { approvedOrigin, type TurnOrigin } from "./turn-origin.js";

export interface TurnAdmission {
  // Resolves with this admission's messages, for the inbound source's reply.
  admitTurn(origin: TurnOrigin, text: string): Promise<unknown[]>;
  // The origin of the turn currently admitted, from admission until that
  // prompt settles — never cleared mid-prompt by an agent_end.
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
// turn; at the configured limit the turn is signalled to stop and the admission
// fails with `ToolLoopError`.
export function createTurnAdmission(
  opts: {
    log?: (m: string) => void;
    toolLoopLimit?: number;
    name?: string;
    // How long admitTurn waits for a loop-broken prompt to settle before it
    // stops holding the turn's origin binding (test seam; default below).
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
    // Set when the detector fires: the session's abort(), so admitTurn can wait
    // for the aborted prompt to settle before it releases the origin binding.
    stopping?: Promise<void>;
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
              // Signal the session to stop, and RECORD the promise: admitTurn
              // holds the turn's origin binding until it settles, so an
              // in-flight tool the abort has not reached yet still sees the
              // turn's origin rather than `run`. Never rejects.
              turn.stopping = Promise.resolve()
                .then(() => session?.abort?.())
                .then(
                  () => undefined,
                  () => undefined,
                );
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
        // origin is cleared once, in admitTurn's own finally, after
        // session.prompt() has resolved or rejected.
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
        try {
          // No await between installing the context and invoking the prompt.
          await context.run(turn, async () => {
            endings.reset();
            // Race the turn against the loop breaker: when the detector fires,
            // `loopAbort` rejects and the turn fails, the same way a one-shot
            // `bob run` ends on a repeated call.
            await Promise.race([
              (async () => {
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
              })(),
              loopAbort,
            ]);
          });
          return turn.messages;
        } finally {
          // bob#143: the origin binding outlives the aborted prompt. The
          // detector rejects `loopAbort` the moment it fires, which ends THIS
          // admission, but pi's prompt is still running — its parallel tool
          // path can execute a call prepared before the abort. Hold the binding
          // until the abort settles, bounded so a prompt that never settles
          // cannot pin the admission either; if it does not settle in the
          // bound, keep the binding and report it.
          const settled = turn.stopping ? await settledWithin(turn.stopping, graceMs) : true;
          if (settled) {
            turn.origin = { kind: "run" };
            active = undefined;
          } else {
            log(
              `[bob] loop breaker: the aborted turn did not settle within ${graceMs}ms; keeping its origin binding`,
            );
          }
        }
      };
      if (closed) return Promise.reject(new Error("bob: turn admission is closed"));
      const result = tail.then(run);
      tail = result.catch(() => {});
      return result;
    },
    readOrigin(): TurnOrigin {
      const turn = context.getStore();
      return turn && turn === active ? { ...turn.origin } : { kind: "run" };
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

// How long admitTurn holds a loop-broken turn's origin binding while it waits
// for the aborted prompt to settle.
const LOOP_ABORT_GRACE_MS = 1_000;

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
