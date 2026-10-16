// The testable core of the web capability (bob#152, spec v3, slice R1c),
// decoupled from pi's real ExtensionAPI so a test can drive it with a fake and
// inject the fetch core. `index.ts` is the thin factory that reads config and
// the runtime's turn admission and calls this.
//
// What it wires: the `web_fetch` tool (tool.ts) plus the lifecycle subscription
// that owns the tool's per-operation state. The state belongs to one ADMITTED
// OPERATION — the runtime's `activeAdmission()` token — not to a single
// before_agent_start/agent_settled pair: pi fires those once per prompt, and
// bob's automatic continuations (turn-admission's reasoning retries) send more
// prompts inside the same admission. The state is seeded on the first prompt of
// an operation and kept, unchanged, for the rest of it (same token), so
// provenance and spend survive the operation's continuations. A prompt outside
// any admission (a bare prompt) seeds nothing.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AdmissionToken, TurnAdmission } from "../../shell/turn-admission.js";
import { newTurnState, type WebTurnState } from "./admission.js";
import type { WebSettings } from "./core.js";
import { createWebFetchTool, type WebFetchFn } from "./tool.js";

// The minimal slice of pi's ExtensionAPI this core needs — declared structurally
// so a tiny test fake and the real ExtensionAPI both satisfy it (the real one is
// cast at the seam, as the other capabilities do).
export interface WebPiLike {
  on(event: "before_agent_start", handler: (event: { prompt: string }) => void): void;
  on(event: "session_shutdown", handler: () => void): void;
  registerTool(tool: ToolDefinition): void;
}

export interface WebCapabilityDeps {
  pi: WebPiLike;
  settings: WebSettings;
  // The runtime's turn admission, when the session has one. Without it, no
  // prompt is inside an admission: nothing is seeded and the tool is refused.
  admission?: Pick<TurnAdmission, "activeAdmission" | "readOrigin">;
  // The fetch core. Defaults to the R1b fetchDocument.
  fetch?: WebFetchFn;
}

export interface WebCapabilityHandle {
  // The state seeded for the admitted operation in flight, or undefined outside
  // one.
  currentState: () => WebTurnState | undefined;
}

export function wireWebCapability(deps: WebCapabilityDeps): WebCapabilityHandle {
  const { pi, admission } = deps;
  let state: WebTurnState | undefined;
  // The admission the current state belongs to, so a continuation (a later
  // prompt with the same token) keeps it and a new admission replaces it.
  let seededFor: AdmissionToken | undefined;

  pi.on("before_agent_start", (event) => {
    const token = admission?.activeAdmission();
    if (token === undefined || admission === undefined) {
      // A prompt outside any admission seeds nothing, and drops any state the
      // last admission left behind so it cannot be read outside its operation.
      state = undefined;
      seededFor = undefined;
      return;
    }
    // Same operation (a retry or a continuation): keep the state, and the
    // provenance and spend it holds. A new operation: seed a fresh state whose
    // origin is recorded so a call from a different admission is refused.
    if (seededFor === token) return;
    state = newTurnState(event.prompt, admission.readOrigin());
    seededFor = token;
  });
  pi.on("session_shutdown", () => {
    state = undefined;
    seededFor = undefined;
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
