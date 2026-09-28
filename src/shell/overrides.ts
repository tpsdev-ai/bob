// The local override layer (bob#195, slice 1): a per-agent directory that may
// only SUBTRACT, plus a local Git repository for review/rollback.
//
// `overrides/` holds exactly two things:
//   * named, schema-checked disable lists for tools and capabilities;
//   * allow-listed skill, prompt and threshold files, each replacing a packaged
//     position file at the same relative path. The SOUL is not overridable — a
//     local file may never replace the persona the position ships.
//
// Every other policy key is refused BY NAME. There is no key that can enable a
// tool, widen a ceiling, switch on a capability, pick a provider, name a secret
// or a destination — a disable list only ever removes from the already ratified
// set.
//
// The override repository is Git, initialized with a base commit at hire /
// adoption, so later review tooling (a later slice) has native branch review and
// rollback. The baseline for `bob position diff` is the host-ratified snapshot
// (host-grant.ts), not a Git ref.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertRelativeSafe, type LoadedPosition, readPositionFile } from "./positions.js";

export interface Overrides {
  disable: {
    tools: string[];
    capabilities: string[];
  };
  // Relative paths of override files present in the tree (validated later
  // against the manifest allow-list).
  files: string[];
}

export const EMPTY_OVERRIDES: Overrides = { disable: { tools: [], capabilities: [] }, files: [] };

export function overridesDir(agentDir: string): string {
  return join(agentDir, "overrides");
}

const OVERRIDE_KEYS = ["disable", "files"] as const;
const DISABLE_KEYS = ["tools", "capabilities"] as const;

function refuse(detail: string): never {
  throw new Error(`bob: refusing this override — ${detail}`);
}

function toStringList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    refuse(`${where} must be a list of non-empty names.`);
  }
  return (value as string[]).map((v) => v.trim());
}

// Validate the parsed overrides document. Any key that is not an allowed,
// subtractive key is refused BY NAME — an `enable:` key, a top-level `tools:`
// key, a `provider:` key and so on all fail here rather than taking effect.
export function validateOverrides(raw: unknown, source: string): Overrides {
  if (raw === undefined || raw === null) return EMPTY_OVERRIDES;
  if (typeof raw !== "object" || Array.isArray(raw)) refuse(`${source} must be a JSON object.`);
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) {
      refuse(
        `"${source}" carries the key "${key}", which is not an override key. An override may only DISABLE tool or capability names (under "disable:") and list allow-listed files (under "files:"). Every other policy key — enabling, widening, providers, secrets, comms — is not writable here.`,
      );
    }
  }
  const disableRaw = obj.disable ?? {};
  if (!disableRaw || typeof disableRaw !== "object" || Array.isArray(disableRaw)) {
    refuse(`"${source}".disable must be an object with tools/capabilities.`);
  }
  const disableObj = disableRaw as Record<string, unknown>;
  for (const key of Object.keys(disableObj)) {
    if (!(DISABLE_KEYS as readonly string[]).includes(key)) {
      refuse(
        `"${source}".disable carries the key "${key}", which is not a disable list (tools, capabilities).`,
      );
    }
  }
  const filesRaw = obj.files ?? [];
  if (!Array.isArray(filesRaw)) refuse(`"${source}".files must be a list.`);
  const files = filesRaw.map((f, i) => {
    if (!f || typeof f !== "object" || Array.isArray(f))
      refuse(`"${source}".files[${i}] must be an object.`);
    const fo = f as Record<string, unknown>;
    for (const k of Object.keys(fo)) {
      if (k !== "path")
        refuse(`"${source}".files[${i}] has an unsupported key "${k}" (path only).`);
    }
    if (typeof fo.path !== "string" || fo.path.trim() === "")
      refuse(`"${source}".files[${i}].path is required.`);
    assertRelativeSafe(fo.path, `overrides files[${i}].path`);
    return fo.path;
  });
  return {
    disable: {
      tools: toStringList(disableObj.tools, `${source}.disable.tools`),
      capabilities: toStringList(disableObj.capabilities, `${source}.disable.capabilities`),
    },
    files,
  };
}

