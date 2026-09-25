// Turn-origin registry — the OUT-OF-BAND channel for a turn's origin.
//
// WHY OUT OF BAND (round-3 shape): in round 2 the origin rode inside the prompt
// text as a nonce-bearing tag (tagPrompt / parseTurnOrigin). A prompt that could
// see one tagged prompt could copy the nonce into a forged tag and set an origin,
// and the forged `from` / `job` / `channel` then reached both the presence label
// and the turn summary. Round 3 removed the in-prompt tag entirely: a trusted
// injector (cron in persistent.ts, later discord / mail) records the origin in
// THIS runtime registry immediately before it calls `session.prompt`, and the
// presence capability reads it back on `before_agent_start`. Prompt text —
// whatever it contains, including a perfectly-formed forged tag carrying a
// valid-looking nonce — can never write the registry, so no prompt content can
// ever set an origin. An origin-less turn is {kind:"run"}.
//
// WHY A SINGLE PENDING SLOT, NOT A PROMPT KEY (round-4 item 1): a prompt-keyed
// map attached origins to the WRONG turn — two identical prompts overwrote each
// other (the first turn consumed the second origin and the next read `run`), and
// pi can expand or transform the prompt text before `before_agent_start`, so the
// key might not match at all and silently downgrade a real origin to `run`. A
// call-scoped slot removes the key entirely:
//     * the injector SETS the slot immediately before `session.prompt`;
//     * presence TAKES + empties the slot on `before_agent_start`;
//     * the injector CLEARS the slot in a `finally`, whatever happens to the
//       prompt — so a rejected / aborted turn leaves no stale origin (item 2);
//     * the persistent host also CLEARS the slot on shutdown (item 2) so a
//       set-but-unconsumed slot cannot survive a session restart.
// Warm-session prompts are serialized behind the idle barrier, so a call-scoped
// slot cannot cross turns, and nothing depends on the prompt text.
//
// FIELD WHITELIST + COPY AT REGISTRATION (round-3 item 2 / round-4 item 3): every
// origin field is validated by character class AND length when written:
//     * agent id / mail `from` / cron `job`: [a-z0-9-]{1,64}
//     * discord `channel` id: [0-9]{1,20} (a Discord snowflake)
// Anything else — a 300-char value, an uppercase letter, a space, a colon, a
// non-digit channel — is rejected at registration (returns false, nothing stored),
// so the turn is run and the value reaches neither the label nor the summary.
// On a VALID origin the slot stores a NEWLY CONSTRUCTED origin holding only the
// approved fields for its kind (round-4 item 3), so an extra field on the
// caller's object — e.g. {kind:"cron", job:"valid", extra:"PROMPT_SECRET"} — is
// dropped here and can never reach the presence label or the turn summary.
//
// The consequence of a (structurally impossible) breach would be a cosmetic
// mislabel of a presence currentTask string — never a capability, secret, or
// control decision.

import type { TurnOrigin } from "./turn-origin.js";

// agent id / mail `from` / cron `job`: a run of [a-z0-9-], 1..64 chars (an agent
// id or a croner job name).
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
function approvedOrigin(o: TurnOrigin): TurnOrigin {
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

// The single pending-origin slot — NOT keyed by prompt text (round-4 item 1).
// The injector sets it immediately before session.prompt; presence takes +
// empties it on before_agent_start; the injector clears it in a finally and the
// host clears it on shutdown. null means "no injector set an origin this turn"
// -> run.
let pendingOrigin: TurnOrigin | null = null;

// Set the pending origin for the turn about to be sent, immediately before the
// injector calls session.prompt. Returns false WITHOUT storing when the origin
// fails the field whitelist (round-3 item 2) — the turn is then run, and the
// value reaches neither the label nor the summary. A valid origin is stored as a
// freshly-constructed origin with only its approved fields (round-4 item 3), so an
// extra field on the caller's object is dropped.
export function setPendingOrigin(origin: TurnOrigin): boolean {
  if (!isValidOrigin(origin)) return false;
  pendingOrigin = approvedOrigin(origin);
  return true;
}

// Read the pending origin and EMPTY the slot. A turn whose injector did not set
// an origin (the slot is null) is {kind:"run"} — the untagged default. The
// take-and-empty guarantees an origin describes exactly the one turn that fired:
// a later turn with no injector-set origin cannot replay a stale origin.
export function takePendingOrigin(): TurnOrigin {
  const o = pendingOrigin;
  pendingOrigin = null;
  return o ?? { kind: "run" };
}

// Clear the pending slot without reading it. The injector's `finally` calls this
// whatever happens to the prompt (round-4 item 2: a rejected / aborted turn must
// not leave a stale origin for the next turn), and the persistent host calls it
// on shutdown (round-4 item 2) so a set-but-unconsumed slot cannot survive a
// session restart.
export function clearPendingOrigin(): void {
  pendingOrigin = null;
}
