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

// One resolved, validated capability.
export interface ResolvedCapability {
  name: string;
  manifest: BobCapabilityManifest;
  // The agent's validated config block for this capability (from the bob.yaml
  // block keyed by the capability name), or {} when no block was present.
  config: Record<string, unknown>;
  // The pi extension source to hand to the resource loader (== manifest.piPackage).
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
}

// Resolve + validate an agent's declared capabilities. Throws a single,
// actionable error on the first problem (unknown capability, not-yet-built
// capability, or a config block that fails its schema) so a misconfigured agent
// fails fast at session setup rather than silently running under-equipped.
export function resolveCapabilities(opts: ResolveCapabilitiesOptions): CapabilityResolution {
  const lookup = opts.lookup ?? defaultLookup;
  const names = readCapabilities(opts.yamlText);

  const resolved: ResolvedCapability[] = [];
  const seen = new Set<string>();

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

    resolved.push({
      name,
      manifest: entry.manifest,
      config,
      piPackage: entry.manifest.piPackage,
    });
  }

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
