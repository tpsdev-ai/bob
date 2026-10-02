// Bob manifest for the work capability — the thin Bob-side metadata pi doesn't
// ship (see src/shell/capability.ts). It carries the capability's OWN
// CONFIG_SCHEMA, so the blessed catalog pre-validates an agent's bob.yaml
// `work:` block against the very object the extension re-validates at load.
//
// `piPackage` is a self-referencing specifier into this package's `exports`
// map, resolved through Node's ESM resolver at session setup.

import type { BobCapabilityManifest } from "../../shell/capability.js";
import { CONFIG_SCHEMA } from "./config.js";

export const workManifest: BobCapabilityManifest = {
  name: "work",
  piPackage: "@tpsdev-ai/bob/capabilities/work",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["run", "run_status", "run_cancel", "apply_patch"],
    serves: false,
    // Private: a command's output can carry any workspace or host data.
    dataClass: "private",
  },
};
