// The publication ledger and the rollback that removes only this operation's own
// entries (bob#326).
//
// A bind (hire or adoption) records each directory entry it publishes inside the
// agent directory: the scaffold `bob init` writes, the binding marker and the
// override repository. When the bind fails, the rollback removes a recorded
// entry only while it is still the entry that was recorded (same device, inode
// and kind), and leaves everything else in place, naming it.
//
// RECORDING
//
//   * A FILE is created exclusively (O_CREAT|O_EXCL|O_NOFOLLOW) and its identity
//     is read from that descriptor (fstat) before the file is linked or renamed
//     into place, so a replacement at the destination can never be recorded as
//     ours. The destination is registered the moment its link/rename succeeds,
//     before any fallible cleanup of the temporary name.
//   * A DIRECTORY is recorded only when this run's own non-recursive mkdir
//     created it. EEXIST means the directory is not ours, with or without
//     --force.
//   * The override repository's `.git` directory is created by this run's mkdir;
//     what git then writes inside it is recorded by walking that directory once
//     the git commands have finished (or failed).
//
// ROLLBACK, for each ROOT (a recorded entry directly inside the caller's base
// directory: the agent directory for a hire; the marker and the override
// repository for an adoption):
//
//   ROOT        lstat the root path. Unless it is still the recorded entry (same
//               device, inode and kind; a symlink never matches), nothing is
//               removed and the root is named.
//   QUARANTINE  rename the root to a fresh sibling `.bob-rollback-<uuid>`
//               (atomic), then lstat the quarantine. If what moved is not the
//               recorded entry, it is moved back (only into a free path) and
//               named; nothing is removed. A recorded file root is unlinked
//               from the quarantine.
//   SWEEP       inside the quarantine, deepest first, ONLY the recorded entries,
//               by relative path. An entry is reached only through recorded
//               directories that lstat still verifies, so the sweep never
//               descends through a symlink or a directory that is not ours. A
//               recorded entry that still matches is removed: unlink for a file,
//               rmdir for a directory (which only ever removes an empty one).
//               Anything else stays. There is no recursive removal.
//   FINISH      rmdir the quarantine. If it is not empty, its leftovers are
//               enumerated NOW, after the sweep (so an entry that arrived during
//               the sweep is named too), and the quarantine is moved back to the
//               original path if that path is free. If the path is occupied, the
//               quarantine stays where it is, and its path is reported with its
//               leftovers.
//
// RESIDUAL. Once a root is quarantined, nothing that reaches the agent directory
// by its ORIGINAL path can reach the entries the sweep removes: a writer that
// opens that path finds it free (or its own new entry there). A process that
// already holds a file descriptor or a working directory inside the tree, or
// that finds the quarantine's random name by listing the parent directory, can
// still write into the quarantined tree. It can also swap an entry, or a
// directory above it, between the sweep's lstat and its unlink/rmdir; the
// unlink/rmdir then acts on whatever is at that path (through a swapped-in
// symlink, the same-named entry in the link's target directory), though rmdir
// only ever removes an empty directory. Node has no openat/unlinkat/renameat,
// so the sweep cannot be anchored to a directory descriptor.
//
// The other check-then-use windows, by step:
//   * a directory's identity is read by lstat right after its mkdir, and git's
//     entries are read after git exits: an entry substituted in either interval
//     is attributed to this run. The sweep would remove such an entry only if it
//     is a file, or a directory that is empty when it is swept;
//   * moving a quarantined directory back first claims the original path with a
//     new empty directory (mkdir fails when the path is occupied) and then
//     renames the quarantine over that placeholder; a writer that removes the
//     placeholder and puts its own EMPTY directory there in between loses that
//     empty directory to the rename;
//   * the leftovers named are those present when they are enumerated; one that
//     arrives after the enumeration (through a descriptor or working directory)
//     is not named.

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

// One directory entry this operation published, with the identity it had when
// it was published.
export interface PublishedEntry {
  path: string;
  dev: bigint;
  ino: bigint;
  kind: PublishedKind;
}

export type OnPublished = (entry: PublishedEntry) => void;

