// Host secret bindings and the enabled-only presence check (bob#195, slice 1).
//
// A POSITION declares required secret NAMES (and nothing else). The HOST owns
// the bindings that supply a value or a path at session start. Positions and
// agent-writable configuration can never choose a destination for a secret —
// they name it; the host resolves it.
//
// Bindings come from host-owned state, never from bob.yaml or the override
// layer:
//   * the environment: BOB_SECRET_<NAME> (the value), and
//   * a host file at <hostRoot>/secrets.json mapping NAME -> { value } or
//     { path } (a 0600 file the operator writes).
//
// Presence is checked only for the EFFECTIVE ENABLED capability set. A secret
// missing for a capability that is off blocks only ENABLING it — never the
// hire/boot of the agent as it stands.
//
// Nothing here ever returns, logs or prints a secret VALUE beyond the binding
// object itself; callers that only need presence should use `isBound`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SecretBinding {
  // A literal value. Never written to bob.yaml, the override layer or logs.
  value?: string;
  // A host path a capability reads at runtime instead of an inline value.
  path?: string;
}

export type SecretBindings = Record<string, SecretBinding>;

export interface SecretBindingSource {
  env?: NodeJS.ProcessEnv;
  hostRoot?: string;
}

// The env-var NAME a secret is bound through (value form). Name only — the
// caller reads the value, never this function's text.
export function secretEnvVar(name: string): string {
  return `BOB_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

// Load host secret bindings. The host file wins over the environment when both
// name the same secret (an explicit operator binding beats an ambient var).
export function loadSecretBindings(src: SecretBindingSource = {}): SecretBindings {
  const env = src.env ?? process.env;
  const bindings: SecretBindings = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("BOB_SECRET_") || typeof value !== "string" || value === "") continue;
    // Recover the logical name from the env var spelling.
    const logical = key.slice("BOB_SECRET_".length);
    bindings[logical] = { value };
  }
  if (src.hostRoot) {
    const file = join(src.hostRoot, "secrets.json");
    if (existsSync(file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        throw new Error(
          `bob: host secret bindings at ${file} are not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, binding] of Object.entries(parsed as Record<string, unknown>)) {
          if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
          const b = binding as Record<string, unknown>;
          const out: SecretBinding = {};
          if (typeof b.value === "string" && b.value !== "") out.value = b.value;
          if (typeof b.path === "string" && b.path !== "") out.path = b.path;
          if (out.value !== undefined || out.path !== undefined) bindings[name] = out;
        }
      }
    }
  }
  return bindings;
}

// Is a secret name bound? A path binding counts only when the path exists (a
// binding to a missing file is not a usable secret). Never reveals the value.
export function isBound(bindings: SecretBindings, name: string): boolean {
  const b = bindings[name];
  if (!b) return false;
  if (typeof b.value === "string" && b.value !== "") return true;
  if (typeof b.path === "string" && b.path !== "" && existsSync(b.path)) return true;
  return false;
}

// The enabled-only presence check: every secret required by an ENABLED
// capability must be bound. Returns the missing (capability, name) pairs so the
// caller can refuse naming them; an empty list means the check passed.
//
// `requirements` is the position's per-capability secret list; `enabled` is the
// effective enabled capability set.
export function missingSecrets(
  requirements: ReadonlyArray<{ capability: string; names: string[] }>,
  enabled: readonly string[],
  bindings: SecretBindings,
): Array<{ capability: string; name: string }> {
  const on = new Set(enabled);
  const missing: Array<{ capability: string; name: string }> = [];
  for (const req of requirements) {
    if (!on.has(req.capability)) continue;
    for (const name of req.names) {
      if (!isBound(bindings, name)) missing.push({ capability: req.capability, name });
    }
  }
  return missing;
}
