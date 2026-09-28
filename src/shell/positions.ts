// Positions — packaged, role-compatible agent presets (bob#195, slice 1).
//
// A POSITION is a first-party, packaged artifact that names a ROLE (it never
// carries or edits one — no role.json, no ceiling, no allowResidentShell) and
// declares:
//
//   * the tools it REQUESTS (which the role's ceiling must already cover);
//   * the capabilities it PERMITS, and which of those are ON by default;
//   * the packaged files it uses (a seed soul, and — later slices — skill,
//     prompt and threshold files), each with an allowed relative path and kind.
//
// A position is DATA, not code and not a trust root. The role is still the
// ceiling (role-loader/tool-allowlist): the host ratifies the position at hire
// and freezes the granted tool/capability sets into host-controlled state
// (host-grant.ts); the effective-config resolver (effective-config.ts) then
// compares the instance's requests against that frozen grant on every boot.
//
// Slice 1 loads only positions shipped under bob's own packaged `positions/`
// directory. A `path:` spelling is accepted only when its resolved target stays
// inside that directory. Arbitrary `path:`/`npm:`/`git:` sources are a later
// slice with its own security review.
//
// The position HASH covers the manifest and the path + contents of every
// packaged file the resolver uses, so a host grant can pin the exact artifact.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Same path-safety class as loadRole: a position name becomes a path segment.
const POSITION_NAME = /^[a-z0-9-]+$/;

const __dirname = dirname(fileURLToPath(import.meta.url));

// Positions ship at <repo>/positions/<name>/ in a checkout AND at
// node_modules/@tpsdev-ai/bob/positions/<name>/ after npm install (package.json
// `files` includes "positions"). This module sits two levels below the package
// root in both shapes (src/shell/… or dist/shell/…), so one path covers both.
export const DEFAULT_POSITIONS_ROOT = join(__dirname, "..", "..", "positions");

// The kinds a packaged position file may be. `schema-soul` is not a thing: the
// soul is a persona, not a threshold. `threshold` files must name an implemented
// consumer (see IMPLEMENTED_THRESHOLD_CONSUMERS).
export type PositionFileKind = "soul" | "skill" | "prompt" | "threshold";
const FILE_KINDS: readonly PositionFileKind[] = ["soul", "skill", "prompt", "threshold"];

// A threshold file names a schema and a runtime consumer. A threshold with no
// implemented consumer is refused (a number nothing reads is a claim, not a
// control).
export const IMPLEMENTED_THRESHOLD_CONSUMERS: readonly string[] = ["context_compaction"];

export interface PositionFileSpec {
  path: string;
  kind: PositionFileKind;
}

export interface PositionSecretRequirement {
  // A capability that, while enabled, needs these secret names bound in host state.
  capability: string;
  // Secret names only — never a value, never a destination.
  names: string[];
}

export interface PositionThresholdSpec {
  name: string;
  schema: string;
  consumer: string;
}

export interface PositionManifest {
  name: string;
  version: string;
  // The existing role whose ceiling must cover `tools`.
  role: string;
  // Tools the position requests. Must be a subset of the role ceiling.
  tools: string[];
  capabilities: {
    // Every capability the position may ever enable.
    permitted: string[];
    // The subset materialized (enabled) by default at hire.
    default: string[];
  };
  // Packaged files, each an allowed relative path + kind.
  files: PositionFileSpec[];
  // Secret requirements per capability (names only).
  secrets?: PositionSecretRequirement[];
  // Threshold files, each naming an implemented consumer.
  thresholds?: PositionThresholdSpec[];
}

export interface LoadedPosition {
  manifest: PositionManifest;
  // Absolute directory the position was loaded from.
  dir: string;
  // The hash that a host grant pins: manifest + every packaged file's path and
  // contents.
  hash: string;
}

const MANIFEST_KEYS = [
  "name",
  "version",
  "role",
  "tools",
  "capabilities",
  "files",
  "secrets",
  "thresholds",
] as const;

