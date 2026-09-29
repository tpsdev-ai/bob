// Confined `read` for resident roles.
//
// pi's built-in read tool reads any path the agent's OS user can read. A
// resident agent runs unattended behind its service unit and answers a chat
// surface, so that reach includes the agent's OWN credentials — its Flair
// identity key, a chat bot token file, a capability key file, and the provider
// login store. A resident role that opts into `read` gets a confined one
// instead: bob hands pi a custom tool named `read` (pi's tool registry is keyed
// by name and an SDK custom tool is registered last, so it wins), so pi's
// unconfined read is never reachable.
//
// WHERE THE CHECK RUNS. The confined tool is pi's own read with bob's file
// operations plugged in (pi's `ReadOperations`). pi resolves the requested path
// (its `~`, `@` and `file:` handling, its macOS name variants) and hands the
// ABSOLUTE path it is about to read to those operations; bob checks THAT path,
// so the check and the read can never disagree about which path was meant.
//
// What the check refuses:
//   * any path that does not resolve to an existing regular file inside the
//     agent's workspace root — the path and the root are both resolved with
//     `realpathSync.native` (symlinks followed, `..` resolved away, and the
//     on-disk letter case returned, so a case-variant spelling on a
//     case-insensitive volume resolves to the same name);
//   * any key or token file bob's parsed config names, plus the provider stores
//     under `.pi-agent` — matched by canonical path AND by device + inode, so a
//     hard link or a case variant of a credential is refused even inside the
//     workspace;
//   * anything whose resolution or stat FAILS: unknown evidence refuses. The one
//     tolerated failure is a credential path that does not exist (ENOENT /
//     ENOTDIR): no file lives there, so it cannot be the file being read.
//
// Closing the check-to-open race: after the check, bob OPENS the checked
// canonical path (O_NOFOLLOW, O_NONBLOCK) and fstat()s the descriptor; the
// bytes are read from that descriptor only when its device + inode equal the
// file that was checked. A path swapped between the check and the open is
// therefore refused, never read.
//
// What this does NOT cover: other tools that read files (pi's grep/find/ls,
// anchored-edit's read_lines) are not confined by this module, and a bob.yaml
// credential path is only refused as bob's parser reads it.

import { type BigIntStats, constants, realpathSync, statSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import type { ReadOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { readBlock } from "./bob-yaml.js";

// ─── The credential list, from bob's own parsed config ───────────────────────

// Every config field that names a key or token FILE, keyed by the bob.yaml
// block that carries it. The capability entries are the blessed capabilities'
// config schemas (a drift test walks every schema in the catalog and fails on a
// key/token/credential file field missing here); `identity` is bob.yaml's own
// block (`bob init` writes `identity.key_file`). The top-level `flair:` block is
// both the flair capability's config and the identity tps-mail signs with.
export const CREDENTIAL_FILE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  identity: Object.freeze(["key_file"]),
  flair: Object.freeze(["keyFile"]),
  discord: Object.freeze(["tokenFile"]),
  presence: Object.freeze(["keyFile"]),
  observatory: Object.freeze(["officeKeyFile"]),
});

// pi's provider stores under the agent's `.pi-agent` dir: the login store holds
// the provider API keys, and models.json may carry a provider `apiKey`. Both are
// credentials even though bob.yaml never names them.
export const PROVIDER_LOGIN_STORE = "auth.json";
export const PROVIDER_MODELS_STORE = "models.json";

export type CredentialPathList = { ok: true; paths: string[] } | { ok: false; reason: string };

export interface CredentialSources {
  // bob.yaml's text. A block that no resolved capability supplies is read with
  // bob's own block reader (readBlock) — the parser that hands every capability
  // its config — never with a second, looser one.
  yamlText: string;
  // The resolved, schema-validated capabilities (resolveCapabilities, or an
  // adopted agent's resolution). A capability's credential fields are taken
  // from THIS validated config when it is present.
  capabilities: ReadonlyArray<{ name: string; config: Record<string, unknown> }>;
  // `<agentDir>/.pi-agent`.
  piAgentDir: string;
  // `<agentDir>/work` — the session's cwd.
  workspaceRoot: string;
  // The directory a relative credential path resolves against in the process
  // that opens it (a capability opens its key file with the process cwd).
  // Defaults to process.cwd().
  processCwd?: string;
}

