import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorktreeStatusResult } from "../../src/shell/compaction-contract.js";
import { captureRepositoryState, isVerifiedEdit } from "../../src/shell/edit-evidence.js";
import { initOverrideRepo } from "../../src/shell/overrides.js";
import { type RunSession, runAgent } from "../../src/shell/run.js";

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
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: "pipe" }).trim();
}

function commit(cwd: string, parent?: string): string {
  git(cwd, "add", ".");
  const tree = git(cwd, "write-tree");
  const head = git(cwd, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "fixture");
  git(cwd, "reset", "--hard", head);
  return head;
}

function init(cwd: string): string {
  git(cwd, "init", "--quiet");
  writeFileSync(join(cwd, "tracked"), "original\n");
  return commit(cwd);
}

type Call = { toolName: string; action?: () => void };

function session(calls: Call[], finalAction?: () => void): RunSession {
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
        emit({ type: "tool_execution_start", toolName: call.toolName, args: { i } });
        call.action?.();
        emit({
          type: "tool_execution_end",
          toolName: call.toolName,
          isError: false,
          result: { content: [{ type: "text", text: "DONE: edited and committed everything." }] },
        });
      }
      finalAction?.();
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "DONE: edited and committed everything." }],
          stopReason: "stop",
        },
      });
    },
    async steer() {},
    async abort() {},
    dispose() {},
  };
}

