// Bob's blessed capability catalog — the thin curation/trust layer pi doesn't
// ship (spec §4, decision "both"). An agent's `bob.yaml capabilities:` entries
// resolve against this map; only blessed names are allowed in the fleet, and
// this is the K&S gate for what capability extensions an agent may load.
//
// pi owns the actual tool/hook *registry* — this is NOT that. It's a name →
// manifest lookup so Bob knows which extension a capability resolves to and how
// to validate its config block, before handing the extension to pi's loader.
//
// EVERY blessed capability ships INSIDE this package (src/capabilities/<name>),
// so the catalog imports each capability's own manifest rather than mirroring
// it. The mirroring existed only because the shell used to be a separate
// package that could not depend on the capability packages; with one package
// the duplicate config schemas — and the "kept in sync with" comments that
// admitted the drift risk — are gone. A capability's schema now has exactly one
// definition, and the catalog pre-validates an agent's bob.yaml block against
// the same object the extension re-validates at load.

import { Type } from "typebox";
import { discordManifest } from "../capabilities/discord/manifest.js";
import { fixtureManifest } from "../capabilities/fixture/manifest.js";
import { flairManifest } from "../capabilities/flair/manifest.js";
import { observatoryManifest } from "../capabilities/observatory/manifest.js";
import type { BobCapabilityManifest, CatalogEntry } from "./capability.js";

// Planned capabilities whose extensions don't exist yet (later PRs). Listed so
// the catalog documents the intended fleet surface and `bob doctor` can show
// "blessed but unbuilt". configSchema is a permissive placeholder until the
// real capability defines it; resolving any of these is rejected (see resolver).
function placeholder(name: string, provides: BobCapabilityManifest["provides"]): CatalogEntry {
  return {
    manifest: {
      name,
      piPackage: `@tpsdev-ai/bob/capabilities/${name}`,
      configSchema: Type.Object({}, { additionalProperties: true }),
      provides,
    },
    notYetImplemented: true,
  };
}

// The catalog. Keyed by capability name. Adding a capability = drop it under
// src/capabilities/<name>/ and add an entry here; zero loader edits.
export const BLESSED_CATALOG: Readonly<Record<string, CatalogEntry>> = Object.freeze({
  // The fixture — a no-op extension that proves the loader end to end without
  // opening any connection. Blessed exactly like a real capability, through the
  // same self-referencing specifier, so the mechanism it proves is the
  // mechanism production uses.
  fixture: { manifest: fixtureManifest },
  discord: { manifest: discordManifest },
  flair: { manifest: flairManifest },
  observatory: { manifest: observatoryManifest },
  // --- planned, not yet implemented (later PRs) ---
  mail: placeholder("mail", { tools: ["mail_send"], serves: true }),
  heartbeat: placeholder("heartbeat", { serves: true }),
});

// Look up a capability by name. Returns undefined when the name isn't blessed.
export function lookupCapability(name: string): CatalogEntry | undefined {
  return BLESSED_CATALOG[name];
}
