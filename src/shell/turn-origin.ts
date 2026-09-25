// Turn-origin tagging — the shared parser that lets an injector (mail S1,
// cron, discord) mark the ORIGIN of a prompt so the presence capability can
// report a runtime-authored currentTask label ("mail from flint", "cron
// daily-brief", "discord 123", "run").
//
// WHY A TAG AND NOT A SIDE-CHANNEL: pi injects a prompt as a plain user
// message (pi.sendUserMessage, or cron/croner's prompt path). The only channel
// we have to carry "where did this prompt come from" is the prompt text
// itself, so a trusted injector prepends a single, strictly-shaped marker
// line. parseTurnOrigin reads it back.
//
// FORGED-TAG STRIPPING (the security property): a tag is honored ONLY when it is
// the FIRST line of the prompt AND matches the exact, per-kind grammar below.
// Anything else — a tag in a later line, a malformed tag, an unknown kind, a
// missing or extra attribute, trailing content on the marker line — is treated
// as {kind:"run"} and the marker is NOT honored. A normal user (or a Discord
// message a human typed) cannot make their prompt read as a mail/cron/discord
// turn without producing the exact marker line the trusted injectors produce.
// This is best-effort (the prompt text is fully controllable by the source);
// the consequence of a successful forge is a cosmetic mislabel of a presence
// currentTask string — never a capability, secret, or control decision.
// See the "secrets property" test in the presence capability suite for the
// load-bearing guarantee.
//
// Grammar (first line, whole line; no leading/trailing whitespace tolerated):
//   bob-turn-origin:run
//   bob-turn-origin:mail:from=<name>
//   bob-turn-origin:cron:job=<job>
//   bob-turn-origin:discord:channel=<channelId>
//
// <name>/<job>/<channelId> is a single run of [^\s:] (no spaces, no colons) —
// e.g. an agent id /^[a-z0-9-]+$/, a croner job name, or a snowflake.

export type TurnOrigin =
  | { kind: "run" }
  | { kind: "mail"; from: string }
  | { kind: "cron"; job: string }
  | { kind: "discord"; channelId: string };

const DEFAULT_MAX_LABEL_CHARS = 120;

// One regex, anchored to the full first line. Each alternative is a kind with
// exactly one required attribute value (none for run). The value char class
// [^\s:]+ forbids a space or a second colon, so an extra attribute
// ("mail:from=flint:to=me") fails the $ anchor and the line is stripped.
const ORIGIN_TAG_RE =
  /^bob-turn-origin:(?:run|mail:from=([^\s:]+)|cron:job=([^\s:]+)|discord:channel=([^\s:]+))$/;

// Parse the origin tag from the FIRST line of a prompt. Returns {kind:"run"}
// for any untagged or forged / malformed input — see the module header for the
// forged-tag-stripping rationale. Does NOT look past the first line: a tag in
// a later line is a forged position and is stripped.
export function parseTurnOrigin(prompt: unknown): TurnOrigin {
  if (typeof prompt !== "string") return { kind: "run" };
  // String.split accepts a limit argument: split on the first newline, take
  // only the first element. Works in both Node and Bun.
  const firstLine = prompt.split("\n", 1)[0] ?? "";
  const m = ORIGIN_TAG_RE.exec(firstLine);
  if (!m) return { kind: "run" };
  if (m[1] !== undefined) return { kind: "mail", from: m[1] };
  if (m[2] !== undefined) return { kind: "cron", job: m[2] };
  if (m[3] !== undefined) return { kind: "discord", channelId: m[3] };
  return { kind: "run" };
}

// Tag a prompt with its origin so parseTurnOrigin can recover it. For
// {kind:"run"} this is a passthrough (run is the untagged default). Returns the
// full tagged prompt (tag on line 1, the original prompt on line 2+).
//
// The injector is responsible for ensuring the attribute value is a single
// [^\s:]+ token (agent id, job name, snowflake); a value containing a space or
// colon would not round-trip through parseTurnOrigin, and that is the injector's
// responsibility (the three real injectors — mail/cron/discord — all have
// single-token attribute values by construction).
export function tagPrompt(prompt: string, origin: TurnOrigin): string {
  switch (origin.kind) {
    case "mail":
      return `bob-turn-origin:mail:from=${origin.from}\n${prompt}`;
    case "cron":
      return `bob-turn-origin:cron:job=${origin.job}\n${prompt}`;
    case "discord":
      return `bob-turn-origin:discord:channel=${origin.channelId}\n${prompt}`;
    default:
      return prompt;
  }
}

// Render a short human-facing label for a origin, capped at maxChars. Used as
// the runtime-authored `currentTask` on a presence beat and as the `origin`
// field in a turn summary. Only the label is ever shown — never a prompt or
// model output (see the secrets-property test).
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
