// Publication ledger for bind rollback (bob#326).
// Removal requires recorded identity to match when checked; a swap
// before unlink/rmdir can still remove a replacement or traverse a symlink.
// Created directories are recorded before reading their identity; an unresolved
// identity is retained. Git entries that cannot be read are not recorded.
// Roots are renamed to quarantine and checked again before sweeping.
// Move-back is attempted; errors and potentially retained quarantine names are
// reported. A directory placeholder replaced before rename can be overwritten.
// Leftovers are named when checked; arrivals after listing are not named.
// A writer holding a descriptor or discovering the quarantine can change it,
// including linking the original path to it. Path operations are not anchored
// to directory descriptors.

import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export type PublishedKind = "dir" | "file";

// A published entry; a created directory may still have an unresolved identity.
export interface PublishedEntry {
  path: string;
  dev?: bigint;
  ino?: bigint;
  unresolved?: string;
  kind: PublishedKind;
}

export type OnPublished = (entry: PublishedEntry) => void;

// Rollback accounting; leftover paths are relative to the caller's report
// directory ("." is that directory itself).
export interface RollbackReport {
  leftovers: string[];
  // Quarantine names potentially retained, with their original paths.
  stranded: Array<{ quarantine: string; original: string; leftovers: string[] }>;
  // Observed cleanup errors, with paths.
  errors: string[];
}

export const QUARANTINE_PREFIX = ".bob-rollback-";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const EXCLUSIVE_CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;

