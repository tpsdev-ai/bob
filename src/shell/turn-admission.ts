import { AsyncLocalStorage } from "node:async_hooks";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantEndingTracker } from "./compaction-contract.js";
import {
  EmptyResponseExhaustedError,
  type EmptyResponseExhaustion,
  emptyResponseExhaustionOf,
} from "./empty-response-marker.js";
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
import { rejectUnrecoveredEmptyResponse } from "./unrecovered-empty-response.js";

// Identifies one admitted operation: one `admitTurn` call. Opaque, compared by
// identity. The same token is returned for the whole operation, including every
// prompt its automatic continuations send; two admissions never share one.
export type AdmissionToken = object;

export interface TurnAdmission {
  // Resolves with this admission's messages, for the inbound source's reply.
  // `preflight.beforeStart` is checked for voice and non-voice turns, after the
  // operation leaves the queue and immediately before its prompt starts; a
  // non-null string refuses it, and nothing is prompted.
  admitTurn(
    origin: TurnOrigin,
    text: string,
    preflight?: { beforeStart?: () => string | null },
  ): Promise<unknown[]>;
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
    // The start of a NEW admitted turn. A persistent runtime uses it to open a
    // fresh compaction boundary and clear its empty-response latch; the
    // admission's own latch is per Turn and needs no reset.
    onTurnStart?: () => void;
    // bob#356 V2a: create the FRESH session a voice-origin turn runs in, one per
    // call, not the resident one. The runtime that supplies it decides what
    // that session carries (persistent.ts: no Flair bootstrap, no prior-round
    // memory, reachy_say as its one tool). Absent: a voice turn is refused (fail closed) —
    // no voice prompt can fall back to the resident session.
    voiceSession?: () => Promise<RunSession>;
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
    // Set once ANY assistant message in this admitted operation carries the
    // empty-response wrapper's typed exhaustion provenance. It is never cleared
    // by a later message or compaction: the operation has failed.
    exhaustion?: EmptyResponseExhaustion;
    abort?: (err: Error) => void;
    // The session this turn prompts (the resident one, or a fresh voice one).
    target?: RunSession;
    // This turn's last assistant ending, for its reasoning-only re-prompt.
    endings: ReturnType<typeof createAssistantEndingTracker>;
  };
  const context = new AsyncLocalStorage<Turn>();
  let active: Turn | undefined;
  let session: RunSession | undefined;
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let ready!: () => void;
  const bound = new Promise<void>((resolve) => {
    ready = resolve;
  });
  // One event handler for the sessions this runtime prompts: the resident one
  // and each fresh voice session. An event counts for the active turn when the
  // AsyncLocalStorage store it was emitted under is that turn AND the session
  // that emitted it is that turn's target.
  const observe = (
    event: Parameters<Parameters<RunSession["subscribe"]>[0]>[0],
    source: RunSession,
  ): void => {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const endingTurn = context.getStore();
      if (endingTurn && endingTurn === active && endingTurn.target === source) {
        // The ending this turn's re-prompt check reads.
        endingTurn.endings.observe(event);
        const exhaustion = emptyResponseExhaustionOf(event.message);
        if (exhaustion !== undefined) endingTurn.exhaustion = exhaustion;
      }
    }
    if (event.type === "tool_execution_start") {
      const turn = context.getStore();
      if (turn && turn === active && turn.target === source) {
        const { toolName, args } = event as unknown as { toolName: string; args: unknown };
        const observation = turn.detector.observe(toolName, args);
        if (observation.fire && turn.abort) {
          const abort = turn.abort;
          turn.abort = undefined;
          log(loopBreakMessage(agentName, toolName, args, observation.count));
          abort(new ToolLoopError(toolName, observation.count));
          // Ask the session to stop. The binding does not depend on the
          // answer: admitTurn releases it when the prompt settles.
          requestStop(turn.target, log);
        }
      }
    }
    if (event.type !== "agent_end") return;
    const turn = context.getStore();
    if (turn !== active || !turn || turn.target !== source) return;
    // agent_end fires INSIDE a prompt more than once (retries and
    // continuations), so it CAPTURES the turn's messages here — it must
    // not clear the origin. The admitted origin stays current from admission
    // until the admitted prompt settles, which readOrigin() relies on: the
    // discord tools bind a turn's outbound reach to readOrigin(), and a
    // cleared origin mid-turn would restore their allowlist reach. The
    // origin is cleared once, after the admitted prompt has resolved or
    // rejected (see admitTurn's finally).
    turn.messages = event.messages;
    // The message_end latch above preserves exhaustion across compaction.
    for (const message of event.messages) {
      const exhaustion = emptyResponseExhaustionOf(message);
      if (exhaustion !== undefined) {
        turn.exhaustion = exhaustion;
        break;
      }
    }
  };
  const admission = {
    bind(value: RunSession): void {
      session = value;
      value.subscribe((event) => observe(event, value));
      ready();
    },
    admitTurn(
      origin: TurnOrigin,
      text: string,
      preflight?: { beforeStart?: () => string | null },
    ): Promise<unknown[]> {
      // Copy before queuing: neither extra fields nor later caller mutations
      // may alter metadata. Closing is synchronous, including during preflight.
      let approved: TurnOrigin;
      try {
        approved = approvedOrigin(origin);
      } catch (err) {
        return Promise.reject(err);
      }
      const isVoice = approved.kind === "voice";
      // bob#356 V2a: a voice-origin turn can be admitted now. Its origin carries
      // `speakerVerified`, which is false in V2a (bob has no speaker
      // authentication until V3), and the utterance/correlation ids bob issued
      // for this transcript. It runs in a FRESH session (opts.voiceSession),
      // not the resident one, so the resident session's history is not in
      // front of the model; persistent.ts builds that session without the Flair
      // bootstrap or prior-round memory. bob's tool-admission gate (session.ts,
      // tool-admission.ts) restricts its reach to `reachy_say`: no recall, no
      // transcript memory write or memory-writing tool, no grant tools (an
      // admitted `reachy_say` still persists its speech audit as an OrgEvent).
      // The reachy capability's speech gate
      // accepts a voice-origin `say` with this turn's own current addressed
      // utterance (policy.ts), so no later caller inherits the room's speech.
      const run = async (): Promise<unknown[]> => {
        await bound;
        if (closed) throw new Error("bob: turn admission is closed");
        let target: RunSession;
        let voiceTarget: RunSession | undefined;
        let unsubscribeVoice: (() => void) | undefined;
        const discardVoice = (): void => {
          if (voiceTarget === undefined) return;
          // A session that failed before its prompt is being thrown away: each
          // step is attempted on its own, so a failed unsubscribe still disposes.
          try {
            unsubscribeVoice?.();
          } catch {
            // the dispose below is what matters
          }
          try {
            voiceTarget.dispose();
          } catch {
            // nothing else holds this session
          }
        };
        // Until the prompt starts, a failure in startup work discards the fresh
        // voice session before it propagates.
        const beforePrompt = <T>(work: () => T): T => {
          try {
            return work();
          } catch (err) {
            discardVoice();
            throw err;
          }
        };
        if (isVoice) {
          if (opts.voiceSession === undefined)
            throw new Error(
              "bob: a voice turn needs a fresh voice session, and this runtime configured none",
            );
          const fresh = await opts.voiceSession();
          target = fresh;
          voiceTarget = fresh;
          unsubscribeVoice = beforePrompt(() => fresh.subscribe((event) => observe(event, fresh)));
        } else {
          const resident = session;
          if (!resident) throw new Error("bob: turn admission has no session");
          target = resident;
          await target.waitForIdle?.();
        }
        if (closed) {
          discardVoice();
          throw new Error("bob: turn admission is closed");
        }
        const refusal = beforePrompt(() => preflight?.beforeStart?.() ?? null);
        if (refusal !== null) {
          discardVoice();
          throw new Error(`bob: ${isVoice ? "voice turn" : "turn"} not admitted: ${refusal}`);
        }
        // beforeStart may have closed the admission.
        if (closed) {
          discardVoice();
          throw new Error("bob: turn admission is closed");
        }
        const turn: Turn = {
          origin: approved,
          messages: [],
          detector: new ToolLoopDetector(limit),
          token: {},
          live: true,
          target,
          endings: createAssistantEndingTracker(),
        };
        let abortTurn!: (err: Error) => void;
        const loopAbort = new Promise<never>((_resolve, reject) => {
          abortTurn = reject;
        });
        turn.abort = (err) => abortTurn(err);
        beforePrompt(() => opts.onTurnStart?.());
        active = turn;
        // The prompt itself, tracked apart from the race and from the abort:
        // only its settlement releases the turn's origin binding.
        let prompt: Promise<void> = Promise.resolve();
        try {
          // No await between installing the context and invoking the prompt.
          prompt = context.run(turn, () => {
            turn.endings.reset();
            return (async () => {
              await promptSession(target, text);
              // bob#256: continue through reasoning-only turns, bounded. Exhaustion
              // is a FAILED turn — thrown so the callers (the cron scheduler, the
              // Discord inbound listener) handle it as a failure rather than a
              // successful fire/reply.
              const reasoning = await repromptWhileReasoningOnly({
                session: target,
                readEnding: () => turn.endings.current(),
                beginTurn: () => turn.endings.reset(),
                shouldStop: () => turn.exhaustion !== undefined,
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
          // bob#381: an admitted turn whose request exhausted the empty-response
          // bound must FAIL, not resolve as if the turn had completed: a cron
          // fire would otherwise record success and a Discord turn would return
          // with no reply. The per-turn latch is read first, so a later
          // compaction or answer cannot replace the failed request. The wrapper's
          // typed provenance is the only signal read; a provider's error text is
          // not.
          const lastAssistant = [...turn.messages]
            .reverse()
            .find((message) => (message as { role?: unknown }).role === "assistant");
          const exhaustion = turn.exhaustion ?? emptyResponseExhaustionOf(lastAssistant);
          if (exhaustion !== undefined) throw new EmptyResponseExhaustedError(exhaustion);
          rejectUnrecoveredEmptyResponse(lastAssistant);
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
          // A fresh voice session serves one turn: release the binding,
          // unsubscribe, then dispose. A loop-broken prompt that has not settled
          // keeps the three until it does, so its in-flight tool calls still see
          // the turn's origin.
          const finish = (): void => {
            release();
            if (voiceTarget === undefined) return;
            const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
            try {
              unsubscribeVoice?.();
            } catch (err) {
              log(`[bob] could not unsubscribe from the voice session: ${describe(err)}`);
            }
            try {
              voiceTarget.dispose();
            } catch (err) {
              log(`[bob] could not dispose the voice session: ${describe(err)}`);
            }
          };
          if (await settledWithin(prompt, graceMs)) {
            finish();
          } else {
            log(
              `[bob] loop breaker: the loop-broken turn's prompt did not settle within ${graceMs}ms; keeping its origin binding until it settles`,
            );
            prompt.then(finish, finish);
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
// bob#356 V2a: the resident reachy capability's speech bridge, handed to the
// FRESH voice session so its `reachy_say` sends through the one live sidecar
// link (the sidecar accepts one connection). The function is a runtime service,
// not prompt or model text; it decides by the voice turn's bound origin.
const VOICE_SPEECH_SERVICE = "bob:voice-speech";

export type VoiceSpeech = (text: string) => Promise<unknown>;

const voiceSpeechByAdmission = new WeakMap<object, VoiceSpeech>();

/** The resident capability registers its speech path once its link is wired. */
export function registerVoiceSpeech(admission: TurnAdmission, speak: VoiceSpeech): void {
  voiceSpeechByAdmission.set(admission, speak);
}

/** The speech bridge for an admission, or undefined when no capability registered
 *  one. Undefined is a refusal: a voice turn with no way to speak acts on nothing. */
export function getRegisteredVoiceSpeech(admission: TurnAdmission): VoiceSpeech | undefined {
  return voiceSpeechByAdmission.get(admission);
}

export function admissionEventBus(admission: TurnAdmission): EventBus {
  return runtimeEventBus({ admission });
}

/** The loader's event bus carrying whichever runtime services this session has:
 *  the turn admission (persistent runtime) and/or the declared session origin
 *  (one-shot run). */
export function runtimeEventBus(services: {
  admission?: TurnAdmission;
  sessionOrigin?: TurnOrigin;
  voiceSpeech?: VoiceSpeech;
}): EventBus {
  const bus = createEventBus();
  const { admission, sessionOrigin, voiceSpeech } = services;
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
  if (voiceSpeech) {
    bus.on(VOICE_SPEECH_SERVICE, (receive) => {
      (receive as (value: VoiceSpeech) => void)(voiceSpeech);
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

/** The resident capability's speech bridge for this session, when the runtime
 *  supplied one (a fresh voice session). */
export function getVoiceSpeech(pi: { events: Pick<EventBus, "emit"> }): VoiceSpeech | undefined {
  let speech: VoiceSpeech | undefined;
  pi.events.emit(VOICE_SPEECH_SERVICE, (value: VoiceSpeech) => {
    speech = value;
  });
  return speech;
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