function fail(detail: string): never {
  throw new Error(`position: ${detail}`);
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    fail(`${where} must be a list of non-empty strings.`);
  }
  return value.map((v) => (v as string).trim());
}

// Validate a manifest object parsed from position.json. Strict on the shape the
// resolver depends on; an unknown top-level key is refused rather than ignored
// (a typo'd key must not read as "no such request").
export function validateManifest(raw: unknown, source: string): PositionManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${source} must be a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(MANIFEST_KEYS as readonly string[]).includes(key)) {
      fail(
        `${source} has an unsupported key "${key}". Supported keys: ${MANIFEST_KEYS.join(", ")}.`,
      );
    }
  }
  const name = obj.name;
  const version = obj.version;
  const role = obj.role;
  if (typeof name !== "string" || !POSITION_NAME.test(name)) {
    fail(`${source}: "name" must match ${POSITION_NAME}.`);
  }
  if (typeof version !== "string" || version.trim() === "") {
    fail(`${source}: "version" is required.`);
  }
  if (typeof role !== "string" || !POSITION_NAME.test(role)) {
    fail(`${source}: "role" must be an existing role name.`);
  }
  const tools = asStringArray(obj.tools ?? [], `${source}: "tools"`);
  const caps = obj.capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    fail(`${source}: "capabilities" must be an object with permitted/default.`);
  }
  const capObj = caps as Record<string, unknown>;
  for (const k of Object.keys(capObj)) {
    if (k !== "permitted" && k !== "default") {
      fail(`${source}: capabilities has an unsupported key "${k}" (permitted/default).`);
    }
  }
  const permitted = asStringArray(capObj.permitted ?? [], `${source}: capabilities.permitted`);
  const defaults = asStringArray(capObj.default ?? [], `${source}: capabilities.default`);
  for (const c of defaults) {
    if (!permitted.includes(c)) {
      fail(`${source}: capability "${c}" is on by default but not permitted.`);
    }
  }
  const filesRaw = obj.files ?? [];
  if (!Array.isArray(filesRaw)) fail(`${source}: "files" must be a list.`);
  const files: PositionFileSpec[] = filesRaw.map((f, i) => {
    if (!f || typeof f !== "object" || Array.isArray(f))
      fail(`${source}: files[${i}] must be an object.`);
    const fo = f as Record<string, unknown>;
    for (const k of Object.keys(fo)) {
      if (k !== "path" && k !== "kind")
        fail(`${source}: files[${i}] has an unsupported key "${k}".`);
    }
    if (typeof fo.path !== "string" || fo.path.trim() === "")
      fail(`${source}: files[${i}].path is required.`);
    assertRelativeSafe(fo.path, `${source}: files[${i}].path`);
    if (typeof fo.kind !== "string" || !FILE_KINDS.includes(fo.kind as PositionFileKind)) {
      fail(`${source}: files[${i}].kind must be one of ${FILE_KINDS.join(", ")}.`);
    }
    return { path: fo.path, kind: fo.kind as PositionFileKind };
  });

  const secretsRaw = obj.secrets ?? [];
  if (!Array.isArray(secretsRaw)) fail(`${source}: "secrets" must be a list.`);
  const secrets: PositionSecretRequirement[] = secretsRaw.map((s, i) => {
    if (!s || typeof s !== "object" || Array.isArray(s))
      fail(`${source}: secrets[${i}] must be an object.`);
    const so = s as Record<string, unknown>;
    for (const k of Object.keys(so)) {
      if (k !== "capability" && k !== "names")
        fail(`${source}: secrets[${i}] has an unsupported key "${k}".`);
    }
    if (typeof so.capability !== "string" || so.capability.trim() === "") {
      fail(`${source}: secrets[${i}].capability is required.`);
    }
    return {
      capability: so.capability,
      names: asStringArray(so.names ?? [], `${source}: secrets[${i}].names`),
    };
  });

  const thrRaw = obj.thresholds ?? [];
  if (!Array.isArray(thrRaw)) fail(`${source}: "thresholds" must be a list.`);
  const thresholds: PositionThresholdSpec[] = thrRaw.map((t, i) => {
    if (!t || typeof t !== "object" || Array.isArray(t))
      fail(`${source}: thresholds[${i}] must be an object.`);
    const to = t as Record<string, unknown>;
    for (const k of Object.keys(to)) {
      if (k !== "name" && k !== "schema" && k !== "consumer") {
        fail(`${source}: thresholds[${i}] has an unsupported key "${k}".`);
      }
    }
    for (const k of ["name", "schema", "consumer"] as const) {
      if (typeof to[k] !== "string" || (to[k] as string).trim() === "") {
        fail(`${source}: thresholds[${i}].${k} is required.`);
      }
    }
    const consumer = to.consumer as string;
    if (!IMPLEMENTED_THRESHOLD_CONSUMERS.includes(consumer)) {
      fail(
        `${source}: threshold "${to.name}" names consumer "${consumer}", which no runtime consumer implements.`,
      );
    }
    return { name: to.name as string, schema: to.schema as string, consumer };
  });

  return {
    name,
    version: version.trim(),
    role,
    tools,
    capabilities: { permitted, default: defaults },
    files,
    secrets,
    thresholds,
  };
}

