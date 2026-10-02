// apply_patch — deterministic, tool-owned patch application (bob#275, slice
// S2a).
//
// The change a builder publishes must be the change it verified. Applying a
// patch with shell instructions lets the two differ, so this tool owns the
// application: it reads the artifact ONCE, verifies its digest, and applies
// those VERIFIED BYTES to a fresh, tool-owned index initialized from the task's
// pinned base.
//
// It never selects paths, drops hunks, repairs whitespace, resolves conflicts
// or falls back to another base: `git apply` runs with no `--reject`, no
// `--3way`, no fuzz, and `--whitespace=nowarn` (so a repo's own
// `apply.whitespace=fix` cannot make it repair whitespace). The whole patch
// applies to the fresh index or nothing does.
//
// The authority — repository, base, mode and artifact root — comes from the
// task binding (task-binding.ts), retained by the capability, never from a tool
// argument, a model message, a repository file or bob.yaml.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ensurePrivateDir, isInside } from "./run.js";
import type { TaskBinding } from "./task-binding.js";

// Refuses detected changes to the staging directory, source or destination.
// A concurrent same-user writer can still race rename until builder confinement
// (bob#189); pathname checks cannot close that race.
export type ApplyRefusalReason =
  | "unknown_task" // the session holds no task binding
  | "invalid_binding" // the binding is present but malformed
  | "invalid_base" // expected_base is malformed, or the base cannot be read
  | "base_mismatch" // expected_base is not the task's pinned base
  | "artifact_missing" // the artifact does not exist or is not a regular file
  | "unsafe_artifact_path" // the artifact is outside its root
  | "digest_mismatch" // the artifact's digest is not the expected one
  | "tree_mismatch" // the patch's result tree is not the tree the task pins
  | "malformed_patch" // git cannot parse the patch
  | "patch_does_not_apply" // git parses it but it does not apply to the base
  | "unsafe_git_path" // the patch names a path git refuses (.git, .., absolute)
  | "unsupported_entry_type" // the patch changes a symlink or a submodule
  | "apply_failed" // a git step failed unexpectedly
  | "storage_failed"; // state-root, scratch or candidate storage failed

export interface ApplyPatchParams {
  patch_artifact: { path: string; sha256: string };
  expected_base: string;
}

export interface ApplyPatchSuccess {
  ok: true;
  candidate_id: string;
  base_oid: string;
  patch_sha256: string;
  tree_oid: string;
  changed_paths: string[];
}

export interface ApplyPatchRefusal {
  ok: false;
  reason: ApplyRefusalReason;
  message: string;
  detail?: Record<string, unknown>;
}

export type ApplyPatchOutcome = ApplyPatchSuccess | ApplyPatchRefusal;

// What a candidate record keeps: the tree and everything needed to associate it
// with its task and repository for a later publication (S2b). A candidate ID is
// never permission to publish.
export interface CandidateRecord {
  candidate_id: string;
  task_id: string;
  publication_id: string;
  repository: string;
  workspace: string;
  base_oid: string;
  tree_oid: string;
  patch_sha256: string;
  mode: string;
  artifact_path: string;
  changed_paths: string[];
  created_at: string;
}

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}
export interface GitInvocation {
  cwd: string;
  indexFile?: string;
  input?: Buffer;
}
export type GitRunner = (args: string[], inv: GitInvocation) => GitResult;

