import { AsyncLocalStorage } from "node:async_hooks";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantEndingTracker } from "./compaction-contract.js";
import { repromptWhileReasoningOnly } from "./reasoning-retry.js";
import type { RunSession } from "./run.js";
import { promptSession } from "./session.js";
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
// reasoning only (flair#256), bounded, so a cron/Discord turn cannot end the
// agent mid-task either.
export function createTurnAdmission(opts: { log?: (m: string) => void } = {}) {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  type Turn = { origin: TurnOrigin; messages: unknown[] };
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
        const turn: Turn = { origin: approved, messages: [] };
        active = turn;
        try {
          // No await between installing the context and invoking the prompt.
          await context.run(turn, async () => {
            endings.reset();
            await promptSession(target, text);
            // flair#256: continue through reasoning-only turns, bounded.
            const reasoning = await repromptWhileReasoningOnly({
              session: target,
              readEnding: () => endings.current(),
              beginTurn: () => endings.reset(),
              onReprompt: (n, max) =>
                log(
                  `[bob] turn ended with reasoning only (no text, no tool call) — re-prompting (${n}/${max})`,
                ),
            });
            if (reasoning.endedReasoningOnly) {
              log(
                `[bob] the turn ended without a final report: its last turn carried reasoning only, no text and no tool call, after ${reasoning.reprompts} re-prompt(s)`,
              );
            }
          });
          return turn.messages;
        } finally {
          turn.origin = { kind: "run" };
          active = undefined;
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
