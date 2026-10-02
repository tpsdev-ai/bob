import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

export type RepositoryState =
  | { kind: "git"; head: string; diffHash: string }
  | { kind: "not a git work tree" | "unavailable" };

export interface RepositoryEditEvidence {
  cwd: string;
  before: RepositoryState;
  after: RepositoryState;
}

function git(cwd: string, args: string[]) {
  return spawnSync("git", ["--no-replace-objects", ...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function readGit(cwd: string, args: string[]): Buffer {
  const result = git(cwd, args);
  if (result.error || result.status !== 0) throw new Error("git evidence unavailable");
  return result.stdout;
}

export function captureRepositoryState(cwd: string): RepositoryState {
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
    const head = readGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim();
    const diff = readGit(cwd, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      "--no-relative",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--unified=0",
      "--inter-hunk-context=0",
      "--diff-algorithm=myers",
      "--no-indent-heuristic",
      "--ignore-submodules=dirty",
      "--submodule=short",
      head,
      "--",
    ]);
    if (readGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim() !== head) {
      return { kind: "unavailable" };
    }
    return { kind: "git", head, diffHash: createHash("sha256").update(diff).digest("hex") };
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
    const committedChange =
      before.head !== after.head &&
      readGit(cwd, ["rev-list", "--max-count=1", after.head, `^${before.head}`, "--"]).length > 0 &&
      !readGit(cwd, ["rev-parse", "--verify", `${before.head}^{tree}`]).equals(
        readGit(cwd, ["rev-parse", "--verify", `${after.head}^{tree}`]),
      );
    return committedChange || before.diffHash !== after.diffHash;
  } catch {
    return false;
  }
}
