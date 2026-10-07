// Publication ledger for bind rollback (bob#326).
// Removal requires recorded identity to match when checked; a swap
// before unlink/rmdir can still remove a replacement or traverse a symlink.
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

export type PublishedKind = "dir" | "file" | "symlink";

export interface PublishedEntry {
  path: string;
  dev?: bigint;
  ino?: bigint;
  unresolved?: string;
  kind: PublishedKind;
  created?: false;
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
  publications?: PublishedEntry[];
}

export const QUARANTINE_PREFIX = ".bob-rollback-";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const EXCLUSIVE_CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;

function kindOf(st: BigIntStats): PublishedKind | "other" {
  if (st.isSymbolicLink()) return "symlink";
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

export function mkdirOwned(
  path: string,
  onPublished?: OnPublished,
  mode?: number,
): PublishedEntry | undefined {
  try {
    mkdirSync(path, mode === undefined ? undefined : { mode });
  } catch (err) {
    if (code(err) === "EEXIST") {
      const st = lstatSync(path, { bigint: true });
      if (kindOf(st) !== "dir") throw new Error(`${path}: expected a directory`);
      onPublished?.({ path, dev: st.dev, ino: st.ino, kind: "dir", created: false });
      return undefined;
    }
    throw err;
  }
  const entry = pendingEntry(path, "dir", onPublished);
  try {
    const st = lstatSync(path, { bigint: true });
    if (kindOf(st) !== "dir") {
      entry.unresolved = "created path was not a directory when checked";
      throw new Error(`${path}: ${entry.unresolved}`);
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

export function mkdirParentsOwned(path: string, onPublished?: OnPublished): void {
  try {
    const st = lstatSync(path, { bigint: true });
    if (kindOf(st) !== "dir") throw new Error(`${path}: expected a directory`);
    onPublished?.({ path, dev: st.dev, ino: st.ino, kind: "dir", created: false });
    return;
  } catch (err) {
    if (code(err) !== "ENOENT") throw err;
  }
  const parent = dirname(path);
  if (parent === path) throw new Error(`${path}: directory root missing`);
  mkdirParentsOwned(parent, onPublished);
  mkdirOwned(path, onPublished);
}

export function pendingEntry(
  path: string,
  kind: PublishedKind,
  onPublished?: OnPublished,
): PublishedEntry {
  const entry: PublishedEntry = { path, kind, unresolved: "identity not read" };
  onPublished?.(entry);
  return entry;
}

export function openOwned(path: string, mode: number, onPublished?: OnPublished): number {
  const fd = openSync(path, EXCLUSIVE_CREATE, mode);
  let entry: PublishedEntry | undefined;
  try {
    entry = pendingEntry(path, "file", onPublished);
    const st = fstatSync(fd, { bigint: true });
    entry.dev = st.dev;
    entry.ino = st.ino;
    delete entry.unresolved;
  } catch (err) {
    if (entry !== undefined) entry.unresolved = `file identity read failed: ${message(err)}`;
    closeSync(fd);
    throw err;
  }
  return fd;
}

export function rollbackPublished(input: {
  base: string;
  reportBase: string;
  entries: readonly PublishedEntry[];
}): RollbackReport {
  const report: RollbackReport = { leftovers: [], stranded: [], errors: [] };
  const byPath = new Map<string, PublishedEntry>();
  for (const e of input.entries) {
    if (e.created === false && byPath.get(e.path)?.created !== false && byPath.has(e.path))
      continue;
    byPath.set(e.path, e);
  }
  const creations = [...byPath.values()].filter((e) => e.created !== false);
  const roots = creations.filter(
    (e) =>
      !creations.some(
        (ancestor) => ancestor.kind === "dir" && e.path.startsWith(ancestor.path + sep),
      ),
  );
  const name = (path: string): string => relative(input.reportBase, path) || ".";
  for (const entry of creations) {
    if (entry.unresolved !== undefined) {
      report.leftovers.push(name(entry.path));
      report.errors.push(`${entry.path}: retained: ${entry.unresolved}`);
    }
  }

  for (const root of roots) {
    try {
      const anchor =
        root.path === input.base || input.base.startsWith(root.path + sep)
          ? dirname(root.path)
          : input.base;
      if (
        !ancestorsVerified(
          anchor,
          byPath.get(anchor) ?? { path: anchor, kind: "dir" },
          relative(anchor, root.path),
          byPath,
        )
      ) {
        for (const e of creations) {
          if (e.path === root.path || e.path.startsWith(root.path + sep))
            report.leftovers.push(name(e.path));
        }
        continue;
      }
      rollbackRoot(root, byPath, name, report);
    } catch (err) {
      report.errors.push(`${root.path}: ${message(err)}`);
      report.leftovers.push(name(root.path));
    }
  }

  for (const entry of report.publications ?? []) {
    if (entry.unresolved !== undefined) {
      report.leftovers.push(name(entry.path));
      report.errors.push(`${entry.path}: retained: ${entry.unresolved}`);
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
    for (const e of byPath.values()) {
      if (e.created !== false && (e.path === root.path || e.path.startsWith(root.path + sep))) {
        report.leftovers.push(name(e.path));
      }
    }
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
  const quarantined = pendingEntry(quarantine, root.kind, (entry) => {
    report.publications ??= [];
    report.publications.push(entry);
  });
  let moved: BigIntStats | undefined;
  try {
    moved = lstatIfPresent(quarantine);
  } catch (err) {
    report.errors.push(`${quarantine}: ${message(err)}`);
    report.stranded.push({ quarantine, original: root.path, leftovers: ["."] });
    return;
  }
  if (moved !== undefined) {
    const kind = kindOf(moved);
    if (kind !== "other") {
      quarantined.kind = kind;
      quarantined.dev = moved.dev;
      quarantined.ino = moved.ino;
      delete quarantined.unresolved;
    }
  }
  if (moved === undefined || !isRecorded(moved, root)) {
    if (moved !== undefined) settle(quarantine, root.path, moved, [], name, report);
    else report.leftovers.push(name(root.path));
    return;
  }
  if (root.kind !== "dir") {
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
      if (e.unresolved !== undefined) continue;
      if (e.created === false) continue;
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
  const top = lstatIfPresent(quarantine);
  if (top === undefined || kindOf(top) !== "dir") return false;
  if (root.dev !== undefined && !isRecorded(top, root)) return false;
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
      mkdirOwned(original, (entry) => {
        placeholder = entry;
        report.publications ??= [];
        report.publications.push(entry);
      });
    } catch (err) {
      return failed(err);
    }
    if (
      placeholder === undefined ||
      placeholder.created === false ||
      placeholder.unresolved !== undefined
    ) {
      return failed(new Error("original path occupied or placeholder identity unresolved"));
    }
    try {
      renameSync(quarantine, original);
      const restored = pendingEntry(original, "dir", (entry) => {
        report.publications ??= [];
        report.publications.push(entry);
      });
      restored.dev = st.dev;
      restored.ino = st.ino;
      delete restored.unresolved;
      return { restored: true, quarantineRemains: false };
    } catch (err) {
      removeEmptyPlaceholder(original, placeholder, report);
      return failed(err);
    }
  }
  let restored: PublishedEntry | undefined;
  try {
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(quarantine), original);
    else linkNoReplace(quarantine, original);
    restored = pendingEntry(original, st.isSymbolicLink() ? "symlink" : "file", (entry) => {
      report.publications ??= [];
      report.publications.push(entry);
    });
    const identity = st.isSymbolicLink() ? lstatSync(original, { bigint: true }) : st;
    if (kindOf(identity) !== restored.kind) throw new Error("restored entry kind changed");
    restored.dev = identity.dev;
    restored.ino = identity.ino;
    delete restored.unresolved;
  } catch (err) {
    if (restored !== undefined)
      restored.unresolved = `restored identity read failed: ${message(err)}`;
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
