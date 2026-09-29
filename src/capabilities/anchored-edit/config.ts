// Config surface for the anchored-edit capability.
//
// ONE KNOB, OWNED BY THE OPERATOR. `anchorPrefixPaths` names workspace-relative
// files whose new text may begin lines with the read_lines anchor prefix
// (`L<n>#<8 hex> `); edit_lines, insert_after and write_file refuse such text for
// every other file (bob#223). It is absent (empty) by default, it is read once
// when the capability loads, and no tool parameter can set or widen it: a model
// that copied read_lines output cannot turn the guard off from a tool call.
//
// Nothing else is a config value. The workspace root is NOT one: neither
// bob.yaml nor a tool argument may name it (spec, "Workspace root and paths").
// The root comes from pi's tool execution context (ExtensionContext.cwd), which
// Bob pins to the agent's working directory. The page, line and rewrite
// tripwire limits are fixed defaults in slice 1, so no path from bob.yaml can
// raise them. A future slice may add role-owned knobs; each waits for a ruled
// owner.
//
// The extension reads its resolved config from the loader's env var, so the
// capability goes through the same env hand-off every capability uses rather
// than special-casing itself.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const CONFIG_ENV_VAR = "BOB_CAP_ANCHORED_EDIT";

// A workspace-relative file path in normal form: one or more segments joined by
// single "/", no segment empty, "." or "..", and no backslash or NUL. So no
// leading "/", no "./", no trailing "/". The session compares an entry to the
// target's resolved path relative to the workspace root, so it must already be
// in that form to match at all.
export const RELATIVE_PATH_PATTERN = String.raw`^(?!\.{1,2}(?:/|$))(?!.*/\.{1,2}(?:/|$))[^/\\\u0000]+(?:/[^/\\\u0000]+)*$`;

// Only the named knob. An unknown key is refused so a bob.yaml block that tries
// to raise a limit fails loudly instead of silently doing nothing.
export const CONFIG_SCHEMA = Type.Object(
  {
    anchorPrefixPaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4096, pattern: RELATIVE_PATH_PATTERN }), {
        uniqueItems: true,
        maxItems: 256,
        description:
          "Workspace-relative files whose new text may begin lines with the read_lines anchor prefix (L<n>#<8 hex> ). The prefix guard stays on for every other file. Absent by default.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type AnchoredEditConfig = Static<typeof CONFIG_SCHEMA>;

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnchoredEditConfig {
  const raw = env[CONFIG_ENV_VAR];
  // The loader always sets the var (to "{}" when there is no block). An absent
  // var is only possible when the extension is loaded outside Bob; treat it as
  // the empty block rather than failing: the empty block leaves the prefix
  // guard on for every file.
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
      `anchored-edit capability: config is invalid${where}: ${first?.message ?? "schema check failed"}. The only anchored-edit knob is anchorPrefixPaths, a list of workspace-relative file paths (no leading "/", no "." or ".." segment).`,
    );
  }
  return parsed as AnchoredEditConfig;
}
