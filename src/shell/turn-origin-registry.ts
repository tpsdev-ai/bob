// Turn-origin registry — the OUT-OF-BAND channel for a turn's origin.
//
// WHY OUT OF BAND (round-3 shape): in round 2 the origin rode inside the prompt
// text as a nonce-bearing tag (tagPrompt / parseTurnOrigin). A prompt that could
// see one tagged prompt could copy the nonce into a forged tag and set an origin,
// and the forged `from` / `job` / `channel` then reached both the presence label
// and the turn summary. Round 3 removes the in-prompt tag entirely: a trusted
// injector (cron in persistent.ts, later discord / mail) records the origin in
// THIS runtime registry, keyed by the EXACT prompt it is about to send,
// immediately before it calls `session.prompt`. The presence capability reads the
// origin back from the registry on `before_agent_start` (e.prompt is the same
// string) and removes the entry. Prompt text — whatever it contains, including a
// perfectly-formed forged tag carrying a valid-looking nonce — can never write the
// registry, so no prompt content can ever set an origin. An unregistered prompt is
// {kind:"run"}.
//
// FIELD WHITELIST AT REGISTRATION (round-3 item 2): every origin field is
// validated by character class AND length when written:
//    * agent id / mail `from` / cron `job`: [a-z0-9-]{1,64}
//    * discord `channel` id: [0-9]{1,20} (a Discord snowflake)
// Anything else — a 300-char value, an uppercase letter, a space, a colon, a
// non-digit channel — is rejected at registration (returns false, nothing stored),
// so the turn is run and the value reaches neither the label nor the summary.
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

// The runtime registry. Keyed by the EXACT prompt string the injector passes to
// session.prompt. Presence reads it back on before_agent_start (e.prompt is the
// same string) and removes the entry, so a re-fire of the same prompt cannot
// replay a stale origin.
const registry = new Map<string, TurnOrigin>();

// Record an origin for a prompt, immediately before the injector sends it.
// Returns false WITHOUT storing when the prompt is not a string or the origin
// fails the field whitelist (item 2) — the turn is then run, and the value
// reaches neither the label nor the summary.
export function registerTurnOrigin(prompt: unknown, origin: TurnOrigin): boolean {
  if (typeof prompt !== "string") return false;
  if (!isValidOrigin(origin)) return false;
  registry.set(prompt, origin);
  return true;
}

// Read the origin recorded for a prompt and REMOVE the entry. An unregistered
// prompt (or a non-string prompt) is {kind:"run"} — the untagged default. The
// remove-on-read guarantees an origin describes exactly the one turn that fired:
// the same prompt fired later cannot replay a stale origin.
export function consumeTurnOrigin(prompt: unknown): TurnOrigin {
  if (typeof prompt !== "string") return { kind: "run" };
  const o = registry.get(prompt);
  if (o === undefined) return { kind: "run" };
  registry.delete(prompt);
  return o;
}

// Clear all registered origins. A test-isolation seam and a shutdown seam so an
// un-consumed entry cannot survive across test cases or a session restart.
export function clearTurnOriginRegistry(): void {
  registry.clear();
}
