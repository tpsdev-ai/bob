import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkRoot } from "../../src/shell/bob-yaml.js";
import { runDoctor } from "../../src/shell/doctor.js";
import {
  captureWorkRootSnapshot,
  countWorkRootTrees,
  isWorkRootEditVerified,
  type WorkRootCaptureOptions,
  type WorkRootLaunchSnapshot,
} from "../../src/shell/edit-evidence.js";
import { type RunSession, resolveRunConfig, runAgent } from "../../src/shell/run.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 5_000,
  }).trim();
}

function commit(cwd: string): string {
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "fixture");
  return git(cwd, "rev-parse", "HEAD");
}

function init(cwd: string): string {
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--quiet");
  writeFileSync(join(cwd, "tracked"), "original\n");
  git(cwd, "add", ".");
  const tree = git(cwd, "write-tree");
  const head = git(cwd, "commit-tree", tree, "-m", "seed");
  git(cwd, "reset", "--hard", head);
  return head;
}

function seedSuccessor(cwd: string): string {
  git(cwd, "add", ".");
  const head = git(
    cwd,
    "commit-tree",
    git(cwd, "write-tree"),
    "-p",
    git(cwd, "rev-parse", "HEAD"),
    "-m",
    "seed",
  );
  git(cwd, "reset", "--hard", head);
  return head;
}

function snapshotRoot(root: string, options?: WorkRootCaptureOptions): WorkRootLaunchSnapshot {
  const snapshot = captureWorkRootSnapshot(root, options);
  if (!snapshot) throw new Error("fixture root could not be captured");
  return snapshot;
}

type Call = {
  toolName: string;
  action?: () => void;
};

function session(calls: Call[]): RunSession {
  const listeners = new Set<(event: never) => void>();
  const emit = (event: unknown) => {
    for (const listener of listeners) listener(event as never);
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const [i, call] of calls.entries()) {
        const toolCallId = `call-${i}`;
        emit({
          type: "tool_execution_start",
          toolName: call.toolName,
          toolCallId,
          args: { i },
        });
        call.action?.();
        emit({
          type: "tool_execution_end",
          toolName: call.toolName,
          toolCallId,
          isError: false,
          result: { content: [{ type: "text", text: "DONE: finished." }] },
        });
      }
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "DONE: finished." }],
          stopReason: "stop",
        },
      });
    },
    async steer() {},
    async abort() {},
    dispose() {},
  };
}

