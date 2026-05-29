// Bob manifest for the fixture capability. In a real published capability this
// would be exported from the package alongside the extension factory; here it's
// a sibling module the blessed catalog imports.

import { Type } from "typebox";
import type { BobCapabilityManifest } from "../../src/capability.js";

export const fixtureManifest: BobCapabilityManifest = {
  name: "fixture",
  // Resolved to an absolute local path by the catalog at load time. A real
  // capability would use an npm: or git: spec here.
  piPackage: "./index.ts",
  configSchema: Type.Object({
    // A trivial optional knob so config validation has something to check.
    greeting: Type.Optional(
      Type.String({ description: "Optional greeting the fixture would log." }),
    ),
  }),
  provides: {
    tools: ["bob_fixture_noop"],
    serves: false,
  },
};
