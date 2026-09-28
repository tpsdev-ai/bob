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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { assertRelativeSafe, type LoadedPosition, readPositionFile } from "./positions.js";

export interface Overrides {
  disable: {
    tools: string[];
    capabilities: string[];
  };
  // The override paths DECLARED in overrides.json (`files:`). Validated against
  // the manifest allow-list at resolution — even when no file is present.
  files: string[];
  // The override files PRESENT under `overrides/files/` (a directory scan,
  // symlink entries included). Validated against the manifest allow-list TOO.
  // The declaration and the tree are checked INDEPENDENTLY and must also AGREE:
  // neither a declared path the tree lacks nor an undeclared file (or symlink)
  // the tree carries can slip through.
  present: string[];
}

export const EMPTY_OVERRIDES: Overrides = {
  disable: { tools: [], capabilities: [] },
  files: [],
  present: [],
};

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
    present: [],
  };
}

// Load the override layer for an agent. Returns undefined only when there is NO
// override layer at all (neither the document nor the files directory exists — a
// plain `bob init` agent, or an agent hired before this slice). Throws (refusing
// boot) when the document is unreadable or carries an unsupported key.
//
// The DECLARED list and the files PRESENT are kept SEPARATE. A missing document
// is an empty declaration, not "no override layer": the tree is still scanned and
// checked, so a file dropped under `overrides/files/` with no declaration is
// still refused by resolvePositionFiles.
export function loadOverrides(agentDir: string): Overrides | undefined {
  const dir = overridesDir(agentDir);
  const docPath = join(dir, "overrides.json");
  let declared: string[] = [];
  let disable: Overrides["disable"] = { tools: [], capabilities: [] };
  let raw: string | undefined;
  let docPresent = false;
  try {
    raw = readFileSync(docPath, "utf8");
    docPresent = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  if (docPresent) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw as string);
    } catch (err) {
      refuse(`${docPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
    }
    const validated = validateOverrides(parsed, "overrides.json");
    declared = validated.files;
    disable = validated.disable;
  }
  // Collect override files present in the tree.
  const filesDir = join(dir, "files");
  const present: string[] = [];
  let filesDirPresent = false;
  try {
    collectFiles(filesDir, "", present);
    filesDirPresent = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  if (!docPresent && !filesDirPresent) return undefined;
  return { disable, files: declared, present };
}

function collectFiles(baseDir: string, prefix: string, out: string[]): void {
  // Shallow recursion via readdirSync; avoids a dependency.
  const entries = readdirEntries(baseDir);
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      collectFiles(join(baseDir, entry.name), rel, out);
      continue;
    }
    // A regular file OR a SYMLINK entry is recorded so it is checked against the
    // manifest allow-list. A symlink's TARGET is confined at read time
    // (readConfinedOverride), but the ENTRY itself must be declared and
    // allow-listed, so an unlisted symlink outside a manifest path cannot slip
    // silently through the present list.
    if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(rel);
      continue;
    }
    // Anything else (a socket, a FIFO, a block/char device, …) reports as
    // neither a file, a directory nor a symlink, so it cannot be compared with
    // the manifest allow-list. Refuse it rather than silently omitting it.
    refuse(
      `override entry "${rel}" is not a regular file, directory or symlink, so it cannot be checked against the manifest's allow-list. Remove it from the override tree (overrides/files/).`,
    );
  }
}

function readdirEntries(dir: string): Array<{
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}> {
  return readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
}

// Read an override file at `rel`, confined to the override files directory by
// REALPATH — the same containment readPositionFile applies to packaged position
// files. A symlink (or a path that resolves) outside the override tree is
// refused rather than followed, so a local override can never make bob read (and
// apply) a file outside the agent's own override tree.
function readConfinedOverride(filesDir: string, rel: string): string | undefined {
  assertRelativeSafe(rel, `override file "${rel}"`);
  let realFilesDir: string;
  try {
    realFilesDir = realpathSync(filesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(join(filesDir, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
  const relToDir = relative(realFilesDir, realTarget);
  if (
    relToDir === "" ||
    relToDir === ".." ||
    relToDir.startsWith(`..${sep}`) ||
    isAbsolute(relToDir)
  ) {
    refuse(
      `override file "${rel}" resolves outside the override directory (a symlink or an escaping path). A local override may only replace a packaged file at the same relative path, inside the agent's overrides/files directory.`,
    );
  }
  return readFileSync(realTarget, "utf8");
}

// Resolve a position's packaged files against the override layer. For each
// manifest file: an override file at the same relative path replaces it;
// otherwise the packaged file is used. BOTH the paths DECLARED in overrides.json
// and the files PRESENT under overrides/files/ are checked against the manifest
// allow-list, and every override read is realpath-confined. Returns
// { rel -> content } plus the source of each.
export function resolvePositionFiles(
  position: LoadedPosition,
  agentDir: string,
): { files: Record<string, string>; sources: Record<string, "position" | "override"> } {
  const overrides = loadOverrides(agentDir);
  const allowed = new Map(position.manifest.files.map((f) => [f.path, f.kind]));
  const files: Record<string, string> = {};
  const sources: Record<string, "position" | "override"> = {};

  if (overrides) {
    // A DECLARED path must be allow-listed by the manifest — even when the tree
    // has no such file. The old code dropped the declaration list entirely, so a
    // declared-but-absent path was invisible.
    for (const rel of overrides.files) {
      if (!allowed.has(rel)) {
        refuse(
          `override file "${rel}" is declared in overrides.json but is not allow-listed by the "${position.manifest.name}" position. A local file may only replace a packaged file at the same path.`,
        );
      }
    }
    // A PRESENT file must be allow-listed too, whether or not a document exists.
    for (const rel of overrides.present) {
      if (!allowed.has(rel)) {
        refuse(
          `override file "${rel}" is present in the override tree but is not allow-listed by the "${position.manifest.name}" position. A local file may only replace a packaged file at the same path.`,
        );
      }
    }
    // ENFORCE AGREEMENT: each list is manifest-allowed above; here the
    // declaration and the tree must also AGREE. A file present but undeclared,
    // or declared but absent, is refused by name — a one-sided edit is not an
    // override.
    const declaredSet = new Set(overrides.files);
    const presentSet = new Set(overrides.present);
    for (const rel of presentSet) {
      if (!declaredSet.has(rel)) {
        refuse(
          `override file "${rel}" is present under overrides/files/ but is not declared in overrides.json. Declare it under "files:" or remove it from the tree — the declaration and the tree must agree.`,
        );
      }
    }
    for (const rel of declaredSet) {
      if (!presentSet.has(rel)) {
        refuse(
          `override file "${rel}" is declared in overrides.json but is not present under overrides/files/. Add the file to the tree or remove its declaration — the declaration and the tree must agree.`,
        );
      }
    }
  }

  for (const f of position.manifest.files) {
    const overrideContent = readConfinedOverride(join(overridesDir(agentDir), "files"), f.path);
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
