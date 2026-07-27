// Bob manifest for the discord capability — the thin Bob-side metadata pi doesn't
// ship (see src/shell/capability.ts). It carries the capability's OWN
// CONFIG_SCHEMA (not a copy of it), so the blessed catalog pre-validates an
// agent's bob.yaml `discord:` block against the very object the extension
// re-validates when it loads. There is one definition of this schema.
//
// `piPackage` is a self-referencing specifier into this package's `exports`
// map. Bob's catalog blesses the same specifier and resolves it through Node's
// ESM resolver at session setup, so it lands on the built extension identically
// from a checkout and from a published install. Never version-pinned: the
// capability ships in the same tarball as the code resolving it.

import type { BobCapabilityManifest } from "../../shell/capability.js";
import { CONFIG_SCHEMA } from "./config.js";

export const discordManifest: BobCapabilityManifest = {
  name: "discord",
  piPackage: "@tpsdev-ai/bob/capabilities/discord",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["discord_reply", "discord_react", "discord_fetch"],
    serves: true,
  },
};
