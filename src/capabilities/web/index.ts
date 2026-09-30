// Bob capability: web — a pi extension (bob#152, spec v3, slice R1a).
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => void`. In this slice the extension only validates the
// resolved config block Bob hands it in BOB_CAP_WEB, against the same schema
// the catalog validated bob.yaml with, and REGISTERS NO TOOL. There is no
// network code here: the fetch core is slice R1b, `web_fetch` is R1c.
//
// A session that holds this capability is a WEB session, and bob refuses to
// compose one with anything private (data-class.ts), at creation, after the
// mode binds extensions and after every reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfigFromEnv } from "./config.js";

export default function (_pi: ExtensionAPI): void {
  // A bad block fails the extension load, which bob turns into a named
  // session refusal (session.ts assertCapabilitiesLoaded).
  loadConfigFromEnv();
}

export {
  CONFIG_ENV_VAR,
  CONFIG_SCHEMA,
  FETCH_MAX_CHARS_CEILING,
  FETCH_MAX_CHARS_DEFAULT,
  FETCH_PER_TURN_CEILING,
  FETCH_PER_TURN_DEFAULT,
  loadConfigFromEnv,
  TEXT_PER_TURN_CEILING,
  TEXT_PER_TURN_DEFAULT,
  validateWebConfig,
  type WebConfig,
} from "./config.js";
export { resolveWebSettings, type WebSettings } from "./core.js";
export { webManifest } from "./manifest.js";