// Expand `~` / `~/` the way the capabilities and pi do. An absolute path is
// kept; a relative one is returned as-is for the caller to resolve.
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// The absolute path(s) one configured credential value can mean. A relative
// value is ambiguous — the capability opens it against the process cwd, a read
// request would resolve it against the workspace — so BOTH are refused.
function credentialCandidates(value: string, workspaceRoot: string, processCwd: string): string[] {
  const expanded = expandHome(value);
  if (isAbsolute(expanded)) return [resolvePath(expanded)];
  return [resolvePath(processCwd, expanded), resolvePath(workspaceRoot, expanded)];
}

// Every key or token file the agent's parsed config names, plus pi's provider
// stores — or a REASON the list cannot be built. The caller must not substitute
// an empty list for a failure: a resident `read` is composed only with a list.
export function collectCredentialPaths(src: CredentialSources): CredentialPathList {
  const processCwd = src.processCwd ?? process.cwd();
  const paths = new Set<string>([
    join(src.piAgentDir, PROVIDER_LOGIN_STORE),
    join(src.piAgentDir, PROVIDER_MODELS_STORE),
  ]);
  const resolved = new Map(src.capabilities.map((c) => [c.name, c.config]));
  for (const [block, fields] of Object.entries(CREDENTIAL_FILE_FIELDS)) {
    let config: Record<string, unknown> | undefined = resolved.get(block);
    if (config === undefined) {
      try {
        config = readBlock(src.yamlText, block);
      } catch (err) {
        return {
          ok: false,
          reason: `bob.yaml's "${block}:" block could not be read (${err instanceof Error ? err.message : String(err)})`,
        };
      }
    }
    if (config === undefined) continue;
    for (const field of fields) {
      const value = config[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.trim() === "") {
        return {
          ok: false,
          reason: `bob.yaml ${block}.${field} is not a file path (write it as a quoted string)`,
        };
      }
      for (const p of credentialCandidates(value, src.workspaceRoot, processCwd)) paths.add(p);
    }
  }
  return { ok: true, paths: [...paths] };
}

// ─── The check ───────────────────────────────────────────────────────────────

export interface ConfineReadOptions {
  // The agent's workspace root (the session cwd). Reads must land inside it.
  workspaceRoot: string;
  // Absolute credential paths (collectCredentialPaths). Refused even inside the
  // root.
  credentialPaths: readonly string[];
}

// The file a check approved: its canonical path and its identity.
export interface CheckedReadTarget {
  path: string;
  dev: bigint;
  ino: bigint;
}

function refusal(path: string, why: string): Error {
  return new Error(`bob: refusing to read "${path}": ${why}.`);
}

function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown error";
}

const NOT_IN_WORKSPACE = "it does not resolve to a file inside the agent's workspace";

// One credential path's identity, or `undefined` when it is KNOWN absent
// (ENOENT/ENOTDIR: no file lives there). Any other failure is unknown evidence
// and throws a refusal for the read being checked.
function credentialIdentity(cred: string, readPath: string): CheckedReadTarget | undefined {
  let canonical: string;
  try {
    canonical = realpathSync.native(expandHome(cred));
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw refusal(
      readPath,
      `one of the agent's credential paths could not be checked (${code}); fix the permissions or the path of the key and token files bob.yaml names`,
    );
  }
  try {
    const st = statSync(canonical, { bigint: true });
    return { path: canonical, dev: st.dev, ino: st.ino };
  } catch (err) {
    throw refusal(
      readPath,
      `one of the agent's credential paths could not be checked (${errCode(err)}); fix the permissions or the path of the key and token files bob.yaml names`,
    );
  }
}

// Check the ABSOLUTE path a read is about to open. Returns the approved file's
// canonical path and identity; throws a refusal otherwise.
export function checkReadTarget(absolutePath: string, opts: ConfineReadOptions): CheckedReadTarget {
  if (typeof absolutePath !== "string" || absolutePath.trim() === "") {
    throw new Error("bob: refusing to read: a path is required.");
  }
  let root: string;
  try {
    root = realpathSync.native(opts.workspaceRoot);
  } catch (err) {
    throw refusal(absolutePath, `the agent's workspace root is not readable (${errCode(err)})`);
  }
  // A path that does not resolve is refused with the SAME words as one outside
  // the workspace, so a refusal says nothing about what exists outside it.
  let target: string;
  try {
    target = realpathSync.native(absolutePath);
  } catch {
    throw refusal(absolutePath, NOT_IN_WORKSPACE);
  }
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw refusal(absolutePath, NOT_IN_WORKSPACE);
  }
  let st: BigIntStats;
  try {
    st = statSync(target, { bigint: true });
  } catch (err) {
    throw refusal(absolutePath, `it could not be checked (${errCode(err)})`);
  }
  if (!st.isFile()) throw refusal(absolutePath, "it is not a regular file");
  const { dev, ino } = st;
  for (const cred of opts.credentialPaths) {
    const id = credentialIdentity(cred, absolutePath);
    if (id === undefined) continue;
    if (id.path === target || (id.dev === dev && id.ino === ino)) {
      throw refusal(
        absolutePath,
        "it is a credential file (a key or token file bob.yaml names, or a provider store under .pi-agent)",
      );
    }
  }
  return { path: target, dev, ino };
}

