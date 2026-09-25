// Turn-origin model + human-facing label.
//
// The ORIGIN no longer rides inside the prompt text (round 3 removed the
// in-prompt nonce-bearing tag grammar — the old tagPrompt / parseTurnOrigin). A
// trusted injector records the origin OUT OF BAND in the turn-origin registry
// (see turn-origin-registry.ts) immediately before it calls session.prompt,
// into a single pending slot (not keyed by prompt text). It is taken back on
// before_agent_start via takePendingOrigin. No prompt content — whatever it
// contains, including a perfectly-formed forged tag — can ever set an origin.
//
// This module therefore keeps only the origin MODEL (the TurnOrigin union) and
// the human-facing labelling (originLabel). The field character classes and
// lengths are enforced at registration by the registry, not here.
//
// The consequence of a (structurally impossible) origin reaching a label is a
// cosmetic currentTask string — never a capability, secret, or control decision.

export type TurnOrigin =
  | { kind: "run" }
  | { kind: "mail"; from: string }
  | { kind: "cron"; job: string }
  | { kind: "discord"; channelId: string };

const DEFAULT_MAX_LABEL_CHARS = 120;

// Render a short human-facing label for an origin, capped at maxChars. Used as
// the runtime-authored `currentTask` on a presence beat and as the `origin`-derived
// field in a turn summary. Only the label is ever shown — never a prompt or model
// output (see the secrets-property test in the presence suite).
export function originLabel(
  origin: TurnOrigin,
  maxChars: number = DEFAULT_MAX_LABEL_CHARS,
): string {
  let label: string;
  switch (origin.kind) {
    case "mail":
      label = `mail from ${origin.from}`;
      break;
    case "cron":
      label = `cron ${origin.job}`;
      break;
    case "discord":
      label = `discord ${origin.channelId}`;
      break;
    default:
      label = "run";
      break;
  }
  if (label.length <= maxChars) return label;
  // Truncate to maxChars, leaving room for a single ellipsis so the reader
  // knows the label was cut.
  const budget = Math.max(0, maxChars - 1);
  return `${label.slice(0, budget)}\u2026`;
}
