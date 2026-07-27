// Bob manifest for the flair capability — the thin Bob-side metadata pi doesn't
// ship (see src/shell/capability.ts). It carries the capability's OWN
// CONFIG_SCHEMA (not a copy of it), so the blessed catalog pre-validates an
// agent's bob.yaml `flair:` block against the very object the extension
// re-validates when it loads. There is one definition of this schema.
//
// `piPackage` is a self-referencing specifier into this package's `exports`
// map. Bob's catalog blesses the same specifier and resolves it through Node's
// ESM resolver at session setup, so it lands on the built extension identically
// from a checkout and from a published install. Never version-pinned: the
// capability ships in the same tarball as the code resolving it.

import type { BobCapabilityManifest } from "../../shell/capability.js";
import { CONFIG_SCHEMA } from "./config.js";

export const flairManifest: BobCapabilityManifest = {
  name: "flair",
  piPackage: "@tpsdev-ai/bob/capabilities/flair",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["flair_search", "flair_write", "flair_get"],
    serves: false,
  },
};