export interface ApplyPatchDeps {
  // Seam: the git runner. Production spawns the real `git`.
  git?: GitRunner;
  // Test seam: runs after the artifact's digest is verified and before the
  // VERIFIED BYTES are applied. A test replaces the artifact file here to prove
  // a reopened pathname is never applied.
  afterDigestVerified?: (bytes: Buffer, artifactPath: string) => void;
  beforeCandidateWrite?: (dir: string) => void;
  writeCandidateRecord?: (fd: number, data: string) => void;
  // Seam: the clock for the record timestamp.
  now?: () => Date;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const READ_MODES = new Set(["120000", "160000"]);

function sha256hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Allow only the launcher paths and fixed Git settings.
function runGit(args: string[], inv: GitInvocation): GitResult {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  if (inv.indexFile !== undefined) env.GIT_INDEX_FILE = inv.indexFile;
  const r = spawnSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd: inv.cwd,
    env,
    input: inv.input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    return { status: -1, stdout: "", stderr: r.error.message };
  }
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

function refuse(
  reason: ApplyRefusalReason,
  message: string,
  detail?: Record<string, unknown>,
): ApplyPatchRefusal {
  return detail === undefined
    ? { ok: false, reason, message }
    : { ok: false, reason, message, detail };
}

// Categorize a failed `git apply` from its output. The order matters: an unsafe
// path also makes git report "no valid patches", so it is checked first.
function applyFailureReason(stderr: string): ApplyRefusalReason {
  if (/invalid path|outside repository/i.test(stderr)) return "unsafe_git_path";
  if (
    /corrupt patch|unrecognized input|no valid patches in input|patch fragment without header|bad input|unexpected end of file/i.test(
      stderr,
    )
  ) {
    return "malformed_patch";
  }
  return "patch_does_not_apply";
}

// Resolve the artifact path and confine it to the task's artifact root: the
// realpath of the path must lie under the realpath of the root, and be a
// regular file. Returns the canonical path, or a refusal.
function resolveArtifactPath(
  binding: TaskBinding,
  rawPath: string,
): { ok: true; path: string } | ApplyPatchRefusal {
  let root: string;
  try {
    root = realpathSync(binding.artifact_root);
  } catch {
    return refuse(
      "unsafe_artifact_path",
      `apply_patch refused: the task's artifact root ${binding.artifact_root} cannot be resolved, so no artifact under it can be trusted.`,
    );
  }
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return refuse(
      "artifact_missing",
      `apply_patch refused: the patch artifact ${rawPath} does not exist (or its symlinks cannot be resolved).`,
    );
  }
  if (real !== root && !real.startsWith(root + sep)) {
    return refuse(
      "unsafe_artifact_path",
      `apply_patch refused: the patch artifact ${rawPath} resolves to ${real}, outside the task's artifact root ${root}.`,
    );
  }
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(real);
  } catch {
    return refuse(
      "artifact_missing",
      `apply_patch refused: the patch artifact ${rawPath} cannot be stat-ed.`,
    );
  }
  if (!st.isFile()) {
    return refuse(
      "artifact_missing",
      `apply_patch refused: the patch artifact ${rawPath} is not a regular file.`,
    );
  }
  return { ok: true, path: real };
}

interface ChangedEntry {
  oldMode: string;
  newMode: string;
  path: string;
}

// Parse `git diff-tree --raw` output between the base tree and the result.
function parseDiffTree(out: string): ChangedEntry[] | null {
  const entries: ChangedEntry[] = [];
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\t(.*)$/.exec(line);
    if (!m) return null;
    entries.push({ oldMode: m[1], newMode: m[2], path: m[3] });
  }
  return entries;
}

export interface ApplyPatchInput {
  // The binding this session retained, or undefined when there is none.
  binding: TaskBinding | undefined;
  // When the binding was present but malformed, the parse error's message.
  bindingError?: string;
  params: ApplyPatchParams;
  // The tool-owned state root (the JobManager's).
  stateRoot: string;
  deps?: ApplyPatchDeps;
}

