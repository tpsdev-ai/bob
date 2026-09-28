// Turn origins are runtime metadata, projected at admission before any await.
// Prompt, model and tool text cannot supply an origin.

import { ORIGIN_FIELD_LIMITS } from "./origin-limits.js";

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

// Validate before admission, so a malformed source cannot quietly become a
// run turn. The error names the field and bound, never the caller's value.
export function originValidationError(o: TurnOrigin): string | undefined {
  const check = (
    value: string,
    field: string,
    max: number,
    pattern: RegExp,
  ): string | undefined => {
    if (typeof value !== "string") return `${field} must be a string`;
    if (value.length === 0) return `${field} must not be empty`;
    if (value.length > max) return `${field} exceeds ${max} characters`;
    if (!pattern.test(value)) return `${field} contains invalid characters`;
    return undefined;
  };
  switch (o.kind) {
    case "run":
      return undefined;
    case "mail":
      return check(o.from, "mail.from", ORIGIN_FIELD_LIMITS.mailFrom, /^[a-z0-9-]+$/);
    case "cron":
      // bob init documents names with underscores (morning_briefing).
      return check(o.job, "cron.job", ORIGIN_FIELD_LIMITS.cronJob, /^[a-z0-9_-]+$/);
    case "discord":
      return check(
        o.channelId,
        "discord.channelId",
        ORIGIN_FIELD_LIMITS.discordChannelId,
        /^[0-9]+$/,
      );
    default:
      return "kind is unknown";
  }
}

export function isValidOrigin(o: TurnOrigin): boolean {
  return originValidationError(o) === undefined;
}

// Project a caller-supplied origin down to ONLY the approved fields for its kind
// (round-4 item 3). The caller's object may carry extra fields (e.g.
// {kind:"cron", job:"valid", extra:"PROMPT_SECRET"}); this discards them and
// returns a freshly-constructed TurnOrigin (never the caller's object by
// reference), so an extra field can never reach the presence label or the turn
// summary.
export function approvedOrigin(o: TurnOrigin): TurnOrigin {
  let approved: TurnOrigin;
  switch (o.kind) {
    case "mail":
      approved = { kind: "mail", from: o.from };
      break;
    case "cron":
      approved = { kind: "cron", job: o.job };
      break;
    case "discord":
      approved = { kind: "discord", channelId: o.channelId };
      break;
    case "run":
      approved = { kind: "run" };
      break;
    default:
      throw new Error("bob: invalid turn origin: kind is unknown");
  }
  const reason = originValidationError(approved);
  if (reason) throw new Error(`bob: invalid turn origin: ${reason}`);
  return approved;
}
