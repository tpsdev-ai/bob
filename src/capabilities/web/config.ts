// Config surface for the web capability (bob#152, spec v3, slice R1a).
//
// ONE SCHEMA, TWO GATES. The blessed catalog validates an agent's bob.yaml
// `web:` block against CONFIG_SCHEMA before the extension loads (YAML load,
// capability-loader.ts), and the extension validates the resolved block it is
// handed in BOB_CAP_WEB against the SAME object before it does anything
// (loadConfigFromEnv below). Neither gate trusts the other: a block that would
// fail one fails both.
//
// The block is flat because bob.yaml's reader refuses nested mappings:
//
//   capabilities: [web]
//   web:
//     allow_http: false
//     fetch_max_chars: 20000
//     fetch_per_turn: 10
//     text_per_turn: 100000
//
// Every field is optional; an absent field takes its default (core.ts
// resolveWebSettings). The bounds are the operator's: the model may lower a
// per-fetch character limit in a later slice, never raise it past
// fetch_max_chars, and no config can raise any field past its ceiling here.
//
// The block carries settings only. It names no key, token or path, so the
// credential inventory (confined-read.ts) classifies no field of it. Search
// settings (`search_provider`, `search_key_file`) are a later slice; until then
// they are unknown keys and refused like any other.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// The env var the Bob loader sets to the JSON-encoded, validated block
// (capability-loader.ts capabilityEnvVar("web")).
export const CONFIG_ENV_VAR = "BOB_CAP_WEB";

// Text returned by one fetch: default and absolute ceiling (characters).
export const FETCH_MAX_CHARS_DEFAULT = 20_000;
export const FETCH_MAX_CHARS_CEILING = 100_000;
// Fetch attempts per admitted prompt: default and ceiling.
export const FETCH_PER_TURN_DEFAULT = 10;
export const FETCH_PER_TURN_CEILING = 10;
// Text all fetches (and, later, searches) may return per admitted prompt:
// default and ceiling (characters). The ceiling equals the default, so the
// operator may lower the shared allowance but not raise it.
export const TEXT_PER_TURN_DEFAULT = 100_000;
export const TEXT_PER_TURN_CEILING = 100_000;

export const CONFIG_SCHEMA = Type.Object(
  {
    // Plain-HTTP fetches. Off by default: HTTPS only.
    allow_http: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Allow plain-HTTP fetches (default false: HTTPS only).",
      }),
    ),
    // The most text one fetch returns, in characters.
    fetch_max_chars: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: FETCH_MAX_CHARS_CEILING,
        default: FETCH_MAX_CHARS_DEFAULT,
        description: `Characters of text one fetch may return (default ${FETCH_MAX_CHARS_DEFAULT}, at most ${FETCH_MAX_CHARS_CEILING}).`,
      }),
    ),
    // Fetch attempts per admitted prompt.
    fetch_per_turn: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: FETCH_PER_TURN_CEILING,
        default: FETCH_PER_TURN_DEFAULT,
        description: `Fetch attempts per admitted prompt (default ${FETCH_PER_TURN_DEFAULT}, at most ${FETCH_PER_TURN_CEILING}).`,
      }),
    ),
    // Text all web calls may return per admitted prompt, in characters.
    text_per_turn: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: TEXT_PER_TURN_CEILING,
        default: TEXT_PER_TURN_DEFAULT,
        description: `Characters of text all web calls may return per admitted prompt (default ${TEXT_PER_TURN_DEFAULT}, at most ${TEXT_PER_TURN_CEILING}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

export type WebConfig = Static<typeof CONFIG_SCHEMA>;

// Validate a parsed block against CONFIG_SCHEMA; throw naming the first
// problem (the field and the rule). Shared by the env gate below and by tests.
export function validateWebConfig(value: unknown): WebConfig {
  if (!Value.Check(CONFIG_SCHEMA, value)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, value)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `web capability: config is invalid${where}: ${first?.message ?? "schema check failed"}`,
    );
  }
  return value as WebConfig;
}

// The BOB_CAP_WEB gate: parse and re-validate the block the loader resolved.
// The loader always sets the variable ("{}" when bob.yaml has no `web:`
// block), so an unset or empty variable means the extension was loaded outside
// bob, and it is refused rather than read as the defaults.
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const raw = env[CONFIG_ENV_VAR];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `web capability: ${CONFIG_ENV_VAR} is not set — Bob's loader must provide the resolved config block.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the raw value.
    throw new Error(`web capability: ${CONFIG_ENV_VAR} is not valid JSON.`);
  }
  return validateWebConfig(parsed);
}
