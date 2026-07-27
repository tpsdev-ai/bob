// Bob manifest for the flair capability — the thin Bob-side metadata pi doesn't
// ship (see @tpsdev-ai/bob-shell capability.ts). Mirrors the capability's own
// CONFIG_SCHEMA so Bob can pre-validate an agent's bob.yaml `flair:` block
// against the catalog before the extension loads.
//
// `piPackage` is this package's own name. Bob's catalog blesses the same
// specifier and resolves it through Node's ESM resolver at session setup, so it
// works from a monorepo checkout and from a published install alike. It is
// deliberately NOT version-pinned here: the version that matters is the one
// @tpsdev-ai/bob depends on, and a hardcoded version in source rots at every
// bump.

import type { BobCapabilityManifest } from "@tpsdev-ai/bob-shell";
import { CONFIG_SCHEMA } from "./config.js";

export const flairManifest: BobCapabilityManifest = {
  name: "flair",
  piPackage: "@tpsdev-ai/bob-cap-flair",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["flair_search", "flair_write", "flair_get"],
    serves: false,
  },
};
