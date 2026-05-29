// Bob manifest for the discord capability — the thin Bob-side metadata that
// pi doesn't ship (see @tpsdev-ai/bob-shell capability.ts). It mirrors the
// capability's own CONFIG_SCHEMA so Bob can pre-validate an agent's bob.yaml
// `discord:` block against the catalog before the extension ever loads.
//
// `piPackage` is set to the published npm spec here (the portable form). The
// blessed catalog overrides it with a resolved LOCAL path during phase 1
// (mirroring how the fixture is blessed) until this package is published.

import type { BobCapabilityManifest } from "@tpsdev-ai/bob-shell";
import { CONFIG_SCHEMA } from "./config.js";

export const discordManifest: BobCapabilityManifest = {
  name: "discord",
  piPackage: "npm:@tpsdev-ai/bob-cap-discord@0.2.0",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["discord_reply", "discord_react", "discord_fetch"],
    serves: true,
  },
};
