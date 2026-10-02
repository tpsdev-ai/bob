import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { gitEnvironment } from "./git-environment.js";
import { TOOL_EFFECTS } from "./tool-allowlist.js";

// Writer effects that run a command or a request rather than editing a file.
const COMMAND_RUNNER_TOOLS: ReadonlySet<string> = new Set(["run", "bash", "powershell"]);

/** True when the name is a write-class FILE-EDIT tool. */
export function isFileEditTool(toolName: string): boolean {
  return (
    Object.hasOwn(TOOL_EFFECTS, toolName) &&
    TOOL_EFFECTS[toolName] === "writer" &&
    !COMMAND_RUNNER_TOOLS.has(toolName)
  );
}

export function hasEditSuccessEvidence(toolName: string, result: unknown): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const output = result as { details?: unknown; content?: unknown };
  if (!Array.isArray(output.content) || output.content.length === 0) return false;
  for (const block of output.content) {
    if (
      block === null ||
      typeof block !== "object" ||
      Array.isArray(block) ||
      block.type !== "text" ||
      typeof block.text !== "string" ||
      block.text.trim().length === 0
    )
      return false;
  }
  if (
    output.details !== undefined &&
    (output.details === null || typeof output.details !== "object" || Array.isArray(output.details))
  )
    return false;
  const details = output.details as Record<string, unknown> | undefined;
  // A refusal is not an edit, whatever else the result carries.
  if (details?.refused) return false;
  switch (toolName) {
    case "edit_lines":
    case "insert_after":
      return (
        typeof details?.fingerprint === "string" &&
        /^F#[0-9a-f]{16}$/.test(details.fingerprint) &&
        Number.isSafeInteger(details.lineDelta)
      );
    case "write_file":
      return (
        typeof details?.fingerprint === "string" &&
        /^F#[0-9a-f]{16}$/.test(details.fingerprint) &&
        typeof details.bytes === "number" &&
        Number.isSafeInteger(details.bytes) &&
        details.bytes >= 0
      );
    case "edit":
      return typeof details?.diff === "string" && details.diff.trim().length > 0;
    case "write":
    case "replace_lines": {
      const success =
        toolName === "write"
          ? /^Successfully wrote \d+ bytes to [\s\S]+$/
          : /^Replaced lines [1-9]\d*-[1-9]\d* in [\s\S]+\.$/;
      return output.content.some((block) => success.test(block.text));
    }
    default:
      return false;
  }
}

interface RepositoryIdentity {
  workTree: string;
  gitDir: string;
}

export type RepositoryState =
  | ({ kind: "git"; head: string; trackedHash: string } & RepositoryIdentity)
  | { kind: "not a git work tree" | "unavailable" };

export interface RepositoryEditEvidence {
  cwd: string;
  before: RepositoryState;
  after: RepositoryState;
}