// What a rollback left behind. Paths in `leftovers` are relative to the
// caller's report directory ("." is that directory itself); a directory named
// there is left with everything in it.
export interface RollbackReport {
  leftovers: string[];
  // A quarantine that could not be moved back because its original path was
  // occupied: where it is now, and what it holds (paths relative to it).
  stranded: Array<{ quarantine: string; original: string; leftovers: string[] }>;
  // Each cleanup step that failed, naming the path and the error. A failure in
  // one step never stops the independent steps after it.
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

function isRecorded(
  st: BigIntStats,
  e: { dev: bigint; ino: bigint; kind: PublishedKind },
): boolean {
  return st.dev === e.dev && st.ino === e.ino && kindOf(st) === e.kind;
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

// Create ONE directory level and record it when this call created it. Returns
// the recorded entry, or undefined when the path already existed (EEXIST: not
// ours) or was no longer a directory when its identity was read.
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
  const st = lstatSync(path, { bigint: true });
  if (kindOf(st) !== "dir") return undefined;
  const entry: PublishedEntry = { path, dev: st.dev, ino: st.ino, kind: "dir" };
  onPublished?.(entry);
  return entry;
}

// Create `path` exclusively (never through a symlink at it) and record it from
// the descriptor before anything else can fail. Returns the open descriptor;
// the caller writes and closes it.
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

// Record what an external program (git) wrote inside `root`, a directory this
// run created: every regular file and directory, walking only through
// directories that lstat reports as real directories. Anything else (a symlink,
// a socket), and anything that cannot be read, is left unrecorded, so a rollback
// keeps it and names it. Never throws, so it cannot mask the program's own
// failure.
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
// leftover paths are named relative to. Never throws: every failure is reported.
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
  // ours) is never touched; it is named when it is still there.
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
  // ROOT: nothing is moved or removed unless the root is still ours.
  const st = lstatIfPresent(root.path);
  if (st === undefined) return;
  if (!isRecorded(st, root)) {
    report.leftovers.push(name(root.path));
    return;
  }

  // QUARANTINE: move the root out of its path, then check what moved.
  const quarantine = join(dirname(root.path), `${QUARANTINE_PREFIX}${randomUUID()}`);
  renameSync(root.path, quarantine);
  const moved = lstatIfPresent(quarantine);
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
  // enumerated after the sweep and it is moved back.
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
    } catch {
      left = ["."];
    }
  }
  settle(quarantine, root.path, moved, left, name, report);
}

// Remove the recorded entries inside `root` (now at `quarantine`), deepest
// first. An entry is touched only when every directory above it (inside the
// root) is a recorded directory that lstat still verifies, and only while the
// entry itself still matches its record.
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

// Is every directory above `rel` (inside the root) a recorded directory that
// lstat still reports as that directory? Checked from the top down, so each
// lstat goes only through directories already verified.
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

// The entries left in the quarantine, relative to it. A recorded directory that
// still verifies is listed through (and named itself only when nothing inside
// it is named); anything else is named and never descended into.
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
      } catch {
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

// Move a quarantined entry back to `original` when that path is free, and name
// what it holds; when the path is occupied, leave it in the quarantine and
// report where it is.
function settle(
  quarantine: string,
  original: string,
  st: BigIntStats,
  left: string[],
  name: (path: string) => string,
  report: RollbackReport,
): void {
  if (moveBack(quarantine, original, st)) {
    if (left.length === 0 || (left.length === 1 && left[0] === ".")) {
      report.leftovers.push(name(original));
    } else {
      for (const rel of left) report.leftovers.push(name(join(original, rel)));
    }
    return;
  }
  report.stranded.push({ quarantine, original, leftovers: left.length > 0 ? left : ["."] });
}

// Move `quarantine` back to `original` without replacing anything at
// `original`. A directory first claims the path with a new empty directory
// (mkdir fails when the path is occupied) and is then renamed over that
// placeholder; a file is hard-linked (link fails when the path is occupied) and
// the quarantine name removed; a symlink is re-created with the same target.
function moveBack(quarantine: string, original: string, st: BigIntStats): boolean {
  if (st.isDirectory()) {
    let placeholder: PublishedEntry | undefined;
    try {
      placeholder = mkdirOwned(original);
    } catch {
      return false;
    }
    if (placeholder === undefined) return false;
    try {
      renameSync(quarantine, original);
      return true;
    } catch {
      removeEmptyPlaceholder(original, placeholder);
      return false;
    }
  }
  try {
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(quarantine), original);
    else linkNoReplace(quarantine, original);
  } catch {
    return false;
  }
  try {
    unlinkSync(quarantine);
  } catch {
    /* both names now hold the same entry; the original path is restored */
  }
  return true;
}

function linkNoReplace(from: string, to: string): void {
  linkSync(from, to);
}

function removeEmptyPlaceholder(path: string, placeholder: PublishedEntry): void {
  try {
    const st = lstatIfPresent(path);
    if (st !== undefined && isRecorded(st, placeholder)) rmdirSync(path);
  } catch {
    /* a placeholder that is not empty, or no longer ours, stays */
  }
}
