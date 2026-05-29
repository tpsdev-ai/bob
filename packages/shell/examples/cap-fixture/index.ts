// Fixture capability — a trivial pi extension used to PROVE Bob's capability
// loader end-to-end (resolve → validate config → compose into the pi session →
// pi loads its tool). This stands in for the real discord/flair/mail/heartbeat
// capabilities (later PRs) so the *mechanism* can be tested without standing up
// any real connection.
//
// A Bob capability is exactly a pi extension: a default-export factory
// `(pi: ExtensionAPI) => void | Promise<void>`. This one registers a single
// no-op tool. pi loads this file via jiti (no build step) when Bob adds its
// path to the resource loader's extension sources.
//
// The companion manifest (manifest.ts) is the Bob-side metadata; the blessed
// catalog points at it. Kept as a sibling module so a real published capability
// package would export both from one place.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
