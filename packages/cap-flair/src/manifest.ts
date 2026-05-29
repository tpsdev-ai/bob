// Bob manifest for the flair capability — the thin Bob-side metadata pi doesn't
// ship (see @tpsdev-ai/bob-shell capability.ts). Mirrors the capability's own
// CONFIG_SCHEMA so Bob can pre-validate an agent's bob.yaml `flair:` block
// against the catalog before the extension loads.
//
// `piPackage` is the published npm spec (the portable form). The blessed
// catalog overrides it with a resolved LOCAL path during phase 1 (mirroring how
// discord/the fixture are blessed) until this package is published.

import type { BobCapabilityManifest } from "@tpsdev-ai/bob-shell";
import { CONFIG_SCHEMA } from "./config.js";

export const flairManifest: BobCapabilityManifest = {
  name: "flair",
  piPackage: "npm:@tpsdev-ai/bob-cap-flair@0.1.0",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["flair_search", "flair_write", "flair_get"],
    serves: false,
  },
};
