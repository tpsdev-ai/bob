// reachy/manifest.ts — the Bob-side metadata for the `reachy` capability
// (spec §3.1). Mirrored into Bob's blessed catalog.

import type { BobCapabilityManifest } from "../../shell/capability.js";
import { CONFIG_SCHEMA } from "./config.js";

export const reachyManifest: BobCapabilityManifest = {
  name: "reachy",
  piPackage: "@tpsdev-ai/bob/capabilities/reachy",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["reachy_look", "reachy_say", "reachy_state", "reachy_frame"],
    // reachy_state is a PLACEHOLDER: no request/response correlation yet.
    placeholderTools: ["reachy_state"],
    // serves: true — in S1 the capability injects inbound turns (speech
    // addressed to jarvis). S3 registers the tools and consumes events.
    serves: true,
  },
};
