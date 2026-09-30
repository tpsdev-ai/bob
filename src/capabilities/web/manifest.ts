// Bob manifest for the web capability (bob#152, spec v3) — the thin Bob-side
// metadata the blessed catalog imports. It carries the capability's OWN
// CONFIG_SCHEMA, so the catalog pre-validates an agent's bob.yaml `web:` block
// against the very object the extension re-validates from BOB_CAP_WEB.
//
// `tools` names what the capability is reviewed to provide: `web_fetch` (slice
// R1c) and `web_search` (R2). Slice R1a REGISTERS NEITHER: the names are
// declared now so their TOOL_EFFECTS rows (egress), the jarvis/ea role
// ceilings and the mail-turn exclusion can be reviewed and pinned before any
// web tool exists. A session whose allowlist names one is refused by the
// active-tool audit (session.ts assertAllowedToolsActive), because nothing
// registers it.
//
// `dataClass: public` — in this slice the capability registers no tool and
// imports no fetched content. web_fetch and web_search each need their own
// classification review when they land: fetched pages and search results are
// not public merely because they came from the web. The class is what lets web
// compose at all: a
// session that holds web may hold only public-class capabilities
// (data-class.ts).
//
// `piPackage` is a self-referencing specifier into this package's `exports`
// map, resolved through Node's ESM resolver at session setup.

import type { BobCapabilityManifest } from "../../shell/capability.js";
import { CONFIG_SCHEMA } from "./config.js";

export const webManifest: BobCapabilityManifest = {
  name: "web",
  piPackage: "@tpsdev-ai/bob/capabilities/web",
  configSchema: CONFIG_SCHEMA,
  provides: {
    tools: ["web_fetch", "web_search"],
    // No persistent connection, no inbound surface.
    serves: false,
    dataClass: "public",
  },
};