// A packaged file path must be a safe relative path: no absolute, no `..`
// segment, no backslash, no NUL.
export function assertRelativeSafe(rel: string, where: string): void {
  if (isAbsolute(rel)) fail(`${where} must be relative, not absolute.`);
  if (rel.includes("\\") || rel.includes("\0")) fail(`${where} contains a forbidden character.`);
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    fail(`${where} must not contain empty, "." or ".." segments.`);
  }
}

// Read a packaged file for a position, confined to the position directory. The
// path is validated (relative-safe) and then realpath-confined, so a symlink in
// the tree cannot escape.
export function readPositionFile(dir: string, rel: string): string {
  assertRelativeSafe(rel, `position file "${rel}"`);
  const target = join(dir, rel);
  const realDir = realpathSync(dir);
  const realTarget = existsSync(target) ? realpathSync(target) : target;
  const relToDir = relative(realDir, realTarget);
  if (
    relToDir === "" ||
    relToDir === ".." ||
    relToDir.startsWith(`..${sep}`) ||
    isAbsolute(relToDir)
  ) {
    fail(`position file "${rel}" resolves outside the position directory.`);
  }
  if (!existsSync(realTarget)) fail(`position file "${rel}" is missing.`);
  return readFileSync(realTarget, "utf8");
}

// Load and validate a packaged position. `root` is injectable so tests can point
// at a scratch positions directory with a test-only candidate; production uses
// DEFAULT_POSITIONS_ROOT.
export function loadPosition(name: string, opts: { root?: string } = {}): LoadedPosition {
  const root = opts.root ?? DEFAULT_POSITIONS_ROOT;
  if (!POSITION_NAME.test(name))
    fail(`invalid position name ${JSON.stringify(name)} (must match ${POSITION_NAME}).`);
  const dir = join(root, name);
  const manifestPath = join(dir, "position.json");
  if (!existsSync(manifestPath)) {
    fail(`unknown position "${name}". Looked in ${root}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail(`${manifestPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const manifest = validateManifest(parsed, "position.json");
  if (manifest.name !== name) {
    fail(`position.json declares name "${manifest.name}" but was loaded as "${name}".`);
  }
  return { manifest, dir, hash: positionHash(manifest, dir) };
}

// The hash a host grant pins: the manifest plus the path and contents of every
// packaged file it uses, in manifest order.
export function positionHash(manifest: PositionManifest, dir: string): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(manifest));
  for (const f of manifest.files) {
    h.update(`\0${f.path}\0${f.kind}\0`);
    h.update(readPositionFile(dir, f.path));
  }
  return h.digest("hex");
}
