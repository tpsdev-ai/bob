// write-soul.ts - the bob-owned, soul-ONLY write tool for the setup sessions
// (`bob onboard`'s hiring interview and `bob align`). bob#204.
//
// WHY IT EXISTS. The setup sessions used to add pi's generic `write` so the
// interview could write the agent's refined persona to `soul.md` - the one
// documented exception to the role/grant ceiling. But pi's `write` accepts any
// absolute path the OS user can write, so a setup session could rewrite
// `bob.yaml`, capability overrides, grants, launcher scripts, or files outside
// the agent directory. It was never limited to `soul.md`.
//
// THREAT MODEL. The actor this defends against is the setup session's OWN tool
// calls. The model in a setup session holds exactly two tools, `read` and
// `write_soul`, and no shell, so it cannot start a second process or change a
// file except through `write_soul`. What is guaranteed is about those calls:
// whatever arguments the model sends, `write_soul` writes only the soul.md it
// was bound to before the session started, never a file named by an argument,
// and never through a symlink. A concurrent local process that can rename
// directories inside the agents tree already holds the operator's write access,
// and defending against it is OUT OF SCOPE (that needs the OS boundary of
// bob#189). The directory checks below narrow what such a process can do to a
// call in flight, best effort; they are not a guarantee against it.
//
// WHAT `write_soul` DOES, all at its one write:
//
//   - BINDING. Before the session starts, onboard and align canonicalize the
//     agents root ONCE (realpath) and use that one directory for the session's
//     config (resolveRunConfig), its paths and this binding
//     (bindSetupSoulTarget). A requested agent directory that is not
//     `<agents root>/<name>` is refused before the session starts.
//   - ARGUMENTS. The schema is `{ content }` with additionalProperties false,
//     and execute refuses EVERY other key (an allowlist, not a list of
//     path-like names), a non-string or empty `content`, and content over
//     MAX_SOUL_BYTES of UTF-8.
//   - NO SYMLINK IN ANY COMPONENT. On every call each component of the bound
//     agent directory is lstat'ed from the filesystem root down: a symlink or a
//     non-directory anywhere is refused, and so is a symlinked or non-regular
//     soul.md.
//   - ONE DIRECTORY PER CALL. Each call opens the agent directory once
//     (O_DIRECTORY|O_NOFOLLOW) and requires the handle to be the directory the
//     walk saw (same dev and ino). On Linux, when /proc is usable (checked on
//     every call), the temp creation, the rename and the cleanup unlink go
//     through /proc/self/fd/<fd>/<name>, which the kernel resolves through the
//     open handle. Node has no openat/renameat/unlinkat, so on macOS (and on a
//     host without a usable /proc) those calls use the bound path, and the walk
//     plus the (dev, ino) check is repeated immediately before each of them.
//     For the session's own calls both reach the same directory. Against a
//     concurrent directory swap the path checks are best effort, not a
//     guarantee (see THREAT MODEL).
//   - EVERY BYTE. The UTF-8 buffer is written in a loop that honors each
//     partial write and refuses zero progress, then fsync'ed; soul.md is
//     replaced (rename) only after every byte is written and synced. The
//     directory is fsync'ed after the rename (best effort).
//   - TEMP FILES. Named `.soul.md.write_soul-<pid>-<24 hex>.tmp`
//     (SOUL_TEMP_PATTERN) and created exclusively (O_EXCL|O_NOFOLLOW). On a
//     failure a call removes only the temp IT created: it checks that the name
//     still holds that temp's inode, then unlinks it. The temp is held open
//     until then, so its inode number cannot be recycled for another file
//     (ext4 reuses a freed number at once). A concurrent local process could
//     still replace the entry between that check and the unlink; that is out
//     of scope, and the check is best effort against it. write_soul never
//     deletes a file on name-and-age evidence: a crash between the temp's
//     creation and its rename leaves the temp in the agent directory. bob never
//     reads it, and it is safe to delete by hand.
//   - MODE. Replacing soul.md keeps its permission bits; a new soul.md is 0600.
//
// LIMIT, STATED. An agent running as the operator's OS user with a shell or
// unrestricted read can still reach operator files directly. That needs an OS
// boundary (bob#189 nono), which this does not replace.

import { randomBytes } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

/** The one tool name the setup policy grants (read + write_soul). */
export const WRITE_SOUL_TOOL = "write_soul";