// The kind lstat reports. A symlink (and anything that is neither a regular file
// nor a directory) is "other", so it never matches a recorded entry.
function kindOf(st: BigIntStats): PublishedKind | "other" {
  if (st.isSymbolicLink()) return "other";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

function isRecorded(st: BigIntStats, e: PublishedEntry): boolean {
  return (
    e.unresolved === undefined && st.dev === e.dev && st.ino === e.ino && kindOf(st) === e.kind
  );
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// lstat (never following the last component); undefined only for ENOENT.
function lstatIfPresent(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (err) {
    if (code(err) === "ENOENT") return undefined;
    throw err;
  }
}

// Record a successful mkdir before reading its identity. The callback receives
// the entry object, which is updated after that read.
export function mkdirOwned(
  path: string,
  onPublished?: OnPublished,
  mode?: number,
): PublishedEntry | undefined {
  try {
    mkdirSync(path, mode === undefined ? undefined : { mode });
  } catch (err) {
    if (code(err) === "EEXIST") return undefined;
    throw err;
  }
  const entry: PublishedEntry = { path, kind: "dir", unresolved: "directory identity not read" };
  onPublished?.(entry);
  try {
    const st = lstatSync(path, { bigint: true });
    if (kindOf(st) !== "dir") {
      entry.unresolved = "created path was not a directory when checked";
      return undefined;
    }
    entry.dev = st.dev;
    entry.ino = st.ino;
    delete entry.unresolved;
    return entry;
  } catch (err) {
    entry.unresolved = `directory identity read failed: ${message(err)}`;
    throw err;
  }
}

// Create exclusively, then record descriptor identity and return the descriptor.
export function openOwned(path: string, mode: number, onPublished?: OnPublished): number {
  const fd = openSync(path, EXCLUSIVE_CREATE, mode);
  try {
    const st = fstatSync(fd, { bigint: true });
    onPublished?.({ path, dev: st.dev, ino: st.ino, kind: "file" });
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
}

// Record readable regular files and directories under the created Git root.
// Filesystem read failures are suppressed; onPublished may throw. Directory
// checks can race with traversal, including a symlink substitution.
export function recordTree(root: PublishedEntry, onPublished: OnPublished): void {
  const lstatOrSkip = (path: string): BigIntStats | undefined => {
    try {
      return lstatIfPresent(path);
    } catch {
      return undefined;
    }
  };
  const st = lstatOrSkip(root.path);
  if (st === undefined || !isRecorded(st, root)) return;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const child = lstatOrSkip(path);
      if (child === undefined) continue;
      const kind = kindOf(child);
      if (kind === "other") continue;
      onPublished({ path, dev: child.dev, ino: child.ino, kind });
      if (kind === "dir") walk(path);
    }
  };
  walk(root.path);
}

// Remove the recorded entries, one root at a time (see the header). `base` is
// the directory, trusted by path, that holds each root; `reportBase` is what
// leftover paths are named relative to.
export function rollbackPublished(input: {
  base: string;
  reportBase: string;
  entries: readonly PublishedEntry[];
}): RollbackReport {
  const report: RollbackReport = { leftovers: [], stranded: [], errors: [] };
  const byPath = new Map<string, PublishedEntry>();
  for (const e of input.entries) byPath.set(e.path, e);
  const roots = [...byPath.values()].filter((e) => dirname(e.path) === input.base);
  const name = (path: string): string => relative(input.reportBase, path) || ".";

  for (const root of roots) {
    try {
      rollbackRoot(root, byPath, name, report);
    } catch (err) {
      report.errors.push(`${root.path}: ${message(err)}`);
      report.leftovers.push(name(root.path));
    }
  }

  // A recorded entry under no root (its parent is neither the base nor a
  // recorded directory: an entry published inside a directory that was not
  // ours) is not touched; it is named if present when checked.
  const underRoot = (path: string) =>
    roots.some((r) => path === r.path || path.startsWith(r.path + sep));
  for (const e of byPath.values()) {
    if (underRoot(e.path) || byPath.has(dirname(e.path))) continue;
    try {
      if (lstatIfPresent(e.path) !== undefined) report.leftovers.push(name(e.path));
    } catch {
      report.leftovers.push(name(e.path));
    }
  }
  report.leftovers = [...new Set(report.leftovers)].sort();
  return report;
}

function rollbackRoot(
  root: PublishedEntry,
  byPath: ReadonlyMap<string, PublishedEntry>,
  name: (path: string) => string,
  report: RollbackReport,
): void {
  if (root.unresolved !== undefined) {
    report.leftovers.push(name(root.path));
    report.errors.push(`${root.path}: retained: ${root.unresolved}`);
    return;
  }
  // ROOT: check identity before moving; check again after rename.
  const st = lstatIfPresent(root.path);
  if (st === undefined) return;
  if (!isRecorded(st, root)) {
    report.leftovers.push(name(root.path));
    return;
  }

  // QUARANTINE: move the root out of its path, then check what moved.
  const quarantine = join(dirname(root.path), `${QUARANTINE_PREFIX}${randomUUID()}`);
  renameSync(root.path, quarantine);
  let moved: BigIntStats | undefined;
  try {
    moved = lstatIfPresent(quarantine);
  } catch (err) {
    report.errors.push(`${quarantine}: ${message(err)}`);
    report.stranded.push({ quarantine, original: root.path, leftovers: ["."] });
    return;
  }
  if (moved === undefined || !isRecorded(moved, root)) {
    if (moved !== undefined) settle(quarantine, root.path, moved, [], name, report);
    else report.leftovers.push(name(root.path));
    return;
  }
  if (root.kind === "file") {
    try {
      unlinkSync(quarantine);
    } catch (err) {
      report.errors.push(`${root.path}: ${message(err)}`);
      settle(quarantine, root.path, moved, [], name, report);
    }
    return;
  }

  // SWEEP: the recorded entries inside the root, deepest first.
  sweep(quarantine, root, byPath, name, report);

  // FINISH: an empty quarantine is removed; otherwise its leftovers are
  // enumerated after the sweep and move-back is attempted.
  try {
    rmdirSync(quarantine);
    return;
  } catch (err) {
    const c = code(err);
    if (c !== "ENOTEMPTY" && c !== "EEXIST") report.errors.push(`${root.path}: ${message(err)}`);
  }
  let left = leftoversIn(quarantine, root, byPath, report);
  if (left.length === 0) {
    // What made the rmdir fail is gone again: one more try.
    try {
      rmdirSync(quarantine);
      return;
    } catch (err) {
      report.errors.push(`${quarantine}: ${message(err)}`);
      left = ["."];
    }
  }
  settle(quarantine, root.path, moved, left, name, report);
}

// Sweep deepest first after checking the entry and recorded ancestors.
// A substitution between these checks and removal can affect a replacement.
function sweep(
  quarantine: string,
  root: PublishedEntry,
  byPath: ReadonlyMap<string, PublishedEntry>,
  name: (path: string) => string,
  report: RollbackReport,
): void {
  const prefix = root.path + sep;
  const depth = (rel: string) => rel.split(sep).length;
  const inside = [...byPath.values()]
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ e, rel: e.path.slice(prefix.length) }))
    .sort((a, b) => depth(b.rel) - depth(a.rel) || (a.rel < b.rel ? 1 : a.rel > b.rel ? -1 : 0));
  for (const { e, rel } of inside) {
    try {
      if (!ancestorsVerified(quarantine, root, rel, byPath)) continue;
      const at = join(quarantine, rel);
      const st = lstatIfPresent(at);
      if (st === undefined || !isRecorded(st, e)) continue;
      if (e.kind === "dir") {
        try {
          rmdirSync(at);
        } catch (err) {
          const c = code(err);
          // Not empty: what is inside it is named when the leftovers are listed.
          if (c !== "ENOTEMPTY" && c !== "EEXIST") throw err;
        }
      } else {
        unlinkSync(at);
      }
    } catch (err) {
      if (code(err) !== "ENOENT") report.errors.push(`${name(e.path)}: ${message(err)}`);
    }
  }
}

