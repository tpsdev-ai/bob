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
  // Where the capability's pi extension lives. Four accepted forms:
  //
  //   package specifier  "@tpsdev-ai/bob-cap-discord"  ← what real capabilities use
  //   local path         "/abs/path/index.ts"          ← the in-package fixture
  //   npm spec           "npm:@tpsdev-ai/bob-cap-x@1.2.3"
  //   git spec           "git:github.com/tpsdev-ai/bob-cap-x@v1"
  //
  // A PACKAGE SPECIFIER is the normal form: Bob resolves it through Node's ESM
  // resolver (capability-resolve.ts) to an absolute path before pi sees it, so
  // it works identically in a monorepo checkout and a published install, and a
  // package that isn't installed is a named error rather than an agent that
  // quietly comes up without its tools. npm:/git: sources are handed verbatim to
  // pi's resolver, which fetches them at session start.
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
