// Config surface for the tps-mail capability (bob#200 §7).
//
// The capability owns its typebox schema (CONFIG_SCHEMA), exactly like
// discord's: Bob's blessed catalog pre-validates an agent's bob.yaml
// `tps-mail:` block against this very object before anything loads, the
// extension re-validates it at load, and `bob doctor` validates it again. There
// is one definition.
//
// SECURITY: `senders` is the trust boundary and it is REQUIRED and NON-EMPTY.
// A tps-mail capability with no allow-list would let any principal whose
// signature verifies reach a turn, so a missing or empty list is a schema
// failure: the capability refuses to load and doctor FAILS (F2). Each entry is
// an exact TPS agent id — no globs, no prefixes: the pattern forbids every
// wildcard character, and the consumer compares with Set membership. An entry
// can never start with "-", so a sender id is never read as a flag by the CLI
// the reply is handed to.
//
// Allow-listing a sender GRANTS IT THE AGENT'S READ SCOPE: whatever a mail turn
// can read (its Flair memory) can end up in the reply that goes back to that
// sender. List only principals already entitled to that scope. The mail turn
// itself holds no filesystem tool and no Discord tool (tool-allowlist.ts
// MAIL_TURN_EXCLUDED_TOOLS).

import { homedir } from "node:os";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// The capability's name in `bob.yaml capabilities:` and its config block key.
export const TPS_MAIL_CAPABILITY = "tps-mail";

// Env var the Bob loader sets to the JSON-encoded resolved config block
// (capability-loader.ts capabilityEnvVar("tps-mail")). Config only — no secret.
export const CONFIG_ENV_VAR = "BOB_CAP_TPS_MAIL";

// A TPS agent id as the CLI accepts one (sanitizeIdentifier: [A-Za-z0-9_-],
// at most 64 chars), with a leading alphanumeric so it can never be an argv
// flag. Shared by the schema and the consumer's own checks.
export const TPS_AGENT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";
export const TPS_AGENT_ID = new RegExp(TPS_AGENT_ID_PATTERN);

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_REPLY_CHARS = 4000;
// The TPS CLI refuses a body over 64 KB, and the signed envelope wraps the
// reply (JSON-escaped, UTF-8), so the cap stays well under it.
export const MAX_MAX_REPLY_CHARS = 16_000;

export const CONFIG_SCHEMA = Type.Object(
  {
    // The agent's TPS maildir root (holds new/ and cur/). `~/` is expanded.
    inbox: Type.String({
      minLength: 1,
      description: "The agent's TPS inbox root, e.g. ~/.tps/mail/<agent> (holds new/ and cur/).",
    }),
    // The allow-list of verified sender ids. REQUIRED, NON-EMPTY, exact match.
    senders: Type.Array(Type.String({ pattern: TPS_AGENT_ID_PATTERN }), {
      minItems: 1,
      uniqueItems: true,
      description:
        "Exact TPS agent ids allowed to start a mail turn (the trust boundary). Allow-listing a sender grants it the agent's read scope.",
    }),
    // Wall-clock bound on one mail turn (the launcher process is killed past it).
    turnTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 1000, maximum: 60 * 60_000, default: DEFAULT_TURN_TIMEOUT_MS }),
    ),
    // Cap on the reply text, like the Discord mirror's reply cap.
    maxReplyChars: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_MAX_REPLY_CHARS, default: DEFAULT_MAX_REPLY_CHARS }),
    ),
  },
  { additionalProperties: false },
);

export type TpsMailCapabilityConfig = Static<typeof CONFIG_SCHEMA>;

// Validate an already-parsed config value. Throws an actionable error naming
// the failing path; never echoes the value (a config blob is not something to
// copy into a log).
export function validateTpsMailConfig(value: unknown): TpsMailCapabilityConfig {
  if (!Value.Check(CONFIG_SCHEMA, value)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, value)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `tps-mail capability: config is invalid${where}: ${first?.message ?? "schema check failed"}. ` +
        `The block needs inbox: and a non-empty senders: list of exact TPS agent ids.`,
    );
  }
  return value as TpsMailCapabilityConfig;
}

// Parse + validate the config from the env var the loader sets.
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TpsMailCapabilityConfig {
  const raw = env[CONFIG_ENV_VAR];
  if (!raw || raw.trim() === "") {
    throw new Error(
      `tps-mail capability: ${CONFIG_ENV_VAR} is not set — Bob's loader must provide the resolved config block.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`tps-mail capability: ${CONFIG_ENV_VAR} is not valid JSON.`);
  }
  return validateTpsMailConfig(parsed);
}

// Expand a leading `~/` (node's fs does not). Same rule as the other
// capabilities' path fields.
export function expandHome(path: string, home: string = homedir()): string {
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}