// Check recorded ancestors from the top down; a later swap can affect traversal.
function ancestorsVerified(
  quarantine: string,
  root: PublishedEntry,
  rel: string,
  byPath: ReadonlyMap<string, PublishedEntry>,
): boolean {
  const parts = rel.split(sep);
  for (let i = 1; i < parts.length; i++) {
    const sub = parts.slice(0, i).join(sep);
    const record = byPath.get(join(root.path, sub));
    if (record === undefined || record.kind !== "dir") return false;
    const st = lstatIfPresent(join(quarantine, sub));
    if (st === undefined || !isRecorded(st, record)) return false;
  }
  return true;
}

// List leftovers through directories whose identity matches when checked;
// substitution before readdir can affect traversal, and later arrivals are missed.
function leftoversIn(
  quarantine: string,
  root: PublishedEntry,
  byPath: ReadonlyMap<string, PublishedEntry>,
  report: RollbackReport,
): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch (err) {
      report.errors.push(`${join(root.path, rel)}: ${message(err)}`);
      out.push(rel === "" ? "." : rel);
      return;
    }
    for (const entryName of names.sort()) {
      const childRel = rel === "" ? entryName : join(rel, entryName);
      const childAt = join(at, entryName);
      let st: BigIntStats | undefined;
      try {
        st = lstatIfPresent(childAt);
      } catch (err) {
        report.errors.push(`${childAt}: ${message(err)}`);
        out.push(childRel);
        continue;
      }
      if (st === undefined) continue;
      const record = byPath.get(join(root.path, childRel));
      if (record !== undefined && record.kind === "dir" && isRecorded(st, record)) {
        const before = out.length;
        walk(childAt, childRel);
        if (out.length === before) out.push(childRel);
      } else {
        out.push(childRel);
      }
    }
  };
  walk(quarantine, "");
  return out;
}

// Attempt move-back and report the observed locations and errors.
function settle(
  quarantine: string,
  original: string,
  st: BigIntStats,
  left: string[],
  name: (path: string) => string,
  report: RollbackReport,
): void {
  const result = moveBack(quarantine, original, st, report);
  if (result.restored) {
    if (left.length === 0 || (left.length === 1 && left[0] === ".")) {
      report.leftovers.push(name(original));
    } else {
      for (const rel of left) report.leftovers.push(name(join(original, rel)));
    }
  }
  if (result.quarantineRemains) {
    report.stranded.push({ quarantine, original, leftovers: left.length > 0 ? left : ["."] });
  }
}

// mkdir/link refuse an occupied original path when checked. A directory
// placeholder replaced before rename can still be overwritten.
function moveBack(
  quarantine: string,
  original: string,
  st: BigIntStats,
  report: RollbackReport,
): { restored: boolean; quarantineRemains: boolean } {
  const failed = (err: unknown) => {
    report.errors.push(`${quarantine} -> ${original}: ${message(err)}`);
    return { restored: false, quarantineRemains: true };
  };
  if (st.isDirectory()) {
    let placeholder: PublishedEntry | undefined;
    try {
      placeholder = mkdirOwned(original);
    } catch (err) {
      return failed(err);
    }
    if (placeholder === undefined) {
      return failed(new Error("original path occupied or placeholder identity unresolved"));
    }
    try {
      renameSync(quarantine, original);
      return { restored: true, quarantineRemains: false };
    } catch (err) {
      removeEmptyPlaceholder(original, placeholder, report);
      return failed(err);
    }
  }
  try {
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(quarantine), original);
    else linkNoReplace(quarantine, original);
  } catch (err) {
    return failed(err);
  }
  try {
    unlinkSync(quarantine);
    return { restored: true, quarantineRemains: false };
  } catch (err) {
    report.errors.push(`${quarantine}: ${message(err)}`);
    return { restored: true, quarantineRemains: true };
  }
}

function linkNoReplace(from: string, to: string): void {
  linkSync(from, to);
}

function removeEmptyPlaceholder(
  path: string,
  placeholder: PublishedEntry,
  report: RollbackReport,
): void {
  try {
    const st = lstatIfPresent(path);
    if (st !== undefined && isRecorded(st, placeholder)) rmdirSync(path);
  } catch (err) {
    report.errors.push(`${path}: ${message(err)}`);
  }
}
