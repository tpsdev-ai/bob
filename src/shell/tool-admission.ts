// tool-admission.ts — bob's TOOL-ADMISSION gate (bob#356 V2a, D1).
//
// Runtime origins are metadata set AT ADMISSION; prompt, model and tool text
// cannot supply one (turn-origin.ts). This gate reads the origin a tool call is
// BOUND to and answers one question before the executor runs: may this origin
// reach this tool?
//
// The rule is an ALLOWLIST, keyed on origin, not a denylist of today's grant
// names (bob#356 Kern N2). A voice-origin turn — one a sidecar transcript of
// room speech opened, from a speaker bob has not verified — may reach
// `reachy_say` and nothing else.
// Everything else refuses, including tools that do not exist yet: a future
// grant tool is unreachable from voice the day it lands, without anyone
// remembering to list it here.
//
// So in a session bob's factory built with this gate (every session a turn
// admission serves; the factory refuses one whose gate did not load), a
// grant-class tool (mail send, calendar accept, payment) is not executed on a
// voice-origin turn. The refusal is fixed and content-free, and it tells the
// model that the member can ask again on an authenticated text channel. bob
// ships no confirmation broker (bob#356 D1): nothing links that later request
// to this refusal. Every non-voice origin (run, mail, cron, discord) passes
// this gate unchanged, under its own turn's policy.

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { boundOrigin, getSessionOrigin, getTurnAdmission } from "./turn-admission.js";
import type { TurnOrigin } from "./turn-origin.js";

/** The ONLY tools a voice-origin turn may reach (bob#356 rev 2.1 D1). */
export const VOICE_TOOL_ALLOWLIST: readonly string[] = Object.freeze(["reachy_say"]);

/** The audit classes named by the spec. They are labels for reporting, NOT the
 *  enforcement set: enforcement is the allowlist above (Kern N2). */
export const GRANT_TOOLS: readonly string[] = Object.freeze([
  "mail_send",
  "calendar_accept",
  "payment_send",
]);

/** The fixed, deterministic refusal a LISTED grant tool gets on a voice-origin
 *  turn. It differs from the generic allowlist refusal below: this one names the
 *  authenticated text channel and says nothing was executed; the generic one
 *  names the tool and the single tool a voice turn may reach. */
export const VOICE_GRANT_REFUSAL =
  "a voice-origin turn cannot use a grant tool; ask again on an authenticated text channel — nothing was executed";

export interface ToolAdmissionDecision {
  allow: boolean;
  /** True when the refusal is for a grant-class tool (audit label). */
  grant?: boolean;
  /** The refusal the model sees as the tool result; deterministic and fixed. */
  reason?: string;
}

export function isGrantTool(toolName: string): boolean {
  return GRANT_TOOLS.includes(toolName);
}

/**
 * Decide whether a tool call may execute. Only a bound `voice` origin is
 * restricted: every other origin (run, mail, cron, discord) and an unbound call
 * (a session with no admission and no declared origin) are unchanged.
 */
export function admitToolCall(
  toolName: string,
  origin: TurnOrigin | undefined,
): ToolAdmissionDecision {
  if (origin === undefined || origin.kind !== "voice") return { allow: true };
  if (VOICE_TOOL_ALLOWLIST.includes(toolName)) return { allow: true };
  if (isGrantTool(toolName)) {
    return { allow: false, grant: true, reason: VOICE_GRANT_REFUSAL };
  }
  return {
    allow: false,
    reason: `a voice-origin turn may use only ${VOICE_TOOL_ALLOWLIST.join(", ")}; ${toolName} is not reachable from the room`,
  };
}

export interface ToolAdmissionPi {
  on(event: "tool_call", handler: (event: { toolName: string }) => unknown): void;
  events: Parameters<typeof getTurnAdmission>[0]["events"];
}

/**
 * The inline pi extension that refuses a blocked tool call BEFORE its executor
 * runs. bob's session factory loads it into every session that carries a turn
 * admission, so a voice-origin turn cannot reach a tool the gate refuses even if
 * a capability registered it.
 */
export function createToolAdmissionExtension(
  opts: { log?: (message: string) => void } = {},
): InlineExtension {
  const log = opts.log ?? ((message: string) => console.error(message));
  return {
    name: "bob-tool-admission",
    hidden: true,
    factory: ((pi: ToolAdmissionPi) => {
      const admission = getTurnAdmission(pi);
      const sessionOrigin = getSessionOrigin(pi);
      // The gate is installed ONLY for a session a turn admission serves (see
      // createBobRuntimeFactory). A missing admission therefore means the runtime
      // service did not reach the loader: refuse the session rather than install
      // no handler, because a session with no gate would execute every tool a
      // voice turn asked for. This throw is an extension-load failure; the
      // factory's assertToolAdmissionGateLoaded refuses session creation on it.
      if (admission === undefined) {
        throw new Error(
          "bob: tool admission gate has no turn-admission service; refusing a session that would run ungated",
        );
      }
      pi.on("tool_call", (event) => {
        const origin = boundOrigin({
          admission,
          ...(sessionOrigin ? { sessionOrigin } : {}),
        });
        const decision = admitToolCall(event.toolName, origin);
        if (decision.allow) return undefined;
        log(
          `bob: tool admission refused ${event.toolName} on a voice-origin turn: ${decision.reason}`,
        );
        return { block: true, reason: decision.reason };
      });
    }) as (pi: unknown) => void,
  };
}