// Open the CHECKED canonical path and verify the descriptor is the checked file
// (device + inode, and still a regular file) before anything is read from it.
// O_NOFOLLOW refuses a final component swapped for a symlink; the fstat
// comparison refuses any other replacement. `absolutePath` is for the message.
export async function openVerifiedReadTarget(
  checked: CheckedReadTarget,
  absolutePath: string,
): Promise<FileHandle> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fh: FileHandle;
  try {
    fh = await open(checked.path, flags);
  } catch (err) {
    throw refusal(absolutePath, `it changed after it was checked (${errCode(err)})`);
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.dev !== checked.dev || st.ino !== checked.ino) {
      throw refusal(absolutePath, "it changed between the check and the open");
    }
    return fh;
  } catch (err) {
    await fh.close().catch(() => {});
    if (err instanceof Error && err.message.startsWith("bob: refusing")) throw err;
    throw refusal(absolutePath, `it could not be checked (${errCode(err)})`);
  }
}

// Check the path pi resolved, then open and verify it.
export async function openCheckedReadTarget(
  absolutePath: string,
  opts: ConfineReadOptions,
): Promise<FileHandle> {
  return openVerifiedReadTarget(checkReadTarget(absolutePath, opts), absolutePath);
}

// ─── Image sniffing on the verified descriptor ──────────────────────────────
//
// pi's read asks its operations for an image MIME type before it reads. pi's own
// detector opens the path again, so the confined operations sniff the verified
// descriptor instead, recognising the same formats pi supports (JPEG, PNG, GIF,
// WebP, BMP; not an animated PNG, not JPEG-LS). A test pins parity with pi's own
// read on the same files.

const IMAGE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesAt(buf: Buffer, offset: number, bytes: readonly number[]): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function asciiAt(buf: Buffer, offset: number, text: string): boolean {
  return bytesAt(
    buf,
    offset,
    [...text].map((c) => c.charCodeAt(0)),
  );
}

function u32be(buf: Buffer, offset: number): number {
  return buf.length >= offset + 4 ? buf.readUInt32BE(offset) : 0;
}

function u32le(buf: Buffer, offset: number): number {
  return buf.length >= offset + 4 ? buf.readUInt32LE(offset) : 0;
}

function u16le(buf: Buffer, offset: number): number {
  return buf.length >= offset + 2 ? buf.readUInt16LE(offset) : 0;
}

function pngIsAnimated(buf: Buffer): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buf.length) {
    const length = u32be(buf, offset);
    if (asciiAt(buf, offset + 4, "acTL")) return true;
    if (asciiAt(buf, offset + 4, "IDAT")) return false;
    const next = offset + 8 + length + 4;
    if (next <= offset || next > buf.length) return false;
    offset = next;
  }
  return false;
}

function bmpIsValid(buf: Buffer): boolean {
  if (buf.length < 26) return false;
  const fileSize = u32le(buf, 2);
  const pixelOffset = u32le(buf, 10);
  const dibSize = u32le(buf, 14);
  if (fileSize !== 0 && fileSize < 26) return false;
  if (pixelOffset < 14 + dibSize) return false;
  if (fileSize !== 0 && pixelOffset >= fileSize) return false;
  let planes: number;
  let bits: number;
  if (dibSize === 12) {
    planes = u16le(buf, 22);
    bits = u16le(buf, 24);
  } else if (dibSize >= 40 && dibSize <= 124) {
    if (buf.length < 30) return false;
    planes = u16le(buf, 26);
    bits = u16le(buf, 28);
  } else {
    return false;
  }
  return planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits);
}

