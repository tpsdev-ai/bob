// Bob manifest for the anchored-edit capability — the thin Bob-side metadata pi
// doesn't ship (see src/shell/capability.ts). It carries the capability's OWN
// CONFIG_SCHEMA (not a copy), so the blessed catalog pre-validates an agent's
// bob.yaml `anchored-edit:` block against the very object the extension
// re-validates when it loads.
//
// `piPackage` is a self-referencing specifier into this package's `exports`
// map. Bob's catalog blesses the same specifier and resolves it through Node's
// ESM resolver at session setup, so it lands on the built extension identically
// from a checkout and from a published install. Never version-pinned.

import type { BobCapabilityManifest } from "../../shell/capability.js";
import { CONFIG_SCHEMA } from "./config.js";

export const anchoredEditManifest: BobCapabilityManifest = {
  name: "anchored-edit",
  piPackage: "@tpsdev-ai/bob/capabilities/anchored-edit",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["read_lines", "edit_lines", "insert_after", "write_file"],
    serves: false,
    // Private: read_lines returns the bytes of workspace files.
    dataClass: "private",
  },
};
