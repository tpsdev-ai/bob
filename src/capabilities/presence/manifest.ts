// Bob manifest for the presence capability — the thin Bob-side metadata pi
// doesn't ship (see src/shell/capability.ts). It carries the capability's OWN
// CONFIG_SCHEMA (from config.ts, not a copy), so the blessed catalog
// pre-validates an agent's bob.yaml `presence:` block against the very object
// the extension re-validates when it loads. There is one definition of this
// schema.
//
// `serves: true` — the capability opens a persistent beacon interval and writes
// to Flair at runtime, so it only wires under BOB_PERSISTENT (one-shot `bob run`
// stays outbound-only; same gate as discord's gateway).
//
// `piPackage` is a self-referencing specifier into this package's `exports`
// map. Bob's catalog blesses the same specifier and resolves it through Node's
// ESM resolver at session setup, so it lands on the built extension identically
// from a checkout and from a published install. Never version-pinned: the
// capability ships in the same tarball as the code resolving it.
//
// This capability REPLACES the catalog's old `heartbeat` placeholder: presence
// IS the heartbeat (one liveness system).

import type { BobCapabilityManifest } from "../../shell/capability.js";
import { CONFIG_SCHEMA } from "./config.js";

export const presenceManifest: BobCapabilityManifest = {
  name: "presence",
  piPackage: "@tpsdev-ai/bob/capabilities/presence",
  configSchema: CONFIG_SCHEMA,
  provides: {
    serves: true,
    // No tools — presence is a runtime beacon + turn summary, not a tool
    // surface. The presence beat writes /Presence; the turn summary writes
    // /Memory; neither is a pi tool.
    tools: [],
  },
};