export function sniffImageMimeType(buf: Buffer): string | null {
  if (bytesAt(buf, 0, [0xff, 0xd8, 0xff])) return buf[3] === 0xf7 ? null : "image/jpeg";
  if (bytesAt(buf, 0, PNG_SIGNATURE)) {
    const isPng = buf.length >= 16 && u32be(buf, 8) === 13 && asciiAt(buf, 12, "IHDR");
    return isPng && !pngIsAnimated(buf) ? "image/png" : null;
  }
  if (asciiAt(buf, 0, "GIF")) return "image/gif";
  if (asciiAt(buf, 0, "RIFF") && asciiAt(buf, 8, "WEBP")) return "image/webp";
  if (asciiAt(buf, 0, "BM") && bmpIsValid(buf)) return "image/bmp";
  return null;
}

// ─── The tool ────────────────────────────────────────────────────────────────

// pi's read operations with the check in front of every one of them: each
// operation checks the path pi resolved, opens the checked file, verifies the
// descriptor, and works from that descriptor only.
export function confinedReadOperations(opts: ConfineReadOptions): ReadOperations {
  return {
    access: async (absolutePath) => {
      const fh = await openCheckedReadTarget(absolutePath, opts);
      await fh.close();
    },
    detectImageMimeType: async (absolutePath) => {
      const fh = await openCheckedReadTarget(absolutePath, opts);
      try {
        const buf = Buffer.alloc(IMAGE_SNIFF_BYTES);
        const { bytesRead } = await fh.read(buf, 0, IMAGE_SNIFF_BYTES, 0);
        return sniffImageMimeType(buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    },
    readFile: async (absolutePath) => {
      const fh = await openCheckedReadTarget(absolutePath, opts);
      try {
        return await fh.readFile();
      } finally {
        await fh.close();
      }
    },
  };
}

// A pi read tool definition confined to `workspaceRoot`, with `credentialPaths`
// refused even inside it. It IS pi's read (same name, schema, output and
// truncation), with bob's checked file operations.
export function createConfinedReadToolDefinition(
  workspaceRoot: string,
  credentialPaths: readonly string[],
): ToolDefinition {
  const opts: ConfineReadOptions = { workspaceRoot, credentialPaths: [...credentialPaths] };
  return createReadToolDefinition(workspaceRoot, {
    operations: confinedReadOperations(opts),
  }) as unknown as ToolDefinition;
}

// ─── Who gets it ─────────────────────────────────────────────────────────────

export interface ReadConfinementPolicy {
  resident: boolean;
  tools: readonly string[];
  excludeTools: readonly string[];
}

export interface ReadConfinementConfig {
  // The session's cwd — the workspace root.
  cwd: string;
  // The RESOLVED residency decision (bob.yaml `resident: true`, or the
  // persistent runtime), carried on the session config by resolveRunConfig.
  resident?: boolean;
  persistent?: boolean;
  // Set ONLY by the fixed setup session (onboard/align).
  setupSoulPath?: string;
  // collectCredentialPaths' list, or the reason it is unavailable.
  credentialPaths?: readonly string[];
  credentialPathsUnavailable?: string;
}

// Does this session's `read` have to be the confined one? A session is resident
// when its policy says so OR its config carries the resolved residency decision
// (a one-shot `bob run` of a `resident: true` agent) OR it is the persistent
// runtime. The fixed setup session (onboard/align: read + write_soul) is
// exempt: it must read the seed soul at `<agentDir>/soul.md`, outside its
// workspace root, and runs locally at the operator's keyboard before any chat
// surface exists.
export function readConfinementApplies(
  policy: ReadConfinementPolicy,
  config: Omit<ReadConfinementConfig, "cwd">,
): boolean {
  if (config.setupSoulPath !== undefined) return false;
  const resident = policy.resident || config.resident === true || config.persistent === true;
  if (!resident) return false;
  return policy.tools.includes("read") && !policy.excludeTools.includes("read");
}

// The custom tools a session needs: the confined read when readConfinementApplies,
// otherwise none (pi's own read is fine for a non-resident session). A resident
// read is NEVER composed without the credential list: a config that lacks it is
// refused, naming the remedy.
export function confinedReadCustomTools(
  policy: ReadConfinementPolicy,
  config: ReadConfinementConfig,
): ToolDefinition[] {
  if (!readConfinementApplies(policy, config)) return [];
  if (config.credentialPaths === undefined) {
    const why =
      config.credentialPathsUnavailable ??
      "the session config carries no credential list (resolve it with resolveRunConfig)";
    throw new Error(
      `bob: refusing to start a resident session that allows read: the agent's credential file list is unavailable — ${why}. Fix bob.yaml so every key and token file path it names can be read by bob, or drop read from tools.allow.`,
    );
  }
  return [createConfinedReadToolDefinition(config.cwd, config.credentialPaths)];
}