export function applyPatch(input: ApplyPatchInput): ApplyPatchOutcome {
  const { binding, params, stateRoot } = input;
  const deps = input.deps ?? {};
  const git = deps.git ?? runGit;

  if (input.bindingError !== undefined) {
    return refuse("invalid_binding", `apply_patch refused: ${input.bindingError}`);
  }
  if (binding === undefined) {
    return refuse(
      "unknown_task",
      "apply_patch refused: this session holds no task binding, so there is no task, base or artifact root to apply against. A task binding is supplied by the launcher, not by a tool argument, a file or bob.yaml.",
    );
  }

  // Validate the request against the binding. pi's schema already checks the
  // shapes; these checks make a directly-driven call refuse too.
  const artifact = params?.patch_artifact;
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    typeof artifact.path !== "string" ||
    artifact.path.length === 0
  ) {
    return refuse("unsafe_artifact_path", "apply_patch refused: patch_artifact.path is required.");
  }
  if (typeof artifact.sha256 !== "string" || !HEX64.test(artifact.sha256.toLowerCase())) {
    return refuse(
      "digest_mismatch",
      "apply_patch refused: patch_artifact.sha256 must be the artifact's lowercase sha256 digest.",
    );
  }
  const expectedBase = params?.expected_base;
  if (typeof expectedBase !== "string" || !HEX40.test(expectedBase)) {
    return refuse(
      "invalid_base",
      "apply_patch refused: expected_base must be the full 40-character Git commit object ID of the task's pinned base.",
    );
  }
  if (expectedBase !== binding.base_oid) {
    return refuse(
      "base_mismatch",
      `apply_patch refused: expected_base ${expectedBase} is not the task's pinned base ${binding.base_oid}. A patch must be applied to the base it was built on.`,
    );
  }

  // Read the artifact ONCE and verify its digest; the verified bytes below are
  // what is applied, never a reopened pathname.
  const resolved = resolveArtifactPath(binding, artifact.path);
  if (!resolved.ok) return resolved;
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved.path);
  } catch {
    return refuse(
      "artifact_missing",
      `apply_patch refused: the patch artifact ${artifact.path} could not be read.`,
    );
  }
  const digest = sha256hex(bytes);
  if (digest !== artifact.sha256.toLowerCase()) {
    return refuse(
      "digest_mismatch",
      `apply_patch refused: the patch artifact ${artifact.path} has sha256 ${digest}, not the expected ${artifact.sha256.toLowerCase()}.`,
    );
  }
  if (
    binding.mode === "apply" &&
    binding.patch_sha256 !== undefined &&
    digest !== binding.patch_sha256
  ) {
    return refuse(
      "digest_mismatch",
      `apply_patch refused: the patch artifact ${artifact.path} has sha256 ${digest}, not the task-authorized ${binding.patch_sha256}. In apply mode only the authorized artifact may be used.`,
    );
  }

  deps.afterDigestVerified?.(bytes, resolved.path);

  // The state root must lie outside the caller's checkout and be owner-only:
  // the two checks `run` makes before it writes under its own state root
  // (run.ts ensurePrivateDir). A root inside the workspace or the repository is
  // refused, as is one that is a symlink, a file, another account's directory,
  // or a directory with any group or world permission bit.
  const inside = (
    [
      [binding.workspace, "the workspace"],
      [binding.repository, "the repository"],
    ] as Array<[string, string]>
  ).filter(([root]) => isInside(root, stateRoot));
  if (inside.length > 0) {
    return refuse(
      "storage_failed",
      `apply_patch refused: the tool state directory ${stateRoot} is inside ${inside
        .map(([root, what]) => `${what} ${root}`)
        .join(
          " and ",
        )}, where the candidate record and the scratch index would become stray files in the caller's checkout. Run bob with a temp directory (TMPDIR) outside the workspace and the repository.`,
    );
  }
  try {
    ensurePrivateDir(stateRoot, true);
  } catch (err) {
    return refuse(
      "storage_failed",
      `apply_patch refused: ${err instanceof Error ? err.message.replace(/^run refused: /, "") : String(err)}`,
    );
  }

  let scratchDir: string;
  try {
    scratchDir = mkdtempSync(join(stateRoot, "apply-"));
  } catch {
    return refuse(
      "storage_failed",
      `apply_patch refused: could not create the tool's scratch directory under ${stateRoot}.`,
    );
  }
  const indexFile = join(scratchDir, "index");
  const cleanupScratch = (): ApplyPatchRefusal | undefined => {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
      try {
        lstatSync(scratchDir);
        throw new Error("scratch directory still exists");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    } catch (err) {
      return refuse(
        "storage_failed",
        `apply_patch refused: scratch cleanup failed at ${scratchDir} (${err instanceof Error ? err.message : String(err)}). No candidate was stored.`,
        { cleanup: "failed", scratch_path: scratchDir },
      );
    }
    return undefined;
  };

  const prepare = ():
    | ApplyPatchRefusal
    | { record: CandidateRecord; success: ApplyPatchSuccess } => {
    // Fresh, tool-owned index initialized from the pinned base. The caller's
    // index file is never touched: every index-touching call names THIS file.
    const read = git(["read-tree", binding.base_oid], { cwd: binding.repository, indexFile });
    if (read.status !== 0) {
      if (
        /not a valid object|failed to unpack tree|bad object|unknown revision/i.test(read.stderr)
      ) {
        return refuse(
          "invalid_base",
          `apply_patch refused: the pinned base ${binding.base_oid} cannot be read from ${binding.repository} (${read.stderr.trim()}).`,
        );
      }
      return refuse(
        "apply_failed",
        `apply_patch refused: could not initialize the index from base ${binding.base_oid} (${read.stderr.trim() || `git exited ${read.status}`}).`,
      );
    }

    const applied = git(["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], {
      cwd: binding.repository,
      indexFile,
      input: bytes,
    });
    if (applied.status !== 0) {
      const reason = applyFailureReason(applied.stderr);
      return refuse(
        reason,
        `apply_patch refused: the patch did not apply to base ${binding.base_oid} (${applied.stderr.trim() || `git exited ${applied.status}`}). Nothing was applied; the caller's checkout is untouched.`,
      );
    }

    const written = git(["write-tree"], { cwd: binding.repository, indexFile });
    if (written.status !== 0) {
      return refuse(
        "apply_failed",
        `apply_patch refused: could not write the resulting tree (${written.stderr.trim() || `git exited ${written.status}`}).`,
      );
    }
    const treeOid = written.stdout.trim();
    if (!HEX40.test(treeOid)) {
      return refuse(
        "apply_failed",
        `apply_patch refused: the written tree id ${JSON.stringify(treeOid)} is not a 40-character object ID.`,
      );
    }
    // Apply mode pins the result as well as the artifact: an authorized patch
    // whose verified bytes produce another tree is not the change the task
    // authorized.
    if (
      binding.mode === "apply" &&
      binding.expected_tree_oid !== undefined &&
      treeOid !== binding.expected_tree_oid
    ) {
      return refuse(
        "tree_mismatch",
        `apply_patch refused: the patch's result tree ${treeOid} is not the tree the task pins ${binding.expected_tree_oid}. No candidate was stored; the caller's checkout is untouched.`,
      );
    }

    const diff = git(["diff-tree", "-r", "--no-renames", "--raw", binding.base_oid, treeOid], {
      cwd: binding.repository,
    });
    if (diff.status !== 0) {
      return refuse(
        "apply_failed",
        `apply_patch refused: could not read the patch's effect (${diff.stderr.trim() || `git exited ${diff.status}`}).`,
      );
    }
    const entries = parseDiffTree(diff.stdout);
    if (entries === null) {
      return refuse(
        "apply_failed",
        "apply_patch refused: git diff-tree output could not be parsed.",
      );
    }
    // A symlink or a submodule (gitlink) change is refused explicitly: the
    // patch applied to the fresh index, so nothing is left in the caller's
    // checkout, but no candidate is stored.
    const unsupported = entries.filter(
      (e) => READ_MODES.has(e.oldMode) || READ_MODES.has(e.newMode),
    );
    if (unsupported.length > 0) {
      return refuse(
        "unsupported_entry_type",
        `apply_patch refused: the patch changes a symlink or submodule (${unsupported.map((e) => e.path).join(", ")}). Those entry types are not applied. No candidate was stored; the caller's checkout is untouched.`,
      );
    }

    const changedPaths = entries.map((e) => e.path);
    const candidateId = sha256hex(
      Buffer.from(
        [
          binding.task_id,
          binding.publication_id,
          binding.repository,
          binding.base_oid,
          treeOid,
          digest,
        ].join("\0"),
      ),
    ).slice(0, 40);

    const record: CandidateRecord = {
      candidate_id: candidateId,
      task_id: binding.task_id,
      publication_id: binding.publication_id,
      repository: binding.repository,
      workspace: binding.workspace,
      base_oid: binding.base_oid,
      tree_oid: treeOid,
      patch_sha256: digest,
      mode: binding.mode,
      artifact_path: resolved.path,
      changed_paths: changedPaths,
      created_at: (deps.now?.() ?? new Date()).toISOString(),
    };
    return {
      record,
      success: {
        ok: true,
        candidate_id: candidateId,
        base_oid: binding.base_oid,
        patch_sha256: digest,
        tree_oid: treeOid,
        changed_paths: changedPaths,
      },
    };
  };
  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare();
  } catch (err) {
    prepared = refuse(
      "apply_failed",
      `apply_patch refused: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const cleanup = cleanupScratch();
  if (cleanup !== undefined) return cleanup;
  if ("ok" in prepared) return prepared;
  const store = storeCandidate(stateRoot, prepared.record, deps);
  return store.ok ? prepared.success : store;
}

function openCandidateDir(
  dir: string,
): { ok: true; fd: number; dev: bigint; ino: bigint } | ApplyPatchRefusal {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return refuse(
        "storage_failed",
        `apply_patch refused: the candidate directory ${dir} could not be created (${(err as NodeJS.ErrnoException).code ?? "error"}).`,
      );
    }
  }
  let fd: number | undefined;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const pin = fstatSync(fd, { bigint: true });
    if (!pin.isDirectory()) {
      throw new Error("not a directory");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && pin.uid !== BigInt(uid)) {
      throw new Error(`owned by uid ${pin.uid}, not this user (${uid})`);
    }
    if ((pin.mode & 0o077n) !== 0n) {
      throw new Error(`mode ${(pin.mode & 0o777n).toString(8)} permits group or other access`);
    }
    return { ok: true, fd, dev: pin.dev, ino: pin.ino };
  } catch (err) {
    let leftover = "";
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (cerr) {
        leftover = `; directory close failed (${cerr instanceof Error ? cerr.message : String(cerr)})`;
      }
    }
    return refuse(
      "storage_failed",
      `apply_patch refused: the candidate directory ${dir} could not be pinned (${err instanceof Error ? err.message : String(err)})${leftover}.`,
    );
  }
}

function storeCandidate(
  stateRoot: string,
  record: CandidateRecord,
  deps: ApplyPatchDeps,
): { ok: true } | ApplyPatchRefusal {
  let rootPin: { dev: bigint; ino: bigint };
  try {
    ensurePrivateDir(stateRoot, false);
    rootPin = lstatSync(stateRoot, { bigint: true });
  } catch (err) {
    return refuse(
      "storage_failed",
      `apply_patch refused: state directory could not be pinned (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  const dir = join(stateRoot, "candidates");
  const opened = openCandidateDir(dir);
  if (!opened.ok) return opened;
  const finalPath = join(dir, `${record.candidate_id}.json`);
  let stagingDir: string | undefined;
  let stagingPin: { dev: bigint; ino: bigint } | undefined;
  let fd: number | undefined;
  let dirFd: number | undefined = opened.fd;
  let renamed = false;
  const checkDirectories = () => {
    const root = lstatSync(stateRoot, { bigint: true });
    ensurePrivateDir(stateRoot, false);
    if (root.dev !== rootPin.dev || root.ino !== rootPin.ino) {
      throw new Error("the state directory changed after it was pinned");
    }
    const after = lstatSync(dir, { bigint: true });
    if (!after.isDirectory() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("the candidate directory changed after it was pinned");
    }
  };
  try {
    deps.beforeCandidateWrite?.(dir);
    checkDirectories();
    stagingDir = mkdtempSync(join(dir, ".tmp-"));
    const createdStage = lstatSync(stagingDir, { bigint: true });
    if (!createdStage.isDirectory()) throw new Error("staging is not a directory");
    stagingPin = createdStage;
    const tmpPath = join(stagingDir, "record.json");
    fd = openSync(
      tmpPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    (deps.writeCandidateRecord ?? writeFileSync)(fd, `${JSON.stringify(record, null, 2)}\n`);
    const recordPin = fstatSync(fd, { bigint: true });
    if (!recordPin.isFile()) throw new Error("the written descriptor is not a regular file");
    const writtenFd = fd;
    fd = undefined;
    closeSync(writtenFd);
    checkDirectories();
    const stage = lstatSync(stagingDir, { bigint: true });
    if (!stage.isDirectory() || stage.dev !== stagingPin.dev || stage.ino !== stagingPin.ino) {
      throw new Error("the staging directory changed after it was pinned");
    }
    const source = lstatSync(tmpPath, { bigint: true });
    if (!source.isFile() || source.dev !== recordPin.dev || source.ino !== recordPin.ino) {
      throw new Error("the staging record changed after it was written");
    }
    renameSync(tmpPath, finalPath);
    renamed = true;
    const published = lstatSync(finalPath, { bigint: true });
    if (!published.isFile() || published.dev !== recordPin.dev || published.ino !== recordPin.ino) {
      throw new Error("the published record differs from the written descriptor");
    }
    checkDirectories();
    rmdirSync(stagingDir);
    stagingDir = undefined;
    const pinnedFd = dirFd;
    dirFd = undefined;
    closeSync(pinnedFd);
    return { ok: true };
  } catch (err) {
    let leftover = "";
    for (const path of [renamed ? finalPath : undefined, stagingDir]) {
      if (path === undefined) continue;
      try {
        checkDirectories();
        if (path === stagingDir && stagingPin !== undefined) {
          const stage = lstatSync(path, { bigint: true });
          if (
            !stage.isDirectory() ||
            stage.dev !== stagingPin.dev ||
            stage.ino !== stagingPin.ino
          ) {
            throw new Error("staging identity changed; cleanup skipped");
          }
        }
        rmSync(path, { recursive: path === stagingDir, force: true });
      } catch (rerr) {
        leftover += `; ${path} could not be removed (${rerr instanceof Error ? rerr.message : String(rerr)})`;
      }
    }
    for (const remainingFd of [fd, dirFd]) {
      if (remainingFd === undefined) continue;
      try {
        closeSync(remainingFd);
      } catch (cerr) {
        leftover += `; descriptor close failed (${cerr instanceof Error ? cerr.message : String(cerr)})`;
      }
    }
    return refuse(
      "storage_failed",
      `apply_patch refused: the candidate could not be stored under ${dir} (${err instanceof Error ? err.message : String(err)})${leftover}.`,
    );
  }
}

// Where a candidate's record lives, for a later publication to read (S2b).
export function candidateRecordPath(stateRoot: string, candidateId: string): string {
  return join(stateRoot, "candidates", `${candidateId}.json`);
}
