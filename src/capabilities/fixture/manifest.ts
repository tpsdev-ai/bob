// Bob manifest for the fixture capability — the thin Bob-side metadata pi
// doesn't ship (see src/shell/capability.ts). Identical in shape to every real
// capability's manifest, deliberately: the fixture is what proves the loader
// mechanism, so it has to go through the mechanism production goes through.
// It used to be blessed as an absolute path into an `examples/` directory,
// which meant the one capability the tests exercised most was the one
// capability that never touched the real resolution path.

import { Type } from "typebox";
import type { BobCapabilityManifest } from "../../shell/capability.js";

export const fixtureManifest: BobCapabilityManifest = {
  name: "fixture",
  piPackage: "@tpsdev-ai/bob/capabilities/fixture",
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
