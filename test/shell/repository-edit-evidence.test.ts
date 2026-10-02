import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