/**
 * The size cap for a soul.md written through `write_soul`: 64 KiB of UTF-8.
 * A persona is prose; 64 KiB is a generous ceiling that still bounds what a
 * model can dump into the agent's directory in one call. A larger body is
 * refused with the observed size, never truncated.
 */
export const MAX_SOUL_BYTES = 64 * 1024;

/** The one file name write_soul writes, inside the bound agent directory. */
export const SOUL_FILE = "soul.md";

/** The permission bits of a soul.md write_soul creates. An existing soul.md
 *  keeps its own bits. */
export const NEW_SOUL_MODE = 0o600;

/** The name of every temp file write_soul creates: pid + 96 random bits. A
 *  crash can leave one behind in the agent directory; nothing deletes it
 *  automatically, and it is safe to delete by hand. */
export const SOUL_TEMP_PATTERN = /^\.soul\.md\.write_soul-\d+-[0-9a-f]{24}\.tmp$/;

const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIR_OPEN_FLAGS = constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
const TEMP_OPEN_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;

export interface SoulToolOutput {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** The pi ExtensionAPI slice `write_soul` needs. Structural, so a test fake and
 *  pi's real ExtensionAPI both satisfy it. */
export interface SoulWritePi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => Promise<SoulToolOutput>;
  }): void;
}

/** The filesystem calls write_soul makes. A seam: tests replace one call (a
 *  short write, a failing fsync) and keep the rest real. */
