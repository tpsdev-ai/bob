// Capability loader — resolves an agent's `bob.yaml capabilities:` list against
// the blessed catalog, validates each capability's config block against its
// manifest's typebox schema, and composes the result into the pi session.
//
// HOW capabilities reach pi (the key design choice): each resolved capability's
// `piPackage` becomes an entry in pi's `DefaultResourceLoader`
// `additionalExtensionPaths`. That option routes through pi's package resolver
// (`resolveExtensionSources`), which accepts npm:/git:/local-path sources — it
// is the in-process / SDK-level equivalent of a `settings.json`
// `packages`/`extensions` entry. We use this rather than `createAgentSession`'s
// `customTools` (that's for Bob-authored *inline* tools, not capability
// *packages* that pi must load + lifecycle) and rather than writing a
// `settings.json` to disk (the embedded SDK path is configured via loader
// options, not a per-agent settings file). pi then owns tool exposure, hooks,
// and the extension lifecycle — no Bob-side tool/hook registry.

import { Value } from "typebox/value";
import { readBlock, readCapabilities } from "./bob-yaml.js";
import type { BobCapabilityManifest, CatalogEntry } from "./capability.js";
import { lookupCapability as defaultLookup } from "./capability-catalog.js";
import { resolveExtensionSource as defaultResolveSource } from "./capability-resolve.js";
import { assertWebComposition, capabilityListView } from "./data-class.js";

// One resolved, validated capability.
export interface ResolvedCapability {
  name: string;
  manifest: BobCapabilityManifest;
  // The agent's validated config block for this capability (from the bob.yaml
  // block keyed by the capability name), or {} when no block was present.
  config: Record<string, unknown>;
  // The pi extension source to hand to the resource loader. This is the
  // manifest's `piPackage` RESOLVED (capability-resolve.ts): a package specifier
  // becomes the absolute path of its installed entry point; npm:/git: sources
  // pass through for pi to fetch.
  piPackage: string;
}

// The full resolution result for an agent.
export interface CapabilityResolution {
  capabilities: ResolvedCapability[];
  // pi extension sources, in declared order — feed straight into
  // DefaultResourceLoader's `additionalExtensionPaths`.
  extensionSources: string[];
}

export interface ResolveCapabilitiesOptions {
  // The bob.yaml contents (already read by the caller).
  yamlText: string;
  // Catalog lookup. Injectable for tests; defaults to the blessed catalog.
  lookup?: (name: string) => CatalogEntry | undefined;
  // Turns a manifest's `piPackage` into a source pi can load. Injectable for
  // tests; defaults to Node ESM package resolution from the shell package.
  resolveSource?: (capability: string, spec: string) => string;
  // When set, only these DECLARED capability names are resolved and loaded;
  // others are skipped. The caller (the position resolver) has already validated
  // the skipped names against the grant/position, so this is how a capability
  // disabled by the local override layer is not loaded.
  only?: readonly string[];
}

// Resolve + validate an agent's declared capabilities. Throws a single,
// actionable error on the first problem (unknown capability, not-yet-built
// capability, a config block written in a YAML shape the reader doesn't support
// — `BobYamlError` from readBlock, a config block that fails its schema, a
// capability package that isn't installed, or a set that composes `web` with a
// private-class capability) so a misconfigured agent fails fast
// at session setup rather than silently running under-equipped.
export function resolveCapabilities(opts: ResolveCapabilitiesOptions): CapabilityResolution {
  const lookup = opts.lookup ?? defaultLookup;
  const resolveSource = opts.resolveSource ?? defaultResolveSource;
  const declared = readCapabilities(opts.yamlText);
  const only = opts.only === undefined ? undefined : new Set(opts.only);
  const names = only === undefined ? declared : declared.filter((n) => only.has(n));

  const resolved: ResolvedCapability[] = [];
  const seen = new Set<string>();

  // Duplicate detection runs over the FULL declared list, so a capability
  // declared twice is refused even when only one occurrence would be loaded.
  const declaredSeen = new Set<string>();
  for (const name of declared) {
    if (declaredSeen.has(name)) {
      throw new Error(`capability "${name}" is declared more than once in capabilities:`);
    }
    declaredSeen.add(name);
  }

  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`capability "${name}" is declared more than once in capabilities:`);
    }
    seen.add(name);

    const entry = lookup(name);
    if (!entry) {
      throw new Error(
        `unknown capability "${name}" — not in Bob's blessed catalog. Only blessed capabilities may be loaded.`,
      );
    }
    if (entry.notYetImplemented) {
      throw new Error(
        `capability "${name}" is blessed but not yet implemented (its pi package doesn't exist yet). Remove it from capabilities: until it ships.`,
      );
    }

    const config = readBlock(opts.yamlText, name) ?? {};
    if (!Value.Check(entry.manifest.configSchema, config)) {
      const first = [...Value.Errors(entry.manifest.configSchema, config)][0];
      const where = first?.instancePath ? ` (at ${first.instancePath})` : "";
      throw new Error(
        `capability "${name}" config is invalid${where}: ${first?.message ?? "schema check failed"}`,
      );
    }

    // Resolve LAST — after the name and its config are known good, so a missing
    // package doesn't mask a typo'd capability or a bad config block. Resolution
    // is what turns "blessed" into "on disk"; it throws with the package name
    // and how to install it.
    resolved.push({
      name,
      manifest: entry.manifest,
      config,
      piPackage: resolveSource(name, entry.manifest.piPackage),
    });
  }

  // bob#244: the composition rule at YAML load. A set that holds `web` may hold
  // only public-class capabilities (data-class.ts); the session factory checks
  // the rest of the session — tools, startup context, history — at creation,
  // bind and reload. Over the capabilities that will actually LOAD (`only`
  // applied): a disabled capability composes nothing.
  assertWebComposition(capabilityListView(resolved.map((c) => c.name)), lookup);

  return {
    capabilities: resolved,
    extensionSources: resolved.map((c) => c.piPackage),
  };
}

// The env var a capability extension reads its resolved config from, by
// convention: BOB_CAP_<NAME_UPPER>. A capability is a pi extension loaded
// in-process (jiti); pi has no notion of Bob's per-capability config, so Bob
// hands the *validated* config block to the extension through this env var as a
// JSON blob. The blob carries config only — paths, ids, flags — NEVER a secret
// (the discord capability's token stays on disk; config holds a file PATH).
export function capabilityEnvVar(name: string): string {
  return `BOB_CAP_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

// Build the { envVar: jsonConfig } map for a resolution. The caller sets these
// on the environment before the session's resource loader loads the extensions,
// so each extension can read + re-validate its own config block. Returns an
// empty object when no capabilities declare config. NOTE: validated config
// blocks never contain secrets (schemas forbid an inlined token), so this map
// is safe to set in-process — but it must NOT be logged wholesale.
export function capabilityConfigEnv(resolution: CapabilityResolution): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cap of resolution.capabilities) {
    out[capabilityEnvVar(cap.name)] = JSON.stringify(cap.config);
  }
  return out;
}
