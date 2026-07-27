// Fixture capability — a trivial pi extension used to PROVE Bob's capability
// loader end-to-end (resolve → validate config → compose into the pi session →
// pi loads its tool) without standing up any real connection.
//
// A Bob capability is exactly a pi extension: a default-export factory
// `(pi: ExtensionAPI) => void | Promise<void>`. This one registers a single
// no-op tool. It is laid out, built, blessed and resolved exactly like the
// discord/flair/observatory capabilities, so what it proves is what production
// does. (It used to live under examples/ and be blessed as an absolute path,
// which meant the capability the tests leaned on hardest was the one that
// bypassed the resolution path being tested.)
//
// The companion manifest (manifest.ts) is the Bob-side metadata the blessed
// catalog imports.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bob_fixture_noop",
    label: "Bob Fixture No-op",
    description:
      "A no-op tool registered by Bob's fixture capability. Proves the capability loader composed this extension into the pi session.",
    parameters: Type.Object({
      echo: Type.Optional(Type.String({ description: "Optional text echoed back verbatim." })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: params.echo ?? "ok" }],
        details: {},
      };
    },
  });
}
