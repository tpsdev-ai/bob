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
// FORGED-TAG STRIPPING (the security property, and its core defense): a tag is
// honored ONLY when it is the FIRST line of the prompt, matches the exact
// per-kind grammar below, AND carries the per-process origin nonce that only
// the runtime itself can produce (tagPrompt stamps it; a prompt a human typed —
// a Discord message, a mail body, anything — cannot, because the nonce is
// random and unknown outside this process, so any forged tag parses as
// {kind:"run"}). Anything else — a tag in a later line, a malformed tag, an
// unknown kind, a missing or wrong nonce, an extra attribute, trailing content
// on the marker line — is treated as {kind:"run"} and is NOT honored.
//
// The field grammars are also whitelisted by character class + length: a
// mail `from` / cron `job` is a run of [a-z0-9-] (agent ids, croner job
// names), a Discord `channel` id is digits-only (a snowflake). A crafted
// "from" carrying non-token text (uppercase, spaces, colons, a secret) cannot
// even clear the parser, so the forged text reaches neither the label nor the
// turn summary.
//
// This is best-effort (the prompt text is fully controllable by the source);
// the consequence of a successful forge is a cosmetic mislabel of a presence
// currentTask string — never a capability, secret, or control decision. See the
// "secrets property" test in the presence capability suite for the load-bearing
// guarantee.
//
// Grammar (first line, whole line; no leading/trailing whitespace tolerated):
//   bob-turn-origin:run
//   bob-turn-origin:mail:from=<name>:nonce=<nonce>
//   bob-turn-origin:cron:job=<job>:nonce=<nonce>
//   bob-turn-origin:discord:channel=<channelId>:nonce=<nonce>
//
// <name>/<job> is [a-z0-9-]+ (agent id / croner job name); <channelId> is
// [0-9]+ (a Discord snowflake); <nonce> is [0-9a-f]{16} produced by tagPrompt.

import { randomBytes } from "node:crypto";

export type TurnOrigin =
  | { kind: "run" }
  | { kind: "mail"; from: string }
  | { kind: "cron"; job: string }
  | { kind: "discord"; channelId: string };

const DEFAULT_MAX_LABEL_CHARS = 120;

// The per-process origin nonce: 16 hex chars (randomBytes(8)) generated ONCE
// when this module loads. Only tagPrompt — called by a trusted injector running
// in the SAME process — knows it, so an untrusted prompt (a human-typed
// message) can never carry a valid tag, and parseTurnOrigin accepts a tag only
// when its nonce matches this value. This is the load-bearing fix for forged
// origin tags: the prompt text is fully attacker-controllable, but the nonce is
// not.
const ORIGIN_NONCE = randomBytes(8).toString("hex");

// One regex, anchored to the full first line. Each non-run alternative is a kind
// with exactly one required field attribute (whitelisted by char class + the
// fixed nonce) AND the per-process nonce. The field char classes are tightened
// from the old [^\s:]+ to the real grammar — from/job are [a-z0-9-]+ (agent ids
// / croner job names), a Discord channel id is [0-9]+ (a snowflake) — so a
// crafted "from" carrying secret text (uppercase, spaces, colons) cannot clear
// the parser. The value/nonce runs forbid a space or a second colon, so an extra
// attribute ("mail:from=flint:to=me") fails the $ anchor and the line is
// stripped; a missing/wrong nonce fails the [0-9a-f]{16} match.
const ORIGIN_TAG_RE =
  /^bob-turn-origin:(?:run|mail:from=([a-z0-9-]+):nonce=([0-9a-f]{16})|cron:job=([a-z0-9-]+):nonce=([0-9a-f]{16})|discord:channel=([0-9]+):nonce=([0-9a-f]{16}))$/;

// Parse the origin tag from the FIRST line of a prompt. Returns {kind:"run"}
// for any untagged or forged / malformed input — see the module header for the
// forged-tag-stripping rationale. Does NOT look past the first line: a tag in
// a later line is a forged position and is stripped. A well-formed tag whose
// nonce does not match the per-process ORIGIN_NONCE is also treated as run — a
// human-typed (or model-supplied) prompt cannot know the nonce, so it can never
// forge an origin.
export function parseTurnOrigin(prompt: unknown): TurnOrigin {
  if (typeof prompt !== "string") return { kind: "run" };
  // String.split accepts a limit argument: split on the first newline, take
  // only the first element. Works in both Node and Bun.
  const firstLine = prompt.split("\n", 1)[0] ?? "";
  const m = ORIGIN_TAG_RE.exec(firstLine);
  if (!m) return { kind: "run" };
  // Each non-run alternative carries its own nonce group; honor the tag only
  // when that nonce matches the per-process value.
  if (m[1] !== undefined)
    return m[2] === ORIGIN_NONCE ? { kind: "mail", from: m[1] } : { kind: "run" };
  if (m[3] !== undefined)
    return m[4] === ORIGIN_NONCE ? { kind: "cron", job: m[3] } : { kind: "run" };
  if (m[5] !== undefined)
    return m[6] === ORIGIN_NONCE ? { kind: "discord", channelId: m[5] } : { kind: "run" };
  return { kind: "run" };
}

// Tag a prompt with its origin so parseTurnOrigin can recover it. For
// {kind:"run"} this is a passthrough (run is the untagged default, so no marker
// line is added). Returns the full tagged prompt (tag on line 1, the original
// prompt on line 2+).
//
// The nonce is embedded here from the per-process ORIGIN_NONCE — a value only
// this runtime knows — so a tag produced here round-trips through parseTurnOrigin
// and a tag a human typed (which cannot carry the real nonce) does not.
//
// The injector is responsible for ensuring the attribute value is a single
// whitelisted run (from/job: [a-z0-9-]+, channel: [0-9]+); a value containing a
// space, colon, or uppercase letter would not round-trip through parseTurnOrigin,
// and that is the injector's responsibility (the three real injectors —
// mail/cron/discord — all have single-token attribute values by construction).
export function tagPrompt(prompt: string, origin: TurnOrigin): string {
  switch (origin.kind) {
    case "mail":
      return `bob-turn-origin:mail:from=${origin.from}:nonce=${ORIGIN_NONCE}\n${prompt}`;
    case "cron":
      return `bob-turn-origin:cron:job=${origin.job}:nonce=${ORIGIN_NONCE}\n${prompt}`;
    case "discord":
      return `bob-turn-origin:discord:channel=${origin.channelId}:nonce=${ORIGIN_NONCE}\n${prompt}`;
    default:
      return prompt;
  }
}

// Render a short human-facing label for an origin, capped at maxChars. Used as
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