describe("edit evidence under a declared work root", () => {
  let agentsRoot: string;
  let cwd: string;
  let workRoot: string;

  const writeConfig = (workRootLine: string) => {
    writeFileSync(
      join(agentsRoot, "builder", "bob.yaml"),
      [
        "agent:",
        "  id: builder",
        "  name: builder",
        "  role: builder-local",
        "provider:",
        "  name: anthropic",
        "  model: claude-sonnet-4-6",
        workRootLine,
        "tools:",
        "  allow:",
        "    - run",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  };

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-work-root-"));
    cwd = join(agentsRoot, "builder", "work");
    workRoot = join(agentsRoot, "tasks");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(agentsRoot, "builder", ".pi-agent"));
    mkdirSync(workRoot);
    writeFileSync(join(agentsRoot, "builder", "soul.md"), "Build the task.");
    writeConfig(`work_root: ${workRoot}`);
  });

  afterEach(() => rmSync(agentsRoot, { recursive: true, force: true }));

  const run = (calls: Call[]) =>
    runAgent({
      name: "builder",
      agentsRoot,
      prompt: "Edit the task repository.",
      explorationBudget: 20,
      sessionFactory: async () => session(calls),
    });

  it("credits a commit in an existing work tree under the root", async () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          writeFileSync(join(repo, "tracked"), "edited\n");
          seedSuccessor(repo);
        },
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  });

  it("credits a content commit in a new work tree", async () => {
    const source = join(agentsRoot, "source");
    init(source);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          execFileSync("git", ["clone", "--quiet", source, join(workRoot, "fresh")], {
            env: gitEnv,
            stdio: "pipe",
            timeout: 5_000,
          });
          writeFileSync(join(workRoot, "fresh", "tracked"), "fresh edit\n");
          commit(join(workRoot, "fresh"));
        },
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  }, 20_000);

  it("does not credit a fresh clone of a future-dated commit", async () => {
    const source = join(agentsRoot, "source");
    init(source);
    const future = execFileSync(
      "git",
      ["commit-tree", git(source, "write-tree"), "-m", "future seed"],
      {
        cwd: source,
        env: { ...gitEnv, GIT_COMMITTER_DATE: `@${Math.floor(Date.now() / 1000) + 3600} +0000` },
        encoding: "utf8",
        stdio: "pipe",
      },
    ).trim();
    git(source, "reset", "--hard", future);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          execFileSync("git", ["clone", "--quiet", source, join(workRoot, "old")], {
            env: gitEnv,
            stdio: "pipe",
            timeout: 5_000,
          });
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("does not credit a diff that existed before launch and did not change", async () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    writeFileSync(join(repo, "tracked"), "pre-existing\n");
    const result = await run([{ toolName: "run" }]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("keeps cwd-only behaviour when work_root is unset", async () => {
    writeConfig("");
    init(cwd);
    const inCwd = await run([
      {
        toolName: "run",
        action: () => {
          writeFileSync(join(cwd, "tracked"), "cwd edit\n");
          seedSuccessor(cwd);
        },
      },
    ]);
    expect(inCwd.exitCode).toBe(0);

    const repo = join(workRoot, "alpha");
    init(repo);
    const ignored = await run([
      {
        toolName: "run",
        action: () => {
          writeFileSync(join(repo, "tracked"), "elsewhere\n");
          seedSuccessor(repo);
        },
      },
    ]);
    expect(ignored.exitCode).toBe(1);
    expect(ignored.noEditNoBlocked).toBe(true);
  });

  it("does not credit a work tree whose launch capture fails", () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    const index = join(repo, ".git", "index");
    renameSync(index, `${index}.saved`);
    mkdirSync(index);
    const snapshot = captureWorkRootSnapshot(workRoot);
    expect(snapshot?.trees.get("alpha")?.kind).toBe("unknown");
    rmSync(index, { recursive: true });
    renameSync(`${index}.saved`, index);
    writeFileSync(join(repo, "tracked"), "edited\n");
    if (!snapshot) throw new Error("fixture root could not be captured");
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("does not credit an empty commit in an existing work tree", async () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          seedSuccessor(repo);
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("does not credit an older clone swapped in under the same name", async () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    const older = join(agentsRoot, "older");
    git(agentsRoot, "clone", "--quiet", repo, older);
    writeFileSync(join(repo, "tracked"), "newer\n");
    seedSuccessor(repo);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          renameSync(repo, join(agentsRoot, "original"));
          renameSync(older, repo);
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("does not credit a different git directory with a descendant HEAD", () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    const snapshot = snapshotRoot(workRoot);
    const replacement = join(agentsRoot, "replacement");
    git(agentsRoot, "clone", "--quiet", repo, replacement);
    writeFileSync(join(replacement, "tracked"), "descendant\n");
    seedSuccessor(replacement);
    renameSync(repo, join(agentsRoot, "original"));
    renameSync(replacement, repo);
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("does not credit a non-ancestor HEAD in the same repository", () => {
    const repo = join(workRoot, "alpha");
    const older = init(repo);
    writeFileSync(join(repo, "tracked"), "newer\n");
    seedSuccessor(repo);
    const snapshot = snapshotRoot(workRoot);
    git(repo, "reset", "--hard", older);
    writeFileSync(join(repo, "tracked"), "uncommitted\n");
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("credits a tracked uncommitted change", async () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          writeFileSync(join(repo, "tracked"), "edited\n");
        },
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  });

  it("credits init and a content commit in an initially empty child directory", async () => {
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    expect(captureWorkRootSnapshot(workRoot)?.trees.get("alpha")?.kind).toBe("not a repo");
    const result = await run([
      {
        toolName: "run",
        action: () => {
          git(repo, "init", "--quiet");
          writeFileSync(join(repo, "tracked"), "initial content\n");
          commit(repo);
        },
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  });

  it("credits a content commit with a reflog time in the launch second", () => {
    const snapshot = snapshotRoot(workRoot);
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    writeFileSync(join(repo, "tracked"), "content\n");
    git(repo, "add", ".");
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: repo,
      env: { ...gitEnv, GIT_COMMITTER_DATE: `@${snapshot.launchedAtSeconds} +0000` },
      stdio: "pipe",
    });
    expect(git(repo, "reflog", "show", "--date=raw", "--format=%gD")).toContain(
      `@{${snapshot.launchedAtSeconds} +0000}`,
    );
    expect(isWorkRootEditVerified(snapshot)).toBe(true);
  });

  it("does not credit an empty root commit in a new repository", () => {
    const snapshot = snapshotRoot(workRoot);
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "empty");
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("does not credit an empty commit in a new clone", () => {
    const source = join(agentsRoot, "source");
    init(source);
    const snapshot = snapshotRoot(workRoot);
    const repo = join(workRoot, "alpha");
    git(agentsRoot, "clone", "--quiet", source, repo);
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "empty");
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("does not treat a shallow empty commit as a content-changing root", () => {
    const source = join(agentsRoot, "source");
    init(source);
    const snapshot = snapshotRoot(workRoot);
    const repo = join(workRoot, "alpha");
    git(agentsRoot, "clone", "--quiet", source, repo);
    const parent = git(repo, "rev-parse", "HEAD");
    const empty = git(repo, "commit-tree", git(repo, "write-tree"), "-p", parent, "-m", "empty");
    git(repo, "update-ref", "-m", "commit: empty fixture", "HEAD", empty, parent);
    writeFileSync(join(repo, ".git", "shallow"), `${empty}\n`);
    expect(git(repo, "rev-list", "--parents", "-n", "1", "HEAD")).toBe(empty);
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("records children beyond the directory bound as unknown in name order", () => {
    init(join(workRoot, "z-repo"));
    mkdirSync(join(workRoot, "a-empty"));
    const options = { maxChildDirectories: 1 };
    const snapshot = snapshotRoot(workRoot, options);
    expect([...snapshot.trees.keys()]).toEqual(["a-empty", "z-repo"]);
    expect(snapshot.trees.get("a-empty")?.kind).toBe("not a repo");
    expect(snapshot.trees.get("z-repo")?.kind).toBe("unknown");
    writeFileSync(join(workRoot, "z-repo", "tracked"), "edited\n");
    rmSync(join(workRoot, "a-empty"), { recursive: true });
    expect(isWorkRootEditVerified(snapshot, options)).toBe(false);
    expect(countWorkRootTrees(workRoot, options)).toEqual({
      childDirectories: 1,
      workTrees: 1,
      unknown: 0,
    });
  });

  it.each([
    ["plain", "work_root"],
    ["double-quoted", '"work_root"'],
    ["single-quoted", "'work_root'"],
    ["indented", "  work_root"],
  ])("resolves the %s YAML key from bob.yaml", (_label, key) => {
    writeConfig(`${key}: ${workRoot}`);
    if (key.startsWith("  ")) {
      const path = join(agentsRoot, "builder", "bob.yaml");
      // Indent the entire mapping to keep the key at the top level.
      const config = [
        "  agent:",
        "    id: builder",
        "    name: builder",
        "    role: builder-local",
        "  provider:",
        "    name: anthropic",
        "    model: claude-sonnet-4-6",
        `${key}: ${workRoot}`,
        "  tools:",
        "    allow: [run]",
      ].join("\n");
      writeFileSync(path, config);
    }
    expect(resolveRunConfig({ name: "builder", agentsRoot }).workRoot).toBe(workRoot);
  });

  it.each(["work_root", '"work_root"'])(
    "refuses a relative value for %s through resolveRunConfig",
    (key) => {
      writeConfig(`${key}: relative/tasks`);
      expect(() => resolveRunConfig({ name: "builder", agentsRoot })).toThrow(/absolute path/);
    },
  );

  it.each(["123", "false", "null", "[a]", "{path: a}"])(
    "refuses non-string work_root %s through resolveRunConfig",
    (value) => {
      writeConfig(`work_root: ${value}`);
      expect(() => resolveRunConfig({ name: "builder", agentsRoot })).toThrow(/one absolute path/);
    },
  );

  it("leaves workRoot absent when the YAML key is absent", () => {
    writeConfig("");
    expect(resolveRunConfig({ name: "builder", agentsRoot }).workRoot).toBeUndefined();
  });

  it("reports the child directories it would scan and current work trees", () => {
    init(join(workRoot, "alpha"));
    init(join(workRoot, "beta"));
    mkdirSync(join(workRoot, "empty"));
    const unborn = join(workRoot, "unborn");
    mkdirSync(unborn);
    git(unborn, "init", "--quiet");
    const report = runDoctor({
      name: "builder",
      agentsRoot,
      homeDir: agentsRoot,
      pathEnv: "",
    });
    const check = report.checks.find((entry) => entry.name === "work root");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain(workRoot);
    expect(check?.detail).toContain(
      "would scan 4 child directory(s); 3 are work trees now; 0 unknown",
    );
  });
});

describe("work_root config validation", () => {
  it("expands a leading ~/ and returns the absolute directory", () => {
    const home = mkdtempSync(join(tmpdir(), "bob-work-root-home-"));
    mkdirSync(join(home, "tasks"));
    try {
      expect(readWorkRoot("work_root: ~/tasks\n", home)).toBe(join(home, "tasks"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a relative path", () => {
    expect(() => readWorkRoot("work_root: relative/tasks\n")).toThrow(/absolute path/);
  });

  it("refuses a missing directory", () => {
    const missing = join(tmpdir(), `bob-work-root-missing-${process.pid}`);
    expect(() => readWorkRoot(`work_root: ${missing}\n`)).toThrow(/does not exist/);
  });

  it("refuses a path that is not a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "bob-work-root-file-"));
    const file = join(dir, "tasks");
    writeFileSync(file, "not a directory\n");
    try {
      expect(() => readWorkRoot(`work_root: ${file}\n`)).toThrow(/not a directory/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