function git(cwd: string, args: string[], repository?: RepositoryIdentity) {
  return spawnSync(
    "git",
    [
      "--no-replace-objects",
      "-c",
      "core.abbrev=no",
      "-c",
      "core.quotePath=false",
      "-c",
      "core.fsmonitor=false",
      ...(repository
        ? [`--git-dir=${repository.gitDir}`, `--work-tree=${repository.workTree}`]
        : []),
      ...args,
    ],
    {
      cwd,
      env: gitEnvironment(),
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function readGit(cwd: string, args: string[], repository?: RepositoryIdentity): Buffer {
  const result = git(cwd, args, repository);
  if (result.error || result.status !== 0) throw new Error("git evidence unavailable");
  return result.stdout;
}

function gitLine(cwd: string, args: string[], repository?: RepositoryIdentity): string {
  const output = readGit(cwd, args, repository).toString();
  if (!output.endsWith("\n")) throw new Error("incomplete git output");
  return output.slice(0, -1);
}

function resolveRepository(cwd: string): RepositoryIdentity {
  return {
    workTree: realpathSync(gitLine(cwd, ["rev-parse", "--show-toplevel"])),
    gitDir: realpathSync(gitLine(cwd, ["rev-parse", "--absolute-git-dir"])),
  };
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.workTree === right.workTree && left.gitDir === right.gitDir;
}

type TrackedEntry = { mode: string; object: string };

function trackedEntries(output: Buffer, tree: boolean): Map<string, TrackedEntry> {
  const entries = new Map<string, TrackedEntry>();
  const records = output.toString("latin1").split("\0");
  if (records.pop() !== "") throw new Error("incomplete tracked listing");
  for (const record of records) {
    const tab = record.indexOf("\t");
    const fields = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    const [mode, object] = tree ? [fields[0], fields[2]] : fields;
    if (
      tab < 0 ||
      fields.length !== 3 ||
      !/^(100644|100755|120000|160000)$/.test(mode) ||
      !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(object) ||
      (!tree && fields[2] !== "0") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("unsupported tracked entry");
    entries.set(path, { mode, object });
  }
  return entries;
}

function trackedFingerprint(repository: RepositoryIdentity, head: string): string {
  const { workTree } = repository;
  const tree = trackedEntries(
    readGit(workTree, ["ls-tree", "-r", "-z", "--full-tree", head], repository),
    true,
  );
  const index = trackedEntries(
    readGit(workTree, ["ls-files", "--stage", "-z", "--full-name"], repository),
    false,
  );
  const hash = createHash("sha256");
  const paths = [...new Set([...tree.keys(), ...index.keys()])].sort();
  for (const path of paths) {
    const name = Buffer.from(path, "latin1");
    const absolute = Buffer.concat([Buffer.from(`${workTree}/`), name]);
    const baseline = tree.get(path);
    let mode = "deleted";
    let bytes = Buffer.alloc(0);
    let object = "";
    let stat: Stats | undefined;
    let fd: number | undefined;
    try {
      try {
        fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (code === "ELOOP") stat = lstatSync(absolute);
        else if (!["ENOENT", "ENOTDIR"].includes(code)) throw error;
      }
      if (fd !== undefined) stat = fstatSync(fd);
      if (stat?.isSymbolicLink()) {
        mode = "120000";
        bytes = readlinkSync(absolute, { encoding: "buffer" });
      } else if (fd !== undefined && stat?.isFile()) {
        mode = stat.mode & 0o111 ? "100755" : "100644";
        bytes = readFileSync(fd);
      } else if (stat?.isDirectory() && (index.get(path) ?? baseline)?.mode === "160000") {
        mode = "160000";
        const childPath = absolute.toString();
        if (!Buffer.from(childPath).equals(absolute)) throw new Error("unsupported submodule path");
        const child = resolveRepository(childPath);
        object =
          child.workTree === realpathSync(childPath)
            ? gitLine(childPath, ["rev-parse", "--verify", "HEAD^{commit}"], child)
            : ((index.get(path) ?? baseline)?.object ?? "");
        bytes = Buffer.from(object);
      } else if (stat) {
        throw new Error("unsupported tracked file type");
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (mode !== "deleted" && mode !== "160000") {
      object = createHash(head.length === 64 ? "sha256" : "sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
    }
    if (baseline?.mode === mode && baseline.object === object) continue;
    if (!baseline && mode === "deleted") continue;
    hash
      .update(name)
      .update("\0")
      .update(mode)
      .update("\0")
      .update(createHash("sha256").update(bytes).digest())
      .update("\0");
  }
  return hash.digest("hex");
}

export function captureRepositoryState(cwd: string, launch?: RepositoryState): RepositoryState {
  if (launch && launch.kind !== "git") return { kind: "unavailable" };
  try {
    const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (
      !inside.error &&
      ((inside.status === 0 && inside.stdout.toString().trim() === "false") ||
        (inside.status === 128 && inside.stderr.toString().includes("not a git repository")))
    ) {
      return { kind: "not a git work tree" };
    }
    if (inside.error || inside.status !== 0 || inside.stdout.toString().trim() !== "true") {
      return { kind: "unavailable" };
    }
    const repository = resolveRepository(cwd);
    if (launch?.kind === "git" && !sameRepository(launch, repository))
      return { kind: "unavailable" };
    const head = gitLine(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], repository);
    const trackedHash = trackedFingerprint(repository, head);
    if (
      gitLine(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], repository) !== head ||
      !sameRepository(repository, resolveRepository(cwd))
    )
      return { kind: "unavailable" };
    return { kind: "git", ...repository, head, trackedHash };
  } catch {
    return { kind: "unavailable" };
  }
}

export function isVerifiedEdit(
  toolName: string,
  isError: unknown,
  result: unknown,
  repository?: RepositoryEditEvidence,
): boolean {
  if (isError === false && isFileEditTool(toolName) && hasEditSuccessEvidence(toolName, result)) {
    return true;
  }
  if (repository?.before.kind !== "git" || repository.after.kind !== "git") return false;
  const { cwd, before, after } = repository;
  try {
    if (!sameRepository(before, after) || !sameRepository(before, resolveRepository(cwd)))
      return false;
    const committedChange =
      before.head !== after.head &&
      readGit(cwd, ["rev-list", "--max-count=1", after.head, `^${before.head}`, "--"], before)
        .length > 0 &&
      !readGit(cwd, ["rev-parse", "--verify", `${before.head}^{tree}`], before).equals(
        readGit(cwd, ["rev-parse", "--verify", `${after.head}^{tree}`], before),
      );
    return committedChange || before.trackedHash !== after.trackedHash;
  } catch {
    return false;
  }
}
