import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkRoot } from "../../src/shell/bob-yaml.js";
import { runDoctor } from "../../src/shell/doctor.js";
import {
  isWorkRootEditVerified,
  type WorkRootLaunchSnapshot,
} from "../../src/shell/edit-evidence.js";
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
  return execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 5_000,
  }).trim();
}

function commit(cwd: string, parent?: string): string {
  git(cwd, "add", ".");
  const tree = git(cwd, "write-tree");
  const head = git(cwd, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "fixture");
  git(cwd, "reset", "--hard", head);
  return head;
}

function init(cwd: string): string {
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--quiet");
  writeFileSync(join(cwd, "tracked"), "original\n");
  return commit(cwd);
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
          commit(repo);
        },
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  });

  it("credits a new work tree that holds a commit made after launch", async () => {
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
          execFileSync("sleep", ["1.1"]);
          writeFileSync(join(workRoot, "fresh", "tracked"), "fresh edit\n");
          commit(join(workRoot, "fresh"));
        },
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.noEditNoBlocked).toBeUndefined();
  }, 20_000);

  it("does not credit a new work tree whose only commit predates launch", async () => {
    const source = join(agentsRoot, "source");
    init(source);
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
          commit(cwd);
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
          commit(repo);
        },
      },
    ]);
    expect(ignored.exitCode).toBe(1);
    expect(ignored.noEditNoBlocked).toBe(true);
  });

  it("does not credit a work tree whose launch capture is unknown", () => {
    const repo = join(workRoot, "alpha");
    init(repo);
    const snapshot: WorkRootLaunchSnapshot = {
      root: workRoot,
      launchedAtSeconds: Math.floor(Date.now() / 1000),
      trees: new Map([["alpha", { kind: "unknown" }]]),
    };
    writeFileSync(join(repo, "tracked"), "edited\n");
    commit(repo);
    expect(isWorkRootEditVerified(snapshot)).toBe(false);
  });

  it("reports the work root and the number of work trees it watches", () => {
    init(join(workRoot, "alpha"));
    init(join(workRoot, "beta"));
    const report = runDoctor({
      name: "builder",
      agentsRoot,
      homeDir: agentsRoot,
      pathEnv: "",
    });
    const check = report.checks.find((entry) => entry.name === "work root");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain(workRoot);
    expect(check?.detail).toContain("2 work tree");
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
