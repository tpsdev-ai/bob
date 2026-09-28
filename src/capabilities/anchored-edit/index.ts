// Bob capability: anchored-edit — a pi extension.
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => void`. pi loads this via jiti when Bob adds its path to
// the resource loader's extension sources. This file is the thin adapter: read
// config (env) → wire the four anchored tools (wireAnchoredEdit). All logic +
// tests live in core.ts / capability.ts.
//
// The workspace root is pi's tool execution context cwd, resolved per call in
// capability.ts. Nothing here takes a root from config.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireAnchoredEdit } from "./capability.js";
import { loadConfigFromEnv } from "./config.js";

export default function (pi: ExtensionAPI): void {
  // Validate the (empty) config block so a bad bob.yaml block fails at load.
  loadConfigFromEnv();
  wireAnchoredEdit({ pi: pi as unknown as Parameters<typeof wireAnchoredEdit>[0]["pi"] });
}

export { type PiLike, type WireOptions, wireAnchoredEdit } from "./capability.js";
export {
  type AnchoredEditConfig,
  CONFIG_ENV_VAR,
  CONFIG_SCHEMA,
  loadConfigFromEnv,
} from "./config.js";
export {
  AnchoredEditSession,
  anchorHashOf,
  anchorToken,
  applyEditLines,
  applyInsertAfter,
  dominantEol,
  eolLabel,
  fingerprintOf,
  fnv1a32,
  MAX_LINE_CHARS,
  MAX_LINES_PER_PAGE,
  MAX_OUTPUT_BYTES,
  parseFile,
  parseNewText,
  Refusal,
  renderReadLines,
  splitRawLines,
} from "./core.js";
export { anchoredEditManifest } from "./manifest.js";
