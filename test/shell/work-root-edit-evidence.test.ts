import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkRoot } from "../../src/shell/bob-yaml.js";
import { runDoctor } from "../../src/shell/doctor.js";
import {
  captureWorkRootSnapshot,
  isWorkRootEditVerified,
  replacedCommitFromReflog,
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

describe("completion gate under a declared work root", () => {
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

  it("credits new tracked content committed in an existing work tree", async () => {
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

  it.each(["reset", "checkout"])(
    "does not credit %s to a descendant commit already in launch history",
    async (operation) => {
      const repo = join(workRoot, "alpha");
      const launchHead = init(repo);
      writeFileSync(join(repo, "tracked"), "pre-existing descendant\n");
      const descendant = seedSuccessor(repo);
      git(repo, "branch", "future", descendant);
      git(repo, "reset", "--hard", launchHead);
      const result = await run([
        {
          toolName: "run",
          action: () => {
            if (operation === "reset") git(repo, "reset", "--hard", descendant);
            else git(repo, "checkout", "--detach", descendant);
          },
        },
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.noEditNoBlocked).toBe(true);
    },
  );

  it("does not credit checkout of a non-descendant commit already in launch history", async () => {
    const repo = join(workRoot, "alpha");
    const parent = init(repo);
    writeFileSync(join(repo, "tracked"), "side branch\n");
    const side = seedSuccessor(repo);
    git(repo, "branch", "side", side);
    git(repo, "reset", "--hard", parent);
    writeFileSync(join(repo, "tracked"), "launch branch\n");
    seedSuccessor(repo);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          git(repo, "checkout", "--detach", side);
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("does not credit uncommitted tracked content already in launch history", async () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    writeFileSync(join(repo, "tracked"), "launch content\n");
    seedSuccessor(repo);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          writeFileSync(join(repo, "tracked"), "original\n");
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("does not credit tracked content when the launch history check was skipped", async () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    const brokenRef = join(repo, ".git", "refs", "heads", "broken");
    writeFileSync(brokenRef, `${"0".repeat(40)}\n`);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          rmSync(brokenRef);
          writeFileSync(join(repo, "tracked"), "new content\n");
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
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

  it("does not credit an amend in a fresh clone into an initially empty child", async () => {
    const source = join(agentsRoot, "source");
    init(source);
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    expect(captureWorkRootSnapshot(workRoot)?.trees.get("alpha")).toEqual({
      kind: "not a repo",
      emptyAtLaunch: true,
    });
    const result = await run([
      {
        toolName: "run",
        action: () => {
          git(agentsRoot, "clone", "--quiet", source, repo);
          git(repo, "commit", "--amend", "--quiet", "-m", "amended fixture");
        },
      },
    ]);
    expect(git(repo, "reflog", "show", "--format=%gs")).toContain(
      "commit (amend): amended fixture",
    );
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  }, 20_000);

  it("does not credit a no-op amend after its predecessor reflog entry is pruned", async () => {
    const source = join(agentsRoot, "source");
    init(source);
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    let replaced = "";
    const result = await run([
      {
        toolName: "run",
        action: () => {
          git(agentsRoot, "clone", "--quiet", source, repo);
          writeFileSync(join(repo, "tracked"), "replacement content\n");
          replaced = seedSuccessor(repo);
          git(repo, "commit", "--amend", "--quiet", "-m", "no-op amendment");
          const branch = git(repo, "symbolic-ref", "HEAD");
          git(repo, "reflog", "delete", `${branch}@{1}`);
          git(repo, "reflog", "delete", "HEAD@{1}");
        },
      },
    ]);
    expect(git(repo, "reflog", "show", "--format=%gs")).toContain(
      "commit (amend): no-op amendment",
    );
    expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(
      git(repo, "rev-parse", `${replaced}^{tree}`),
    );
    // HEAD@{1} resolution over a pruned reflog differs across Git versions.
    const surviving = git(repo, "reflog", "show", "--format=%H", "HEAD")
      .split("\n")
      .filter((entry) => entry.length > 0);
    expect(surviving.length).toBeGreaterThanOrEqual(2);
    const nextSurviving = surviving[1];
    expect(git(repo, "rev-parse", `${nextSurviving}^{tree}`)).not.toBe(
      git(repo, "rev-parse", "HEAD^{tree}"),
    );
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  }, 20_000);

  it("credits a changed-tree amend in a fresh clone into an initially empty child", async () => {
    const source = join(agentsRoot, "source");
    init(source);
    writeFileSync(join(source, "tracked"), "source content\n");
    seedSuccessor(source);
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          git(agentsRoot, "clone", "--quiet", source, repo);
          writeFileSync(join(repo, "tracked"), "original\n");
          git(repo, "add", ".");
          git(repo, "commit", "--amend", "--allow-empty", "--quiet", "-m", "amended fixture");
        },
      },
    ]);
    expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(git(repo, "rev-parse", "HEAD~1^{tree}"));
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  }, 20_000);

  it("credits a changed-tree amend in a detached linked worktree of a new child clone", async () => {
    const source = join(agentsRoot, "source");
    init(source);
    const repo = join(workRoot, "alpha");
    const linked = join(repo, "linked");
    const result = await run([
      {
        toolName: "run",
        action: () => {
          git(agentsRoot, "clone", "--quiet", source, repo);
          git(repo, "worktree", "add", "--quiet", "--detach", linked);
          writeFileSync(join(linked, "tracked"), "linked edit\n");
          git(linked, "add", ".");
          git(linked, "commit", "--amend", "--quiet", "-m", "linked amendment");
        },
      },
    ]);
    expect(git(repo, "reflog", "show", "--all", "--format=%gD")).toContain(
      "worktrees/linked/HEAD@{",
    );
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  }, 20_000);

  it("credits a detached main-worktree amend from a new linked child", async () => {
    const source = join(agentsRoot, "source");
    init(source);
    const repo = join(agentsRoot, "clone");
    const linked = join(workRoot, "linked");
    const result = await run([
      {
        toolName: "run",
        action: () => {
          git(agentsRoot, "clone", "--quiet", source, repo);
          git(repo, "checkout", "--detach", "--quiet");
          git(repo, "worktree", "add", "--quiet", "--detach", linked);
          writeFileSync(join(repo, "tracked"), "main edit\n");
          git(repo, "add", ".");
          git(repo, "commit", "--amend", "--quiet", "-m", "main amendment");
        },
      },
    ]);
    expect(git(linked, "reflog", "show", "--all", "--format=%gD")).toContain(
      "main-worktree/HEAD@{",
    );
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  }, 20_000);

  it("bounds slow eligible reflog entries by the child's scan budget without credit", () => {
    const snapshot = snapshotRoot(workRoot);
    const repo = join(workRoot, "alpha");
    const head = init(repo);
    const spawn = childProcess.spawnSync;
    const timeouts: number[] = [];
    let elapsed = 0;
    let eligibleEntries = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
    const probe = spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
      const result = spawn(...args);
      const command = args[1] as string[];
      if (args[0] === "git" && command.includes("reflog")) {
        const entries = Array.from(
          { length: 3 },
          (_, index) =>
            `${head}\0HEAD@{${snapshot.launchedAtSeconds + index} +0000}\0commit: fixture`,
        );
        eligibleEntries = entries.length;
        elapsed += 25;
        return { ...result, stdout: Buffer.from(`${entries.join("\n")}\n`) };
      }
      if (args[0] === "git" && command.includes("cat-file")) {
        const timeout = (args[2] as { timeout: number }).timeout;
        timeouts.push(timeout);
        elapsed += timeout + 1;
        return {
          ...result,
          status: null,
          error: Object.assign(new Error("git timed out"), { code: "ETIMEDOUT" }),
        };
      }
      return result;
    });
    try {
      expect(isWorkRootEditVerified(snapshot, { gitTimeoutMs: 100 })).toBe(false);
      expect(eligibleEntries).toBeGreaterThan(1);
      expect(elapsed).toBeLessThanOrEqual(101);
      expect(timeouts).toEqual([75]);
    } finally {
      probe.mockRestore();
      clock.mockRestore();
    }
  }, 20_000);

  it("denies a qualifying evaluation that succeeds after the scan deadline", () => {
    const snapshot = snapshotRoot(workRoot);
    const repo = join(workRoot, "alpha");
    const parent = init(repo);
    writeFileSync(join(repo, "tracked"), "committed edit\n");
    const head = seedSuccessor(repo);
    const spawn = childProcess.spawnSync;
    let elapsed = 0;
    let overrun = false;
    let successfulFinalReads = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
    const probe = spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
      const result = spawn(...args);
      const command = args[1] as string[];
      if (args[0] === "git" && command.includes("reflog")) {
        return {
          ...result,
          stdout: Buffer.from(
            `${head}\0HEAD@{${snapshot.launchedAtSeconds} +0000}\0commit: fixture\n`,
          ),
        };
      }
      if (
        args[0] === "git" &&
        command.includes("rev-parse") &&
        command.includes(`${parent}^{tree}`) &&
        result.status === 0 &&
        !result.error
      ) {
        successfulFinalReads++;
        if (overrun) elapsed = 101;
      }
      return result;
    });
    try {
      expect(isWorkRootEditVerified(snapshot, { gitTimeoutMs: 100 })).toBe(true);
      expect(successfulFinalReads).toBe(1);
      overrun = true;
      expect(isWorkRootEditVerified(snapshot, { gitTimeoutMs: 100 })).toBe(false);
      expect(successfulFinalReads).toBe(2);
      expect(elapsed).toBe(101);
    } finally {
      probe.mockRestore();
      clock.mockRestore();
    }
  }, 20_000);

  it("credits a content commit after an unreadable amend entry", () => {
    const source = join(agentsRoot, "source");
    init(source);
    const snapshot = snapshotRoot(workRoot);
    const repo = join(workRoot, "alpha");
    git(agentsRoot, "clone", "--quiet", source, repo);
    writeFileSync(join(repo, "tracked"), "committed edit\n");
    const valid = commit(repo);
    git(repo, "commit", "--amend", "--quiet", "-m", "unreadable amendment");
    const amended = git(repo, "rev-parse", "HEAD");
    const spawn = childProcess.spawnSync;
    let failedEntryReads = 0;
    let validEntryReads = 0;
    const probe = spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
      const result = spawn(...args);
      const command = args[1] as string[];
      if (args[0] === "git" && command.includes("cat-file")) {
        if (command.includes(amended)) {
          failedEntryReads++;
          return { ...result, status: 1 };
        }
        if (command.includes(valid)) validEntryReads++;
      }
      return result;
    });
    try {
      expect(isWorkRootEditVerified(snapshot)).toBe(true);
      expect(failedEntryReads).toBeGreaterThan(0);
      expect(validEntryReads).toBeGreaterThan(0);
    } finally {
      probe.mockRestore();
    }
  }, 20_000);

  it("does not credit a content commit through a child symlink created after launch", async () => {
    const source = join(agentsRoot, "source");
    init(source);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          symlinkSync(source, join(workRoot, "linked"), "dir");
          writeFileSync(join(source, "tracked"), "outside edit\n");
          commit(source);
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  }, 20_000);

  it("excludes a child symlink from capture and gives no credit for its target's content commit", async () => {
    const source = join(agentsRoot, "source");
    init(source);
    symlinkSync(source, join(workRoot, "linked"), "dir");
    const snapshot = captureWorkRootSnapshot(workRoot);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          writeFileSync(join(source, "tracked"), "outside edit\n");
          seedSuccessor(source);
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
    expect(snapshot?.trees.size).toBe(0);
  }, 20_000);

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
    expect(captureWorkRootSnapshot(workRoot)?.trees.get("alpha")).toEqual({
      kind: "not a repo",
      emptyAtLaunch: true,
    });
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

  it("does not credit init and a commit of pre-existing files in a non-repository child", async () => {
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    writeFileSync(join(repo, "tracked"), "pre-existing\n");
    const snapshot = snapshotRoot(workRoot);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          git(repo, "init", "--quiet");
          commit(repo);
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
    expect(snapshot.trees.get("alpha")).toEqual({
      kind: "not a repo",
      emptyAtLaunch: false,
    });
  });

  it("does not credit a later commit in a repository unborn and empty at launch", async () => {
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    const snapshot = snapshotRoot(workRoot);
    const result = await run([
      {
        toolName: "run",
        action: () => {
          writeFileSync(join(repo, "tracked"), "initial content\n");
          commit(repo);
        },
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
    expect(snapshot.trees.get("alpha")?.kind).toBe("unborn");
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("does not credit a later commit of a file staged then deleted before launch in an unborn repository", async () => {
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    writeFileSync(join(repo, "tracked"), "pre-staged\n");
    git(repo, "add", ".");
    rmSync(join(repo, "tracked"));
    const snapshot = snapshotRoot(workRoot);
    const result = await run([
      {
        toolName: "run",
        action: () => git(repo, "commit", "--quiet", "-m", "pre-staged content"),
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
    expect(snapshot.trees.get("alpha")?.kind).toBe("unborn");
    expect(git(repo, "show", "HEAD:tracked")).toBe("pre-staged");
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("does not credit a commit of pre-existing files in an unborn repository", async () => {
    const repo = join(workRoot, "alpha");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    writeFileSync(join(repo, "tracked"), "pre-existing\n");
    git(repo, "add", ".");
    const snapshot = snapshotRoot(workRoot);
    const result = await run([
      {
        toolName: "run",
        action: () => commit(repo),
      },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
    expect(snapshot.trees.get("alpha")?.kind).toBe("unborn");
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

  it("does not credit staged then deleted content in an unborn child renamed after launch", () => {
    const repo = join(workRoot, "alpha");
    const renamed = join(workRoot, "renamed");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    writeFileSync(join(repo, "tracked"), "pre-staged\n");
    git(repo, "add", ".");
    rmSync(join(repo, "tracked"));
    const snapshot = snapshotRoot(workRoot);
    expect(snapshot.trees.get("alpha")?.kind).toBe("unborn");
    renameSync(repo, renamed);
    git(renamed, "commit", "--quiet", "-m", "pre-staged content");
    expect(git(renamed, "show", "HEAD:tracked")).toBe("pre-staged");
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("does not credit pre-existing files in a non-repository child renamed after launch", () => {
    const repo = join(workRoot, "alpha");
    const renamed = join(workRoot, "renamed");
    mkdirSync(repo);
    writeFileSync(join(repo, "tracked"), "pre-existing\n");
    const snapshot = snapshotRoot(workRoot);
    expect(snapshot.trees.get("alpha")).toEqual({ kind: "not a repo", emptyAtLaunch: false });
    renameSync(repo, renamed);
    git(renamed, "init", "--quiet");
    commit(renamed);
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("does not credit an unknown capture renamed after launch", () => {
    const repo = join(workRoot, "alpha");
    const renamed = join(workRoot, "renamed");
    init(repo);
    const index = join(repo, ".git", "index");
    renameSync(index, `${index}.saved`);
    mkdirSync(index);
    const snapshot = snapshotRoot(workRoot);
    expect(snapshot.trees.get("alpha")?.kind).toBe("unknown");
    rmSync(index, { recursive: true });
    renameSync(`${index}.saved`, index);
    renameSync(repo, renamed);
    writeFileSync(join(renamed, "tracked"), "edited\n");
    commit(renamed);
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("does not credit an over-bound unknown child renamed after launch", () => {
    mkdirSync(join(workRoot, "a-empty"));
    const repo = join(workRoot, "z-repo");
    const renamed = join(workRoot, "0-renamed");
    init(repo);
    const options = { maxChildDirectories: 1 };
    const snapshot = snapshotRoot(workRoot, options);
    expect(snapshot.trees.get("z-repo")?.kind).toBe("unknown");
    renameSync(repo, renamed);
    writeFileSync(join(renamed, "tracked"), "edited\n");
    commit(renamed);
    expect(isWorkRootEditVerified(snapshot, options)).toBe(false);
  });

  it("credits a content commit in a known work tree renamed after launch", () => {
    const repo = join(workRoot, "alpha");
    const renamed = join(workRoot, "renamed");
    init(repo);
    const snapshot = snapshotRoot(workRoot);
    expect(snapshot.trees.get("alpha")?.kind).toBe("known");
    renameSync(repo, renamed);
    writeFileSync(join(renamed, "tracked"), "edited\n");
    seedSuccessor(renamed);
    expect(isWorkRootEditVerified(snapshot)).toBe(true);
  });

  it("credits a launch-known edit despite a new earlier-sorting child at the scan bound", () => {
    const repo = join(workRoot, "z-repo");
    init(repo);
    const options = { maxChildDirectories: 1 };
    const snapshot = snapshotRoot(workRoot, options);
    expect(snapshot.trees.get("z-repo")?.kind).toBe("known");
    mkdirSync(join(workRoot, "a-new"));
    writeFileSync(join(repo, "tracked"), "edited\n");
    seedSuccessor(repo);
    expect(isWorkRootEditVerified(snapshot, options)).toBe(true);
  });

  it("limits new children to remaining slots after surviving launch children", () => {
    const existing = join(workRoot, "z-existing");
    init(existing);
    const options = { maxChildDirectories: 2 };
    const snapshot = snapshotRoot(workRoot, options);
    mkdirSync(join(workRoot, "a-empty"));
    const repo = join(workRoot, "b-new");
    init(repo);
    writeFileSync(join(repo, "tracked"), "edited\n");
    commit(repo);
    expect(isWorkRootEditVerified(snapshot, options)).toBe(false);
    rmSync(join(workRoot, "a-empty"), { recursive: true });
    expect(isWorkRootEditVerified(snapshot, options)).toBe(true);
  });

  it("marks the over-bound directory unknown", () => {
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

  it("shows the configured work root", () => {
    const report = runDoctor({
      name: "builder",
      agentsRoot,
      homeDir: agentsRoot,
      pathEnv: "",
    });
    const check = report.checks.find((entry) => entry.name === "work root");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toBe(`work_root ${workRoot}`);
  });
});

describe("raw amend reflog record matching", () => {
  const old = "1".repeat(40);
  const commit = "2".repeat(40);
  const selector = "HEAD@{1700000000 +0000}";
  const action = "commit (amend): fixture";
  const record = (before: string, after: string) =>
    `${before} ${after} Test <test@example.invalid> 1700000000 +0000\t${action}\n`;

  it("denies credit with no matching raw record", () => {
    expect(replacedCommitFromReflog(record(old, old), selector, commit, action)).toBeUndefined();
  });

  it("denies credit for a malformed selector", () => {
    const raw = record(old, commit);
    expect(replacedCommitFromReflog(raw, "HEAD", commit, action)).toBeUndefined();
  });

  it.each([
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
  ])("returns the replaced commit with %s in the ref", (_name, separator) => {
    const selected = `refs/heads/topic${separator}name@{1700000000 +0000}`;
    expect(replacedCommitFromReflog(record(old, commit), selected, commit, action)).toBe(old);
  });

  it("denies credit for duplicate same-second amend records", () => {
    const raw = record(old, commit) + record(commit, commit);
    expect(replacedCommitFromReflog(raw, selector, commit, action)).toBeUndefined();
  });

  it("returns the replaced commit from one matching raw record", () => {
    expect(replacedCommitFromReflog(record(old, commit), selector, commit, action)).toBe(old);
  });

  it.each([
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
    ["CR", "\r"],
  ])("returns the replaced commit with %s in the subject", (_name, separator) => {
    const subject = `${action}${separator}continued`;
    const raw = `${old} ${commit} Test <test@example.invalid> 1700000000 +0000\t${subject}\n`;
    expect(replacedCommitFromReflog(raw, selector, commit, subject)).toBe(old);
  });

  it("returns the replaced commit with U+2028, a timestamp and a tab in the subject", () => {
    const subject = "commit (amend): x\u2028abc 1700000000 +0000\tcommit: y";
    const raw = `${old} ${commit} Test <test@example.invalid> 1700000000 +0000\t${subject}\n`;
    expect(replacedCommitFromReflog(raw, selector, commit, subject)).toBe(old);
  });

  it("denies credit for a raw line without a tab", () => {
    const raw = `${old} ${commit} Test <test@example.invalid> 1700000000 +0000 ${action}\n`;
    expect(replacedCommitFromReflog(raw, selector, commit, action)).toBeUndefined();
  });
});

describe("reflog scan timestamp validation", () => {
  it("denies credit when the selector has trailing text after its closing brace", () => {
    let root: string | undefined;
    let probe: { mockRestore(): void } | undefined;
    try {
      root = mkdtempSync(join(tmpdir(), "bob-reflog-scan-"));
      root = realpathSync(root);
      const snapshot = snapshotRoot(root);
      const repo = join(root, "child");
      mkdirSync(repo);
      const head = "2".repeat(40);
      let suffix = "";
      let scannedEntries = 0;
      const outputs = new Map([
        ["--is-inside-work-tree", "true\n"],
        ["--show-toplevel", `${repo}\n`],
        ["--absolute-git-dir", `${repo}\n`],
        ["--show-object-format", "sha1\n"],
        ["rev-list", `${"3".repeat(40)}\n`],
        ["ls-files", ""],
        ["symbolic-ref", "HEAD\n"],
        ["HEAD^{commit}", `${head}\n`],
        ["cat-file", `tree ${"3".repeat(40)}\n\nfixture\n`],
        ["ls-tree", `100644 blob ${"4".repeat(40)}\ttracked\n`],
      ]);
      probe = spyOn(childProcess, "spawnSync").mockImplementation((_file, args) => {
        const command = args as string[];
        let output: string | undefined;
        if (command.includes("reflog")) {
          scannedEntries++;
          output = `${head}\0HEAD@{${snapshot.launchedAtSeconds} +0000}${suffix}\0commit: fixture\n`;
        } else {
          output = outputs.get(command.find((arg) => outputs.has(arg)) ?? "");
        }
        if (output === undefined) throw new Error(`unexpected git command: ${command.join(" ")}`);
        const stdout = Buffer.from(output);
        const stderr = Buffer.alloc(0);
        return { pid: 0, output: [null, stdout, stderr], stdout, stderr, status: 0, signal: null };
      });
      expect(isWorkRootEditVerified(snapshot)).toBe(true);
      suffix = "trailing";
      expect(isWorkRootEditVerified(snapshot)).toBe(false);
      expect(scannedEntries).toBe(2);
    } finally {
      probe?.mockRestore();
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    }
  }, 5_000);
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
