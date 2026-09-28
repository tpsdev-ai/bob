import { AsyncLocalStorage } from "node:async_hooks";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import type { RunSession } from "./run.js";
import { promptSession } from "./session.js";
import { approvedOrigin, type TurnOrigin } from "./turn-origin.js";

export interface TurnAdmission {
  // Resolves with this admission's messages, for the inbound source's reply.
  admitTurn(origin: TurnOrigin, text: string): Promise<unknown[]>;
  readOrigin(): TurnOrigin;
}

// One runtime owns one FIFO. Async context binds the origin to the actual
// prompt call, including its preflight awaits. A bare prompt outside this call
// reads run, even while an admitted prompt is paused before before_agent_start.
export function createTurnAdmission() {
  type Turn = { origin: TurnOrigin; messages: unknown[] };
  const context = new AsyncLocalStorage<Turn>();
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
        if (event.type !== "agent_end") return;
        const turn = context.getStore();
        if (turn !== active || !turn) return;
        turn.messages = event.messages;
        turn.origin = { kind: "run" };
      });
      ready();
    },
    admitTurn(origin: TurnOrigin, text: string): Promise<unknown[]> {
      // Copy before queuing: neither extra fields nor later caller mutations
      // may alter metadata. Closing is synchronous, including during preflight.
      const approved = approvedOrigin(origin);
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
          await context.run(turn, () => promptSession(target, text));
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
