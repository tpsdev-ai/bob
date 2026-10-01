// The web capability's core (bob#152, spec v3). Slice R1a ships the settings
// the fetch core enforces: the validated config block with its defaults
// applied. The fetch core itself — the address policy, redirects, limits and
// extraction (fetch.ts) — is slice R1b, and the `web_fetch` tool is R1c.
// Neither R1b nor R1c registers a tool here yet.

import {
  FETCH_MAX_CHARS_DEFAULT,
  FETCH_PER_TURN_DEFAULT,
  TEXT_PER_TURN_DEFAULT,
  type WebConfig,
} from "./config.js";

// The resolved settings, every field present.
export interface WebSettings {
  // Plain-HTTP fetches allowed (otherwise HTTPS only).
  allowHttp: boolean;
  // The most text one fetch returns, in characters: the fetch core's ceiling.
  fetchMaxChars: number;
  // Fetch attempts per admitted prompt.
  fetchPerTurn: number;
  // Text all web calls may return per admitted prompt, in characters.
  textPerTurn: number;
}

// Apply the defaults to a block that has ALREADY passed validateWebConfig
// (config.ts). It adds nothing the schema did not allow and never widens a
// value: an absent field takes its default, a present one is kept as is.
export function resolveWebSettings(config: WebConfig): WebSettings {
  return {
    allowHttp: config.allow_http ?? false,
    fetchMaxChars: config.fetch_max_chars ?? FETCH_MAX_CHARS_DEFAULT,
    fetchPerTurn: config.fetch_per_turn ?? FETCH_PER_TURN_DEFAULT,
    textPerTurn: config.text_per_turn ?? TEXT_PER_TURN_DEFAULT,
  };
}
