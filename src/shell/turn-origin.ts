// Turn origins are runtime metadata, projected at admission before any await.
// Prompt, model and tool text cannot supply an origin.

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

const AGENT_JOB_RE = /^[a-z0-9-]{1,64}$/;
// discord `channel` id: digits only, 1..20 chars (a Discord snowflake).
const CHANNEL_ID_RE = /^[0-9]{1,20}$/;

// Validate an origin's field(s) by character class AND length (round-3 item 2).
// {kind:"run"} has no field to validate and is always valid. Anything else that
// is not a clean token is rejected — the turn stays run.
export function isValidOrigin(o: TurnOrigin): boolean {
  switch (o.kind) {
    case "run":
      return true;
    case "mail":
      return AGENT_JOB_RE.test(o.from);
    case "cron":
      return AGENT_JOB_RE.test(o.job);
    case "discord":
      return CHANNEL_ID_RE.test(o.channelId);
  }
}

// Project a caller-supplied origin down to ONLY the approved fields for its kind
// (round-4 item 3). The caller's object may carry extra fields (e.g.
// {kind:"cron", job:"valid", extra:"PROMPT_SECRET"}); this discards them and
// returns a freshly-constructed TurnOrigin (never the caller's object by
// reference), so an extra field can never reach the presence label or the turn
// summary.
export function approvedOrigin(o: TurnOrigin): TurnOrigin {
  if (!isValidOrigin(o)) return { kind: "run" };
  switch (o.kind) {
    case "mail":
      return { kind: "mail", from: o.from };
    case "cron":
      return { kind: "cron", job: o.job };
    case "discord":
      return { kind: "discord", channelId: o.channelId };
    default:
      return { kind: "run" };
  }
}