describe("repository evidence in the completion gate and exploration budget", () => {
  let agentsRoot: string;
  let cwd: string;
  let launchHead: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-repository-evidence-"));
    cwd = join(agentsRoot, "builder", "work");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(agentsRoot, "builder", ".pi-agent"));
    writeFileSync(
      join(agentsRoot, "builder", "bob.yaml"),
      "agent:\n  id: builder\n  name: builder\n  role: builder-local\nprovider:\n  name: anthropic\n  model: claude-sonnet-4-6\ntools:\n  allow:\n    - run\n",
    );
    writeFileSync(join(agentsRoot, "builder", "soul.md"), "Build the task.");
    launchHead = init(cwd);
  });

  afterEach(() => rmSync(agentsRoot, { recursive: true, force: true }));

  const run = (calls: Call[], finalAction?: () => void, explorationBudget = 20) =>
    runAgent({
      name: "builder",
      agentsRoot,
      prompt: "Edit the tracked file.",
      explorationBudget,
      sessionFactory: async () => session(calls, finalAction),
    });

  it.each([0o644, 0o755])("preserves regular-file fingerprints for mode %s", (mode) => {
    const clean = captureRepositoryState(cwd);
    expect(clean.kind).toBe("git");
    if (clean.kind !== "git") throw new Error("missing repository evidence");
    expect(clean.trackedHash).toBe(createHash("sha256").digest("hex"));
    const bytes = Buffer.from([0, 0xff, 10, 13, 0x80]);
    writeFileSync(join(cwd, "tracked"), bytes);
    chmodSync(join(cwd, "tracked"), mode);
    const changed = captureRepositoryState(cwd);
    expect(changed.kind).toBe("git");
    if (changed.kind !== "git") throw new Error("missing repository evidence");
    expect(changed.trackedHash).toBe(
      createHash("sha256")
        .update(`tracked\0${mode === 0o755 ? "100755" : "100644"}\0`)
        .update(createHash("sha256").update(bytes).digest())
        .update("\0")
        .digest("hex"),
    );
  });

  it("reads the opened file when its path becomes a symlink after fstat", () => {
    const before = captureRepositoryState(cwd);
    expect(before.kind).toBe("git");
    const fstat = fs.fstatSync;
    const probe = spyOn(fs, "fstatSync").mockImplementation((fd) => {
      const stat = fstat(fd);
      renameSync(join(cwd, "tracked"), join(agentsRoot, "opened"));
      writeFileSync(join(agentsRoot, "replacement"), "replacement bytes\n");
      symlinkSync(join(agentsRoot, "replacement"), join(cwd, "tracked"));
      return stat;
    });
    try {
      expect(captureRepositoryState(cwd)).toEqual(before);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      probe.mockRestore();
    }
  });

  it("fingerprints a symlink's target text", () => {
    rmSync(join(cwd, "tracked"));
    symlinkSync("missing-target", join(cwd, "tracked"));
    const state = captureRepositoryState(cwd);
    expect(state.kind).toBe("git");
    if (state.kind !== "git") throw new Error("missing repository evidence");
    expect(state.trackedHash).toBe(
      createHash("sha256")
        .update("tracked\0" + "120000\0")
        .update(createHash("sha256").update("missing-target").digest())
        .update("\0")
        .digest("hex"),
    );
  });

  function nestedFixture() {
    const parent = join(cwd, "dir");
    mkdirSync(parent);
    writeFileSync(join(parent, "file"), "nested original\n");
    launchHead = commit(cwd, launchHead);
    return parent;
  }

  it.each(["completion", "exploration"])(
    "ignores external changes through a symlinked parent for %s",
    async (gate) => {
      const parent = nestedFixture();
      const external = join(agentsRoot, "external");
      renameSync(parent, external);
      symlinkSync(external, parent);
      const before = captureRepositoryState(cwd);
      const deleted = git(cwd, "diff", "--name-status", "HEAD");
      expect(deleted).toBe("D\tdir/file");
      expect(before.kind).toBe("git");
      const open = spyOn(fs, "openSync");
      try {
        const result = await run(
          [
            {
              toolName: "run",
              action: () => writeFileSync(join(external, "file"), "external change\n"),
            },
            { toolName: "read" },
            { toolName: "read" },
            { toolName: "read" },
          ],
          undefined,
          gate === "exploration" ? 2 : 20,
        );
        expect(captureRepositoryState(cwd)).toEqual(before);
        expect(git(cwd, "diff", "--name-status", "HEAD")).toBe(deleted);
        expect(open.mock.calls.some(([path]) => String(path).endsWith("/dir/file"))).toBe(false);
        if (gate === "completion") expect(result.noEditNoBlocked).toBe(true);
        else expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
        expect(result.exitCode).toBe(1);
      } finally {
        open.mockRestore();
      }
    },
  );

  it.each(["missing", "file"])("treats a %s parent as deletion", (kind) => {
    const parent = nestedFixture();
    rmSync(parent, { recursive: true });
    const deleted = captureRepositoryState(cwd);
    expect(deleted.kind).toBe("git");
    if (kind === "file") writeFileSync(parent, "not a directory\n");
    expect(captureRepositoryState(cwd)).toEqual(deleted);
  });

  it.each(["symlink", "directory"])("rejects a parent swapped mid-read to a %s", (kind) => {
    const parent = nestedFixture();
    const before = captureRepositoryState(cwd);
    writeFileSync(join(parent, "file"), "changed\n");
    const read = fs.readFileSync;
    let swapped = false;
    const probe = spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (typeof args[0] === "number" && !swapped) {
        swapped = true;
        renameSync(parent, join(agentsRoot, "original-parent"));
        if (kind === "symlink") symlinkSync(join(agentsRoot, "original-parent"), parent);
        else {
          mkdirSync(parent);
          writeFileSync(join(parent, "file"), "replacement\n");
        }
      }
      return read(...args);
    });
    try {
      const after = captureRepositoryState(cwd);
      expect(swapped).toBe(true);
      expect(after).toEqual({ kind: "unavailable" });
      expect(isVerifiedEdit("run", false, {}, { cwd, before, after })).toBe(false);
    } finally {
      probe.mockRestore();
    }
  });

  it("refuses a FIFO at a tracked path without blocking", () => {
    rmSync(join(cwd, "tracked"));
    execFileSync("mkfifo", [join(cwd, "tracked")]);
    const module = new URL("../../src/shell/edit-evidence.ts", import.meta.url).href;
    const child = childProcess.spawnSync(
      process.execPath,
      [
        "--eval",
        `import { captureRepositoryState } from ${JSON.stringify(module)}; console.log(JSON.stringify(captureRepositoryState(${JSON.stringify(cwd)})));`,
      ],
      { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL" },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ kind: "unavailable" });
  });

  it.each(["bash", "run", "powershell"])("accepts a %s-only edit and commit", async (toolName) => {
    const result = await run([
      {
        toolName,
        action: () => {
          execFileSync(
            "bash",
            [
              "-c",
              'printf "changed\\n" > tracked && git add tracked && tree=$(git write-tree) && head=$(git commit-tree "$tree" -p HEAD -m edit) && git reset --hard "$head"',
            ],
            { cwd, env: gitEnv, stdio: "pipe" },
          );
        },
      },
    ]);
    expect(git(cwd, "rev-parse", "HEAD")).not.toBe(launchHead);
    expect(git(cwd, "diff", "HEAD")).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  });

  it.each(["clean", "dirty", "staged"])(
    "rejects unchanged %s state despite model claims",
    async (state) => {
      if (state !== "clean") writeFileSync(join(cwd, "tracked"), "pre-existing\n");
      if (state === "staged") git(cwd, "add", "tracked");
      const result = await run([{ toolName: "bash" }]);
      expect(result.exitCode).toBe(1);
      expect(result.noEditNoBlocked).toBe(true);
    },
  );

  function changePresentation() {
    for (const [key, value] of Object.entries({
      "core.abbrev": "40",
      "diff.renames": "true",
      "core.quotePath": "false",
      "diff.noprefix": "true",
      "core.fileMode": "false",
      "core.autocrlf": "true",
      "diff.algorithm": "histogram",
      "diff.relative": "true",
      "diff.orderFile": join(agentsRoot, "order"),
    }))
      git(cwd, "config", key, value);
  }

  function dirtyFixture() {
    writeFileSync(join(cwd, "quoted\t\n-é"), "before\n");
    commit(cwd, launchHead);
    git(cwd, "config", "core.abbrev", "7");
    writeFileSync(join(agentsRoot, "order"), "tracked\n");
    writeFileSync(join(cwd, "tracked"), "pre-existing\n");
    renameSync(join(cwd, "quoted\t\n-é"), join(cwd, "renamed"));
    git(cwd, "add", ".");
  }

  it("ignores presentation-only changes in a dirty tree but accepts new bytes", async () => {
    dirtyFixture();
    const before = captureRepositoryState(cwd);
    const result = await run([{ toolName: "run", action: changePresentation }]);
    const after = captureRepositoryState(cwd);
    const edited = await run([
      { toolName: "run", action: () => writeFileSync(join(cwd, "tracked"), "real edit\n") },
    ]);
    expect({ result: result.noEditNoBlocked, after }).toEqual({ result: true, after: before });
    expect(result.exitCode).toBe(1);
    expect(edited.exitCode).toBe(0);
  });

  it("does not award exploration credit for presentation-only changes", async () => {
    dirtyFixture();
    const result = await run(
      [
        { toolName: "read" },
        { toolName: "run", action: changePresentation },
        { toolName: "read" },
        { toolName: "read" },
      ],
      undefined,
      2,
    );
    expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
  });

  it("ignores ambient repository selectors for edits, history and exploration", async () => {
    const other = join(agentsRoot, "other");
    mkdirSync(other);
    init(other);
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other });
      const edited = await run(
        [
          { toolName: "read" },
          { toolName: "run", action: () => writeFileSync(join(cwd, "tracked"), "real edit\n") },
          { toolName: "read" },
          { toolName: "read" },
        ],
        undefined,
        2,
      );
      const committed = await run([{ toolName: "run", action: () => commit(cwd, launchHead) }]);
      const unrelated = await run([
        { toolName: "run", action: () => writeFileSync(join(other, "tracked"), "other edit\n") },
      ]);
      expect(edited.explorationBudgetExhausted).toBeUndefined();
      expect(edited.exitCode).toBe(0);
      expect(committed.exitCode).toBe(0);
      expect(unrelated.noEditNoBlocked).toBe(true);
    } finally {
      for (const key of ["GIT_DIR", "GIT_WORK_TREE"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("allowlists the environment on every Bob Git subprocess", () => {
    const before = captureRepositoryState(cwd);
    writeFileSync(join(cwd, "tracked"), "commit edit\n");
    commit(cwd, launchHead);
    const probe = spyOn(childProcess, "spawnSync");
    const setupProbe = spyOn(childProcess, "execFileSync");
    process.env.BOB_EVIDENCE_UNLISTED = "must not be inherited";
    try {
      const after = captureRepositoryState(cwd);
      expect(after.kind).toBe("git");
      expect(isVerifiedEdit("run", false, {}, { cwd, before, after })).toBe(true);
      expect(readWorktreeStatusResult(cwd).ok).toBe(true);
      initOverrideRepo(join(agentsRoot, "builder"));
      const calls = [...probe.mock.calls, ...setupProbe.mock.calls].filter(
        ([command]) => command === "git",
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const options = call[2] as { env: Record<string, string> };
        expect(Object.keys(options.env).sort()).toEqual([
          "GIT_CONFIG_GLOBAL",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_NO_LAZY_FETCH",
          "GIT_OPTIONAL_LOCKS",
          "HOME",
          "LANG",
          "LC_ALL",
          "PATH",
        ]);
        expect(options.env.LC_ALL).toBe("C");
        expect(options.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      }
    } finally {
      delete process.env.BOB_EVIDENCE_UNLISTED;
      probe.mockRestore();
      setupProbe.mockRestore();
    }
  });

  it.each([
    ["worktree", "completion"],
    ["gitdir", "completion"],
    ["worktree", "exploration"],
    ["gitdir", "exploration"],
  ])("rejects changed %s resolution during %s", async (kind, gate) => {
    const other = join(agentsRoot, "replacement");
    mkdirSync(other);
    if (kind === "worktree") {
      const gitdir = join(agentsRoot, "fixed-git-dir");
      renameSync(join(cwd, ".git"), gitdir);
      writeFileSync(join(cwd, ".git"), `gitdir: ${gitdir}\n`);
    }
    const redirect = () => {
      if (kind === "worktree") {
        cpSync(cwd, other, { recursive: true });
        rmSync(cwd, { recursive: true });
        symlinkSync(other, cwd);
        writeFileSync(join(other, "tracked"), "other tree\n");
      } else {
        const gitdir = join(other, ".git");
        cpSync(join(cwd, ".git"), gitdir, { recursive: true });
        rmSync(join(cwd, ".git"), { recursive: true });
        writeFileSync(join(cwd, ".git"), `gitdir: ${gitdir}\n`);
        writeFileSync(join(cwd, "tracked"), "changed\n");
      }
    };
    const result = await run(
      [
        { toolName: "run", action: redirect },
        {
          toolName: "run",
          action: () =>
            writeFileSync(join(kind === "worktree" ? other : cwd, "tracked"), "changed again\n"),
        },
        { toolName: "read" },
        { toolName: "read" },
      ],
      undefined,
      gate === "exploration" ? 2 : 20,
    );
    if (gate === "exploration") {
      expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
    } else {
      expect(result.noEditNoBlocked).toBe(true);
    }
    expect(result.exitCode).toBe(1);
  });

  it("skips evidence Git probes when completion and exploration gates are disabled", async () => {
    const probe = spyOn(childProcess, "spawnSync");
    const config = join(agentsRoot, "builder", "bob.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace("builder-local", "coder").replace("- run", "- bash"),
    );
    try {
      const result = await runAgent({
        name: "builder",
        agentsRoot,
        prompt: "Read the file.",
        requireEditOrBlocked: false,
        sessionFactory: async () => session([]),
      });
      expect(result.exitCode).toBe(0);
      expect(probe.mock.calls.filter(([command]) => command === "git")).toEqual([]);
    } finally {
      probe.mockRestore();
    }
  });

  it("counts a working-tree mode change even when Git ignores file modes", async () => {
    git(cwd, "config", "core.fileMode", "false");
    const result = await run([
      { toolName: "run", action: () => chmodSync(join(cwd, "tracked"), 0o755) },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("rejects an empty commit", async () => {
    const result = await run([
      {
        toolName: "bash",
        action: () => {
          commit(cwd, launchHead);
        },
      },
    ]);
    expect(git(cwd, "rev-list", "--count", "HEAD", `^${launchHead}`)).toBe("1");
    expect(git(cwd, "diff", launchHead, "HEAD")).toBe("");
    expect(git(cwd, "diff", "HEAD")).toBe("");
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("rejects a commit followed by its revert", async () => {
    const result = await run([
      {
        toolName: "bash",
        action: () => {
          writeFileSync(join(cwd, "tracked"), "temporary edit\n");
          commit(cwd, launchHead);
        },
      },
      {
        toolName: "bash",
        action: () => {
          const editedHead = git(cwd, "rev-parse", "HEAD");
          git(cwd, "revert", "--no-commit", editedHead);
          commit(cwd, editedHead);
        },
      },
    ]);
    expect(git(cwd, "rev-list", "--count", "HEAD", `^${launchHead}`)).toBe("2");
    expect(git(cwd, "diff", launchHead, "HEAD")).toBe("");
    expect(git(cwd, "diff", "HEAD")).toBe("");
    expect(result.exitCode).toBe(1);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it.each([false, true])(
    "accepts changed tracked content in a dirty tree (staged: %s)",
    async (staged) => {
      writeFileSync(join(cwd, "tracked"), "pre-existing\n");
      const result = await run([
        {
          toolName: "run",
          action: () => {
            writeFileSync(join(cwd, "tracked"), "new edit\n");
            if (staged) git(cwd, "add", "tracked");
          },
        },
      ]);
      expect(result.exitCode).toBe(0);
    },
  );

  it("checks again at completion after the last tool result", async () => {
    const result = await run([{ toolName: "run" }], () => {
      writeFileSync(join(cwd, "tracked"), "late edit\n");
    });
    expect(result.exitCode).toBe(0);
  });

  it("rejects a clean backwards reset", async () => {
    writeFileSync(join(cwd, "tracked"), "second commit\n");
    commit(cwd, launchHead);
    const result = await run([
      { toolName: "bash", action: () => git(cwd, "reset", "--hard", launchHead) },
    ]);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("accepts a new branch from an older commit", async () => {
    writeFileSync(join(cwd, "tracked"), "second commit\n");
    commit(cwd, launchHead);
    const result = await run([
      {
        toolName: "bash",
        action: () => {
          git(cwd, "reset", "--hard", launchHead);
          writeFileSync(join(cwd, "tracked"), "new branch\n");
          commit(cwd, launchHead);
        },
      },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("does not retain repository evidence after it is reverted", async () => {
    const result = await run([
      { toolName: "run", action: () => writeFileSync(join(cwd, "tracked"), "temporary\n") },
      { toolName: "run", action: () => git(cwd, "reset", "--hard", launchHead) },
    ]);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("ignores untracked files", async () => {
    const result = await run([
      { toolName: "bash", action: () => writeFileSync(join(cwd, "new"), "untracked") },
    ]);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("keeps the file-tool rule for a non-git launch directory", async () => {
    rmSync(join(cwd, ".git"), { recursive: true });
    const result = await run([{ toolName: "bash", action: () => init(cwd) }]);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it.each(["launch", "end", "history"])("fails closed when git fails at %s", async (stage) => {
    const headFile = join(cwd, ".git", "HEAD");
    const saved = readFileSync(headFile);
    if (stage === "launch") writeFileSync(headFile, "broken HEAD\n");
    const result = await run([
      {
        toolName: "bash",
        action: () => {
          if (stage === "launch") writeFileSync(headFile, saved);
          writeFileSync(join(cwd, "tracked"), "new edit\n");
          if (stage === "end") writeFileSync(headFile, "broken HEAD\n");
          if (stage === "history") {
            commit(cwd);
            rmSync(join(cwd, ".git", "objects", launchHead.slice(0, 2), launchHead.slice(2)));
            writeFileSync(join(cwd, "tracked"), "also dirty\n");
          }
        },
      },
    ]);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it("resets the exploration budget on a repository edit", async () => {
    const result = await run(
      [
        { toolName: "read" },
        { toolName: "bash", action: () => writeFileSync(join(cwd, "tracked"), "edit\n") },
        { toolName: "read" },
        { toolName: "read" },
      ],
      undefined,
      2,
    );
    expect(result.explorationBudgetExhausted).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("does not credit the same repository edit on later reads", async () => {
    const result = await run(
      [
        { toolName: "bash", action: () => writeFileSync(join(cwd, "tracked"), "edit\n") },
        ...Array.from({ length: 4 }, () => ({ toolName: "read" })),
      ],
      undefined,
      2,
    );
    expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
  });

  it.each(["untracked", "dirty", "gitlink"])("handles a submodule's %s change", async (kind) => {
    const child = join(cwd, "child");
    mkdirSync(child);
    const childHead = init(child);
    writeFileSync(
      join(cwd, ".gitmodules"),
      '[submodule "child"]\n\tpath = child\n\turl = ./child\n',
    );
    commit(cwd, launchHead);
    const result = await run([
      {
        toolName: "bash",
        action: () => {
          writeFileSync(join(child, kind === "untracked" ? "new" : "tracked"), "child edit\n");
          if (kind === "gitlink") commit(child, childHead);
        },
      },
    ]);
    expect(result.exitCode).toBe(kind === "gitlink" ? 0 : 1);
    expect(result.noEditNoBlocked).toBe(kind === "gitlink" ? undefined : true);
  });
});
