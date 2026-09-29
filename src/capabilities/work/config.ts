// Config surface for the work capability (the managed `run` tool, bob#211).
//
// SLICE 1 TAKES NO CONFIG. The deadline default and the hard maximum are fixed
// in the capability (run.ts: DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S), so no path from
// bob.yaml can remove a command's deadline or raise its ceiling. bob has no
// channel yet from a role's role.json to a capability; the role-owned default
// and the clamp to the run's remaining budget arrive with the supervisor-owned
// deadline (bob#210 slice 4). Until a knob has a ruled owner this schema stays
// empty, the posture anchored-edit keeps for every knob but its one
// operator-owned `anchorPrefixPaths` (bob#223).
//
// The extension still reads its resolved (empty) config from the loader's env
// var, so it goes through the same hand-off every capability uses.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const CONFIG_ENV_VAR = "BOB_CAP_WORK";

// No knobs in slice 1. An unknown key is refused so a bob.yaml block that tries
// to change the deadline fails loudly instead of silently doing nothing.
export const CONFIG_SCHEMA = Type.Object({}, { additionalProperties: false });

export type WorkConfig = Static<typeof CONFIG_SCHEMA>;

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WorkConfig {
  const raw = env[CONFIG_ENV_VAR];
  // The loader always sets the var (to "{}" when there is no block). An absent
  // var is only possible when the extension is loaded outside Bob; treat it as
  // the empty block, since slice 1 has no config to miss.
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`work capability: ${CONFIG_ENV_VAR} is not valid JSON.`);
  }
  if (!Value.Check(CONFIG_SCHEMA, parsed)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, parsed)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `work capability: config is invalid${where}: ${first?.message ?? "schema check failed"}. Slice 1 takes no work config; the deadline default and maximum are fixed.`,
    );
  }
  return parsed as WorkConfig;
}
