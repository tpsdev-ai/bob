// Bob manifest for the discord capability — the thin Bob-side metadata that
// pi doesn't ship (see @tpsdev-ai/bob-shell capability.ts). It mirrors the
// capability's own CONFIG_SCHEMA so Bob can pre-validate an agent's bob.yaml
// `discord:` block against the catalog before the extension ever loads.
//
// `piPackage` is this package's own name. Bob's catalog blesses the same
// specifier and resolves it through Node's ESM resolver at session setup, so it
// works from a monorepo checkout and from a published install alike. It is
// deliberately NOT version-pinned here: the version that matters is the one
// @tpsdev-ai/bob depends on, and a hardcoded version in source rots at every
// bump.

import type { BobCapabilityManifest } from "@tpsdev-ai/bob-shell";
import { CONFIG_SCHEMA } from "./config.js";

export const discordManifest: BobCapabilityManifest = {
  name: "discord",
  piPackage: "@tpsdev-ai/bob-cap-discord",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["discord_reply", "discord_react", "discord_fetch"],
    serves: true,
  },
};
