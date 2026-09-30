// Bob manifest for the tps-mail capability — the Bob-side metadata the blessed
// catalog imports. It carries the capability's OWN CONFIG_SCHEMA, so the
// catalog pre-validates an agent's bob.yaml `tps-mail:` block against the very
// object the extension and `bob doctor` validate: one definition.
//
// tps-mail registers NO tools. It "serves": the persistent runtime (`bob run
// <name>`) runs its inbox consumer, and each accepted mail is answered by ONE
// turn in a FRESH session through the agent's launcher — never in the warm
// session (bob#200 §1).

import type { BobCapabilityManifest } from "../../shell/capability.js";
import { CONFIG_SCHEMA, TPS_MAIL_CAPABILITY } from "./config.js";

export const tpsMailManifest: BobCapabilityManifest = {
  name: TPS_MAIL_CAPABILITY,
  piPackage: "@tpsdev-ai/bob/capabilities/tps-mail",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: [],
    serves: true,
    // Private: mail bodies from allow-listed peers.
    dataClass: "private",
  },
};
