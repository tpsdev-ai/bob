// Bob capability contract — the type surface a capability package exposes so
// Bob can resolve / configure / health-check it without bespoke per-capability
// code. See spec §4 "The capability contract".
//
// A Bob capability IS a pi extension (default-export `(pi: ExtensionAPI) => …`)
// shipped as a pi *package* — Bob does NOT build a parallel tool/hook registry.
// pi owns tool/hook loading. This module only adds the thin Bob-side metadata
// pi doesn't ship: a manifest (so Bob can validate the agent's config block and
// know which pi package to load) plus a blessed catalog (the curation/trust
// gate). Resolution of `bob.yaml capabilities:` goes through the catalog.

import type { TSchema } from "typebox";

// What a capability declares about itself. Self-describing IN the capability's
// own package (so a capability is fully portable), AND mirrored in Bob's
// blessed catalog (the trust layer pi doesn't ship). Decision per spec §4:
// "both".
export interface BobCapabilityManifest {
  // Stable capability id used in `bob.yaml capabilities:` (e.g. "discord").
  name: string;
  // Where the capability's pi extension package lives. Any source pi's package
  // resolver accepts: an npm spec ("npm:@tpsdev-ai/bob-cap-discord@1.2.3"), a
  // git spec ("git:github.com/tpsdev-ai/bob-cap-discord@v1"), or a local path
  // (absolute, or relative to the resolving settings file). This string is
  // handed verbatim to pi's resource loader as an extension source — the SDK
  // equivalent of a `settings.json` `packages`/`extensions` entry.
  piPackage: string;
  // typebox schema that validates the agent's per-capability config block from
  // bob.yaml (the block keyed by `name`). Use `Type.Object({})` for a
  // capability that takes no config.
  configSchema: TSchema;
  // Optional metadata for `bob doctor` / curation. Not load-bearing for the
  // loader; documents what the capability contributes.
  provides?: {
    // Tool names the capability registers (for doctor / allowlist display).
    tools?: string[];
    // True when the capability opens a persistent connection in its async
    // factory (e.g. a Discord gateway listener) — i.e. it "serves".
    serves?: boolean;
    // A pi provider id the capability registers, if any.
    provider?: string;
  };
}

// A blessed-catalog entry. Wraps the manifest with curation state Bob needs but
// the portable manifest shouldn't carry.
export interface CatalogEntry {
  manifest: BobCapabilityManifest;
  // Planned-but-unbuilt capabilities are listed so the catalog documents the
  // intended fleet surface, but resolving one is a hard error (its package
  // doesn't exist yet). The real discord/flair/mail/heartbeat capabilities flip
  // this to false as their packages land in later PRs.
  notYetImplemented?: boolean;
}
