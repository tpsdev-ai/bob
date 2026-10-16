// The testable core of the web capability (bob#152, spec v3, slice R1c),
// decoupled from pi's real ExtensionAPI so a test can drive it with a fake and
// inject the fetch core. `index.ts` is the thin factory that reads config and
// the runtime's turn admission and calls this.
//
// What it wires: the `web_fetch` tool (tool.ts) plus the three lifecycle
// subscriptions that own the tool's per-prompt state. The state is a FRESH
// object per admitted prompt, seeded at `before_agent_start` and cleared on a
// full `agent_settled` and on session close — never on `agent_end`,
// `turn_start` or `turn_end`, which fire mid-prompt.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TurnAdmission } from "../../shell/turn-admission.js";
import { newTurnState, type WebTurnState } from "./admission.js";
import type { WebSettings } from "./core.js";
import { createWebFetchTool, type WebFetchFn } from "./tool.js";

// The minimal slice of pi's ExtensionAPI this core needs — declared structurally
// so a tiny test fake and the real ExtensionAPI both satisfy it (the real one is
// cast at the seam, as the other capabilities do).
export interface WebPiLike {
  on(event: "before_agent_start", handler: (event: { prompt: string }) => void): void;
  on(event: "agent_settled", handler: () => void): void;
  on(event: "session_shutdown", handler: () => void): void;
  registerTool(tool: ToolDefinition): void;
}

export interface WebCapabilityDeps {
  pi: WebPiLike;
  settings: WebSettings;
  // The runtime's turn admission, when the session has one. Without it, a
  // prompt was not routed through admission: nothing is seeded, so the tool is
  // refused.
  admission?: Pick<TurnAdmission, "readOrigin">;
  // The fetch core. Defaults to the R1b fetchDocument.
  fetch?: WebFetchFn;
}

export interface WebCapabilityHandle {
  // The state seeded for the prompt in flight, or undefined outside one.
  currentState: () => WebTurnState | undefined;
}

export function wireWebCapability(deps: WebCapabilityDeps): WebCapabilityHandle {
  const { pi, admission } = deps;
  let state: WebTurnState | undefined;

  pi.on("before_agent_start", (event) => {
    // A fresh state per admitted prompt, REPLACING any prior one: a retry or a
    // continuation fires no new before_agent_start, so the budgets hold across
    // them; a missed clear cannot carry state forward, because the next seed
    // wins. The admission origin is recorded so a call from a different
    // admission is refused. No admission means no state.
    const origin = admission?.readOrigin();
    state = origin === undefined ? undefined : newTurnState(event.prompt, origin);
  });
  pi.on("agent_settled", () => {
    state = undefined;
  });
  pi.on("session_shutdown", () => {
    state = undefined;
  });

  pi.registerTool(
    createWebFetchTool({
      settings: deps.settings,
      currentState: () => state,
      currentOrigin: () => admission?.readOrigin(),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    }),
  );

  return { currentState: () => state };
}