export interface SoulFs {
  open(path: string, flags: number, mode?: number): number;
  write(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  fsync(fd: number): void;
  fchmod(fd: number, mode: number): void;
  close(fd: number): void;
  fstat(fd: number): BigIntStats;
  lstat(path: string): BigIntStats;
  stat(path: string): BigIntStats;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  readdir(path: string): string[];
}

const NODE_FS: SoulFs = {
  open: (path, flags, mode) => openSync(path, flags, mode),
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsync: (fd) => fsyncSync(fd),
  fchmod: (fd, mode) => fchmodSync(fd, mode),
  close: (fd) => closeSync(fd),
  fstat: (fd) => fstatSync(fd, { bigint: true }),
  lstat: (path) => lstatSync(path, { bigint: true }),
  stat: (path) => statSync(path, { bigint: true }),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  readdir: (path) => readdirSync(path),
};

export interface WireSoulWriteOptions {
  /** Logger seam; defaults to console.error. Refusals are returned to the model
   *  in the tool result, not logged, so this is only for unexpected errors. */
  log?: (msg: string) => void;
  /** Test seam: filesystem calls to replace; the rest stay node:fs. */
  fs?: Partial<SoulFs>;
  /** Test seam: the temp file's name. Defaults to a fresh SOUL_TEMP_PATTERN name. */
  tempName?: () => string;
  /** Test seam: runs after the temp is written and synced (it stays open),
   *  immediately before the final check and the rename. */
  beforeRename?: () => void;
  /** Test seam: a path the kernel resolves THROUGH the open directory handle.
   *  Defaults to /proc/self/fd/<fd> on Linux and none elsewhere; return
   *  undefined to force the path-verified mode. */
  dirHandlePath?: (fd: number) => string | undefined;
}

/** The directory write_soul is bound to, and its one target. */
export interface SoulTarget {
  /** The agents root, canonicalized ONCE (realpath). The session's config is
   *  resolved from THIS root, so config and soul come from one tree. */
  agentsRoot: string;
  /** `<agentsRoot>/<name>`: every component a real directory. */
  agentDir: string;
  /** `<agentDir>/soul.md`. */
  soulPath: string;
}

function ok(text: string, details: Record<string, unknown>): SoulToolOutput {
  return { content: [{ type: "text", text }], details };
}

function refuse(reason: string, extra: Record<string, unknown> = {}): SoulToolOutput {
  return ok(`REFUSED: ${reason}`, { refused: true, reason, ...extra });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameFile(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** lstat, with a missing entry as undefined; any other error is thrown. */
function lstatIfPresent(fs: SoulFs, path: string): BigIntStats | undefined {
  try {
    return fs.lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

type DirCheck = { ok: true; dir: BigIntStats } | { ok: false; reason: string };

/**
 * lstat every component of the absolute directory `dir`, from the filesystem
 * root down. Each must exist, be a directory and NOT be a symlink. Returns the
 * last component's stats (dev, ino) for the pin comparison.
 */
function checkDirPath(fs: SoulFs, dir: string): DirCheck {
  const { root } = parse(dir);
  let cur = root;
  let last: BigIntStats | undefined;
  for (const part of dir.slice(root.length).split(sep)) {
    if (part === "") continue;
    cur = join(cur, part);
    let st: BigIntStats;
    try {
      st = fs.lstat(cur);
    } catch (err) {
      return { ok: false, reason: `${cur} cannot be checked (${errText(err)})` };
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        reason: `${cur} is a symlink; write_soul refuses a symlink in any component of the path to soul.md`,
      };
    }
    if (!st.isDirectory()) return { ok: false, reason: `${cur} is not a directory` };
    last = st;
  }
  if (last === undefined) return { ok: false, reason: `${dir} is not an agent directory` };
  return { ok: true, dir: last };
}

/** Linux: the kernel resolves names under /proc/self/fd/<fd> through the open
 *  handle. Nothing equivalent is reachable from Node on macOS. */
function procFdPath(fd: number): string | undefined {
  return process.platform === "linux" ? `/proc/self/fd/${fd}` : undefined;
}

/** A write_soul temp name: SOUL_TEMP_PATTERN, 96 random bits. */
function defaultTempName(): string {
  return `.${SOUL_FILE}.write_soul-${process.pid}-${randomBytes(12).toString("hex")}.tmp`;
}

/** The bound soul path must be absolute, normalized and name soul.md. bob
 *  builds it; anything else is a bug, caught before a session starts. */
function assertBoundSoulPath(soulPath: string): void {
  if (!isAbsolute(soulPath) || resolve(soulPath) !== soulPath || basename(soulPath) !== SOUL_FILE) {
    throw new Error(
      `write_soul must be bound to an absolute, normalized path to ${SOUL_FILE}; got ${JSON.stringify(soulPath)}`,
    );
  }
}

/**
 * Bind a setup session BEFORE it starts: canonicalize the agents root ONCE and
 * return the one tree the session uses for its config, its paths and
 * write_soul.
 *
 * `requestedAgentDir` is the directory the caller named (`bob align
 * --agent-dir`). The session runs as `name` from `<canonical root>/<name>`, so
 * a requested directory with another basename is refused: otherwise the session
 * would run as one agent and write another agent's soul.md. The agent directory
 * must be a real directory (no symlink in any component) and soul.md, if
 * present, a regular file. The caller resolves the session's config with
 * `agentsRoot` from the result, never by re-deriving it from the request.
 * Throws an actor/state/remedy error.
 */
export function bindSetupSoulTarget(input: {
  /** The command, for the error: "bob align" or "bob onboard". */
  command: string;
  name: string;
  requestedAgentDir: string;
}): SoulTarget {
  const who = `${input.command} ${input.name}`;
  const requested = resolve(input.requestedAgentDir);
  let agentsRoot: string;
  try {
    agentsRoot = realpathSync(dirname(requested));
  } catch (err) {
    throw new Error(
      `${who}: refusing to start - the agents root ${dirname(requested)} cannot be resolved (${errText(err)}). ` +
        `Point --agent-dir at an existing agent directory.`,
    );
  }
  const agentDir = join(agentsRoot, input.name);
  if (basename(requested) !== input.name) {
    throw new Error(
      `${who}: refusing to start - the agent directory ${requested} is not ${input.name}'s. ` +
        `The session runs as ${input.name} from ${agentDir} (its bob.yaml), so write_soul would be ` +
        `bound to a different agent's soul.md. Point --agent-dir at ${agentDir}, or run ` +
        `'${input.command} ${basename(requested)}' for the agent in ${requested}.`,
    );
  }
  if (lstatIfPresent(NODE_FS, agentDir) === undefined) {
    throw new Error(
      `${who}: refusing to start - the agent directory ${agentDir} does not exist. ` +
        `Run 'bob onboard ${input.name}' first, or point --agent-dir at an existing agent directory.`,
    );
  }
  const walked = checkDirPath(NODE_FS, agentDir);
  if (!walked.ok) {
    throw new Error(
      `${who}: refusing to start - ${walked.reason}. write_soul writes only through a real, ` +
        `symlink-free agent directory. Replace the link with the directory it points to, or ` +
        `point --agent-dir at the real path.`,
    );
  }
  const soulPath = join(agentDir, SOUL_FILE);
  const soul = lstatIfPresent(NODE_FS, soulPath);
  if (soul !== undefined && (soul.isSymbolicLink() || !soul.isFile())) {
    throw new Error(
      `${who}: refusing to start - ${soulPath} is ${soul.isSymbolicLink() ? "a symlink" : "not a regular file"}, ` +
        `and write_soul will not replace it. Replace it with a regular file holding the persona, then retry.`,
    );
  }
  return { agentsRoot, agentDir, soulPath };
}

interface WriteIo {
  fs: SoulFs;
  log: (msg: string) => void;
  tempName: () => string;
  beforeRename?: () => void;
  dirHandlePath: (fd: number) => string | undefined;
}

interface OwnTemp {
  name: string;
  dev: bigint;
  ino: bigint;
}

/** The pinned directory for one call. `base` is where names are opened,
 *  renamed and unlinked: the fd-relative path, or the bound path. */
interface Pinned {
  fd: number;
  dev: bigint;
  ino: bigint;
  base: string;
  fdRelative: boolean;
}

/** The mutable facts cleanup needs, whatever step failed. */
interface CallState {
  /** The temp's fd: held open until cleanup is done (closed last). */
  tempFd?: number;
  /** Set ONLY once THIS call's exclusive create succeeded. */
  temp?: OwnTemp;
  renamed: boolean;
}

/** Write `data` to the bound soul.md. Never throws: every failure is a refusal. */
function writeSoulFile(
  agentDir: string,
  soulPath: string,
  data: Buffer,
  io: WriteIo,
): SoulToolOutput {
  const { fs } = io;

  const walked = checkDirPath(fs, agentDir);
  if (!walked.ok) return refuse(`${walked.reason}. soul.md is unchanged.`);
  let dirFd: number;
  try {
    dirFd = fs.open(agentDir, DIR_OPEN_FLAGS);
  } catch (err) {
    return refuse(
      `cannot open the agent directory ${agentDir} (${errText(err)}). soul.md is unchanged.`,
    );
  }

  const state: CallState = { renamed: false };
  let pin: Pinned | undefined;
  let result: SoulToolOutput;
  try {
    const d = fs.fstat(dirFd);
    if (!sameFile(d, walked.dir)) {
      result = refuse(
        `the agent directory ${agentDir} changed between its check and its open. soul.md is unchanged.`,
      );
    } else {
      pin = pinDirectory(fs, dirFd, d, agentDir, io.dirHandlePath);
      result = writeThroughPin(agentDir, soulPath, data, io, pin, state);
    }
  } catch (err) {
    const message = errText(err);
    io.log(`write_soul failed: ${message}`);
    result = refuse(
      `the write to soul.md failed: ${message}. ${
        state.renamed
          ? "soul.md may already hold the new content; read it back before retrying."
          : "soul.md is unchanged."
      }`,
    );
  }

  // Cleanup compares identities, so it runs BEFORE the temp is closed.
  if (pin !== undefined && state.temp !== undefined && !state.renamed) {
    const cleanup = removeOwnTemp(fs, agentDir, pin, state.temp);
    if (cleanup === "left") {
      const note = ` The temp file ${state.temp.name} this call created could not be removed safely and was left where it was created; nothing deletes it automatically, and it is safe to delete by hand.`;
      const text = `${result.content[0]?.text ?? ""}${note}`;
      result = {
        content: [{ type: "text", text }],
        details: { ...result.details, strandedTemp: state.temp.name },
      };
    }
  }
  if (state.tempFd !== undefined) {
    try {
      fs.close(state.tempFd);
    } catch {
      /* the data is synced; a failed close changes nothing already reported */
    }
  }
  try {
    fs.close(dirFd);
  } catch {
    /* nothing more to do with the handle */
  }
  return result;
}

function pinDirectory(
  fs: SoulFs,
  dirFd: number,
  d: BigIntStats,
  agentDir: string,
  dirHandlePath: (fd: number) => string | undefined,
): Pinned {
  const handle = dirHandlePath(dirFd);
  if (handle !== undefined) {
    try {
      // Use the handle path only if it IS the pinned directory and names can be
      // listed through it; otherwise fall back to the path-verified mode.
      if (sameFile(fs.stat(handle), d)) {
        fs.readdir(handle);
        return { fd: dirFd, dev: d.dev, ino: d.ino, base: handle, fdRelative: true };
      }
    } catch {
      /* not usable here */
    }
  }
  return { fd: dirFd, dev: d.dev, ino: d.ino, base: agentDir, fdRelative: false };
}

/** Walk the bound path again and require it to still be the pinned directory. */
function verifyPinned(fs: SoulFs, agentDir: string, pin: Pinned, when: string): string | undefined {
  const w = checkDirPath(fs, agentDir);
  if (!w.ok) return `${w.reason} (${when})`;
  if (!sameFile(w.dir, pin)) {
    return `the agent directory ${agentDir} is no longer the directory write_soul opened (${when})`;
  }
  return undefined;
}

function writeThroughPin(
  agentDir: string,
  soulPath: string,
  data: Buffer,
  io: WriteIo,
  pin: Pinned,
  state: CallState,
): SoulToolOutput {
  const { fs } = io;
  const at = (name: string) => join(pin.base, name);
  const verify = (when: string) => verifyPinned(fs, agentDir, pin, when);

  // The soul.md being replaced: never a symlink or a non-file; its mode is kept.
  let mode = NEW_SOUL_MODE;
  const soul = lstatIfPresent(fs, at(SOUL_FILE));
  if (soul !== undefined) {
    if (soul.isSymbolicLink()) {
      return refuse("soul.md is a symlink; refusing to write through it. soul.md is unchanged.");
    }
    if (!soul.isFile()) return refuse("soul.md exists but is not a regular file. It is unchanged.");
    mode = Number(soul.mode & 0o777n);
  }

  // Create the temp EXCLUSIVELY in the pinned directory. A name that already
  // exists fails here, and `state.temp` stays unset, so nothing is unlinked.
  const before = verify("before the temp file was created");
  if (before !== undefined) return refuse(`${before}. soul.md is unchanged.`);
  const name = io.tempName();
  state.tempFd = fs.open(at(name), TEMP_OPEN_FLAGS, NEW_SOUL_MODE);
  const t = fs.fstat(state.tempFd);
  state.temp = { name, dev: t.dev, ino: t.ino };
  const created = lstatIfPresent(fs, at(name));
  const afterCreate = pin.fdRelative ? undefined : verify("after the temp file was created");
  if (afterCreate !== undefined || created === undefined || !sameFile(created, state.temp)) {
    return refuse(
      `${afterCreate ?? "the temp file is not in the agent directory write_soul opened"}. soul.md is unchanged.`,
    );
  }
  fs.fchmod(state.tempFd, mode);

  // EVERY byte, honoring partial writes; zero progress is a failure, not a loop.
  let offset = 0;
  while (offset < data.length) {
    const n = fs.write(state.tempFd, data, offset, data.length - offset);
    if (!Number.isInteger(n) || n <= 0 || n > data.length - offset) {
      throw new Error(
        `the filesystem accepted ${n} bytes at byte ${offset} of ${data.length}; no progress, nothing renamed`,
      );
    }
    offset += n;
  }
  fs.fsync(state.tempFd);
  // The temp stays OPEN until the rename is confirmed and any cleanup is done
  // (writeSoulFile closes it last). While it is held its inode cannot be freed,
  // so no other file can be given its inode number, and the (dev, ino) checks
  // below cannot be fooled by a file created at its name. ext4 hands a freed
  // inode number to the next file at once.

  io.beforeRename?.();

  // Immediately before the rename: the path must still be the pinned directory,
  // and the temp name must still be the file this call wrote.
  const beforeRename = verify("before the rename");
  if (beforeRename !== undefined) return refuse(`${beforeRename}. soul.md is unchanged.`);
  const still = lstatIfPresent(fs, at(name));
  if (still === undefined || !sameFile(still, state.temp)) {
    return refuse(`the temp file ${name} was replaced before the rename. soul.md is unchanged.`);
  }
  fs.rename(at(name), at(SOUL_FILE));
  state.renamed = true;

  // Success is reported only if the bound path is still the pinned directory
  // and its soul.md IS the file written - in both modes.
  const landed = lstatIfPresent(fs, at(SOUL_FILE));
  const afterRename = verify("after the rename");
  if (afterRename !== undefined || landed === undefined || !sameFile(landed, state.temp)) {
    return refuse(
      `soul.md could not be confirmed as the file just written (${afterRename ?? "it is a different file"}); treat the persona as NOT saved and retry.`,
    );
  }
  try {
    fs.fsync(pin.fd);
  } catch {
    /* the rename's durability is best effort */
  }
  return ok(`Wrote ${data.length} bytes to ${soulPath}.`, {
    bytes: data.length,
    path: soulPath,
    dirAccess: pin.fdRelative ? "fd-relative" : "path-verified",
  });
}

/**
 * Remove the temp THIS call created, on a failure: check that its name in the
 * pinned directory still holds the temp's inode (the temp is still open, so the
 * number cannot have been recycled), then unlink that name. In the
 * path-verified mode the path is re-verified first, and a directory that is no
 * longer the pinned one is not touched. The check and the unlink are two calls:
 * a concurrent local process could replace the entry between them. That actor
 * is out of scope (see THREAT MODEL); against it this is best effort.
 */
function removeOwnTemp(
  fs: SoulFs,
  agentDir: string,
  pin: Pinned,
  temp: OwnTemp,
): "removed" | "absent" | "left" {
  try {
    if (
      !pin.fdRelative &&
      verifyPinned(fs, agentDir, pin, "before removing the temp") !== undefined
    ) {
      return "left";
    }
    const path = join(pin.base, temp.name);
    const st = lstatIfPresent(fs, path);
    if (st === undefined) return "absent";
    // The name now holds a file this call did not create: never unlink it.
    if (!sameFile(st, temp)) return "left";
    fs.unlink(path);
    return "removed";
  } catch {
    return "left";
  }
}

/**
 * Register `write_soul` on `pi`, bound to `soulPath` - the absolute, normalized
 * `<agentDir>/soul.md` bob bound (bindSetupSoulTarget). The registered tool's
 * only input is `content`.
 */
export function wireSoulWrite(
  pi: SoulWritePi,
  soulPath: string,
  opts: WireSoulWriteOptions = {},
): void {
  assertBoundSoulPath(soulPath);
  const agentDir = dirname(soulPath);
  const io: WriteIo = {
    fs: { ...NODE_FS, ...opts.fs },
    log: opts.log ?? ((m: string) => console.error(m)),
    tempName: opts.tempName ?? defaultTempName,
    ...(opts.beforeRename !== undefined ? { beforeRename: opts.beforeRename } : {}),
    dirHandlePath: opts.dirHandlePath ?? procFdPath,
  };

  const execute = async (_id: string, params: Record<string, unknown>): Promise<SoulToolOutput> => {
    // CONTENT ONLY, as an allowlist: every other key is refused - never
    // "ignored", because a silently ignored argument reads as a success while
    // the write lands somewhere the caller did not intend.
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return refuse("write_soul takes one argument object: { content }.");
    }
    const unexpected = Object.keys(params).filter((key) => key !== "content");
    if (unexpected.length > 0) {
      return refuse(
        `write_soul takes only \`content\` - no path or any other argument; its one target is this agent's soul.md, bound by bob. Drop ${unexpected.map((k) => JSON.stringify(k)).join(", ")} and retry.`,
        { unexpected },
      );
    }
    const content = params.content;
    if (typeof content !== "string" || content.length === 0) {
      return refuse("write_soul requires a non-empty string `content`: the full soul.md.");
    }
    const data = Buffer.from(content, "utf8");
    if (data.length > MAX_SOUL_BYTES) {
      return refuse(
        `soul content is ${data.length} bytes, over the ${MAX_SOUL_BYTES}-byte cap. Shorten it and retry.`,
        { bytes: data.length, cap: MAX_SOUL_BYTES },
      );
    }
    return writeSoulFile(agentDir, soulPath, data, io);
  };

  pi.registerTool({
    name: WRITE_SOUL_TOOL,
    label: "Write Soul",
    description:
      "Write the agent's persona to its own soul.md (OVERWRITING it). This is the ONLY file this tool can write: the target is bound by bob, and `content` is the only argument. Pass the full markdown persona as `content`.",
    parameters: Type.Object(
      {
        content: Type.String({
          minLength: 1,
          description: "The full soul.md contents (markdown, first-person).",
        }),
      },
      { additionalProperties: false },
    ),
    execute,
  });
}

/**
 * The inline pi extension that registers `write_soul` bound to `soulPath`. bob's
 * session factory adds it (and ONLY for a setup session, where `setupSoulPath`
 * is set), so the tool exists only where the setup policy grants it. The path
 * is checked here, before pi builds the session.
 */
export function createWriteSoulExtension(soulPath: string): InlineExtension {
  assertBoundSoulPath(soulPath);
  return {
    name: "bob-write-soul",
    factory: ((pi: SoulWritePi) => {
      wireSoulWrite(pi, soulPath);
    }) as (pi: unknown) => void,
    hidden: true,
  };
}
