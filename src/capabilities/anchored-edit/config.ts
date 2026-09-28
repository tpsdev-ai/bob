// Config surface for the anchored-edit capability.
//
// SLICE 1 TAKES NO CONFIG. The workspace root is NOT a config value: neither
// bob.yaml nor a tool argument may name it (spec, "Workspace root and paths").
// The root comes from pi's tool execution context (ExtensionContext.cwd), which
// Bob pins to the agent's working directory. The rewrite tripwire limit is a
// fixed default in slice 1, so no path from bob.yaml can raise it. A future
// slice may add role-owned knobs; this schema deliberately stays empty until a
// knob has a ruled owner.
//
// The extension still reads its resolved (empty) config from the loader's env
// var, so the capability goes through the same env hand-off every capability
// uses rather than special-casing itself.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const CONFIG_ENV_VAR = "BOB_CAP_ANCHORED_EDIT";

// No knobs in slice 1. An unknown key is refused so a bob.yaml block that tries
// to raise a limit fails loudly instead of silently doing nothing.
export const CONFIG_SCHEMA = Type.Object({}, { additionalProperties: false });

export type AnchoredEditConfig = Static<typeof CONFIG_SCHEMA>;

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnchoredEditConfig {
  const raw = env[CONFIG_ENV_VAR];
  // The loader always sets the var (to "{}" when there is no block). An absent
  // var is only possible when the extension is loaded outside Bob; treat it as
  // the empty block rather than failing, since slice 1 has no config to miss.
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`anchored-edit capability: ${CONFIG_ENV_VAR} is not valid JSON.`);
  }
  if (!Value.Check(CONFIG_SCHEMA, parsed)) {
    const first = [...Value.Errors(CONFIG_SCHEMA, parsed)][0];
    const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
    throw new Error(
      `anchored-edit capability: config is invalid${where}: ${first?.message ?? "schema check failed"}. Slice 1 takes no anchored-edit config.`,
    );
  }
  return parsed as AnchoredEditConfig;
}
