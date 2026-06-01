// Bob manifest for the observatory capability — the thin Bob-side metadata pi
// doesn't ship (see @tpsdev-ai/bob-shell capability.ts). Mirrors the capability's
// own CONFIG_SCHEMA so Bob can pre-validate an agent's bob.yaml `observatory:`
// block against the catalog before the extension loads.
//
// `piPackage` is the published npm spec (the portable form). The blessed catalog
// overrides it with a resolved LOCAL path during phase 1 (mirroring how
// discord/flair/the fixture are blessed) until this package is published.

import type { BobCapabilityManifest } from "@tpsdev-ai/bob-shell";
import { CONFIG_SCHEMA } from "./config.js";

export const observatoryManifest: BobCapabilityManifest = {
  name: "observatory",
  piPackage: "npm:@tpsdev-ai/bob-cap-observatory@0.1.0",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["observatory_report"],
    serves: false,
  },
};