// Load the override layer for an agent. Returns undefined when there is no
// overrides directory (a plain `bob init` agent, or an agent hired before this
// slice). Throws (refusing boot) when the document is unreadable or carries an
// unsupported key.
export function loadOverrides(agentDir: string): Overrides | undefined {
  const dir = overridesDir(agentDir);
  const docPath = join(dir, "overrides.json");
  let raw: string;
  try {
    raw = readFileSync(docPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    refuse(`${docPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  const overrides = validateOverrides(parsed, "overrides.json");
  // Collect override files present in the tree.
  const filesDir = join(dir, "files");
  const present: string[] = [];
  try {
    collectFiles(filesDir, "", present);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  overrides.files = present;
  return overrides;
}

function collectFiles(baseDir: string, prefix: string, out: string[]): void {
  // Shallow recursion via readdirSync; avoids a dependency.
  const entries = readdirEntries(baseDir);
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) collectFiles(join(baseDir, entry.name), rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

function readdirEntries(
  dir: string,
): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> {
  return readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
}

// Resolve a position's packaged files against the override layer. For each
// manifest file: an override file at the same relative path replaces it;
// otherwise the packaged file is used. Override files that no manifest entry
// allow-lists are REFUSED. Returns { rel -> content } plus the source of each.
export function resolvePositionFiles(
  position: LoadedPosition,
  agentDir: string,
): { files: Record<string, string>; sources: Record<string, "position" | "override"> } {
  const overrides = loadOverrides(agentDir);
  const allowed = new Map(position.manifest.files.map((f) => [f.path, f.kind]));
  const files: Record<string, string> = {};
  const sources: Record<string, "position" | "override"> = {};

  for (const f of position.manifest.files) {
    const overridePath = join(overridesDir(agentDir), "files", f.path);
    let overrideContent: string | undefined;
    try {
      overrideContent = readFileSync(overridePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    if (overrideContent !== undefined) {
      // The soul is the persona: a local override may replace a skill, prompt
      // or threshold file, but never the soul. Slice 1 ships soul-only
      // positions, so in practice every present override file is refused here.
      if (f.kind === "soul") {
        refuse(
          `override file "${f.path}" replaces the position's soul, which is not an overridable kind. A local override may replace a skill, prompt or threshold file at the same relative path — never the persona.`,
        );
      }
      files[f.path] = overrideContent;
      sources[f.path] = "override";
    } else {
      files[f.path] = readPositionFile(position.dir, f.path);
      sources[f.path] = "position";
    }
  }

  if (overrides) {
    for (const rel of overrides.files) {
      if (!allowed.has(rel)) {
        refuse(
          `override file "${rel}" is not allow-listed by the "${position.manifest.name}" position. A local file may only replace a packaged file at the same path.`,
        );
      }
    }
  }
  return { files, sources };
}

// Initialize the local override repository: the directory, an empty override
// document, and a Git repo with a base commit.
export function initOverrideRepo(agentDir: string): string {
  const dir = overridesDir(agentDir);
  mkdirSync(join(dir, "files"), { recursive: true, mode: 0o700 });
  const docPath = join(dir, "overrides.json");
  // `wx`: never clobber an existing document, and no existsSync-then-write
  // window (CodeQL js/file-system-race). An existing document is left as-is.
  try {
    writeFileSync(
      docPath,
      `${JSON.stringify({ disable: { tools: [], capabilities: [] }, files: [] }, null, 2)}\n`,
      { flag: "wx" },
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
  if (!existsSync(join(dir, ".git"))) {
    git(["init", "--quiet"], dir);
    git(["add", "-A"], dir);
    git(
      [
        "-c",
        "user.email=bob@tps.dev",
        "-c",
        "user.name=bob",
        "commit",
        "--quiet",
        "-m",
        "override baseline",
      ],
      dir,
    );
  }
  return dir;
}

function git(args: string[], cwd: string): void {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  } catch (err) {
    throw new Error(
      `bob: could not initialize the override repository at ${cwd} (git ${args[0]} failed: ${err instanceof Error ? err.message : String(err)}). Git is required for the local override layer.`,
    );
  }
}
