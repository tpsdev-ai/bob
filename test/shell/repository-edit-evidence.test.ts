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
import { readLastRunSummary, runDoctor } from "../../src/shell/doctor.js";
import * as evidence from "../../src/shell/edit-evidence.js";
import { captureRepositoryState, isVerifiedEdit } from "../../src/shell/edit-evidence.js";
import { initOverrideRepo } from "../../src/shell/overrides.js";
import { type RunSession, runAgent } from "../../src/shell/run.js";

const WHOLE_FILE_HASH_CAP_BYTES = 1024 * 1024;

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

type Call = { toolName: string; action?: () => void; result?: unknown };

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
          result: call.result ?? {
            content: [{ type: "text", text: "DONE: edited and committed everything." }],
          },
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

  it("re-hashes only the edited file across tool observations and completion", async () => {
    writeFileSync(join(cwd, "other"), "other bytes\n");
    writeFileSync(join(cwd, "third"), "third bytes\n");
    commit(cwd, launchHead);
    const reads: bigint[] = [];
    const readFile = fs.readFileSync;
    const read = spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (typeof args[0] === "number") reads.push(fs.fstatSync(args[0], { bigint: true }).ino);
      return readFile(...args);
    });
    try {
      const result = await run([
        { toolName: "read" },
        { toolName: "bash", action: () => writeFileSync(join(cwd, "tracked"), "new edit\n") },
        { toolName: "read" },
      ]);
      expect(result.exitCode).toBe(0);
      expect(read.mock.calls.filter(([path]) => typeof path === "number")).toHaveLength(4);
      for (const [name, count] of [
        ["tracked", 2],
        ["other", 1],
        ["third", 1],
      ] as const) {
        const ino = fs.statSync(join(cwd, name), { bigint: true }).ino;
        expect(reads.filter((readIno) => readIno === ino)).toHaveLength(count);
      }
    } finally {
      read.mockRestore();
    }
  });

  it.each(["run", "bash"])(
    "denies a committed %s edit when launch enumeration exceeds a lowered limit",
    async (toolName) => {
      writeFileSync(join(cwd, "tracked"), "second commit\n");
      launchHead = commit(cwd, launchHead);
      const capture = evidence.captureRepositoryState;
      const probe = spyOn(evidence, "captureRepositoryState").mockImplementation((path, launch) =>
        capture(path, launch, { launchCommitLimit: 1 }),
      );
      try {
        const result = await run(
          [
            { toolName: "read" },
            {
              toolName,
              action: () => {
                writeFileSync(join(cwd, "tracked"), "committed edit\n");
                commit(cwd, launchHead);
              },
            },
            { toolName: "read" },
            { toolName: "read" },
          ],
          undefined,
          2,
        );
        expect(result.exitCode).toBe(1);
        expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
        const summary = readLastRunSummary(join(agentsRoot, "builder", "runs"));
        expect(summary?.repositoryHistoryCheckSkipped).toBe("limit");
        const diagnosis = await runDoctor({
          name: "builder",
          agentsRoot,
          homeDir: agentsRoot,
          pathEnv: "",
        });
        expect(
          diagnosis.checks.find((check) => check.name === "repository history check")?.detail,
        ).toBe("skipped: limit");
      } finally {
        probe.mockRestore();
      }
    },
  );

  it("denies an unchanged run when launch enumeration exceeds a lowered limit", async () => {
    writeFileSync(join(cwd, "tracked"), "second commit\n");
    commit(cwd, launchHead);
    const capture = evidence.captureRepositoryState;
    const probe = spyOn(evidence, "captureRepositoryState").mockImplementation((path, launch) =>
      capture(path, launch, { launchCommitLimit: 1 }),
    );
    try {
      const result = await run([{ toolName: "run" }]);
      expect(result.noEditNoBlocked).toBe(true);
      expect(
        readLastRunSummary(join(agentsRoot, "builder", "runs"))?.repositoryHistoryCheckSkipped,
      ).toBe("limit");
    } finally {
      probe.mockRestore();
    }
  });

  it("streams files above the whole-file cap with the Git blob hash", () => {
    writeFileSync(join(cwd, "tracked"), Buffer.alloc(WHOLE_FILE_HASH_CAP_BYTES + 1, 0x61));
    const expected = git(cwd, "hash-object", "tracked");
    const read = spyOn(fs, "readFileSync");
    const stream = spyOn(fs, "readSync");
    try {
      const state = captureRepositoryState(cwd);
      expect(state.kind).toBe("git");
      if (state.kind !== "git") throw new Error("missing repository evidence");
      expect(state.tracked.get("tracked")?.object).toBe(expected);
      expect(read.mock.calls.filter(([path]) => typeof path === "number")).toHaveLength(0);
      expect(stream.mock.calls.length).toBeGreaterThan(1);
      expect(stream.mock.calls.every(([, chunk]) => chunk.byteLength <= 64 * 1024)).toBe(true);
    } finally {
      read.mockRestore();
      stream.mockRestore();
    }
  });

  it.each(["mtimeNs", "ctimeNs"] as const)(
    "re-hashes same-tick same-size rewrites with racy %s",
    (field) => {
      const captureMs = Date.now();
      const captureNs = BigInt(captureMs) * 1_000_000n;
      const clock = spyOn(Date, "now").mockReturnValue(captureMs);
      const fstat = fs.fstatSync;
      const stat = spyOn(fs, "fstatSync").mockImplementation((fd) =>
        Object.assign(fstat(fd, { bigint: true }), {
          mtimeNs: captureNs - 1n,
          ctimeNs: captureNs - 1n,
          [field]: captureNs,
        }),
      );
      const read = spyOn(fs, "readFileSync");
      try {
        const before = captureRepositoryState(cwd);
        writeFileSync(join(cwd, "tracked"), "replaced\n");
        const after = captureRepositoryState(cwd, before);
        expect(isVerifiedEdit("run", false, {}, { cwd, before, after })).toBe(true);
        writeFileSync(join(cwd, "tracked"), "original\n");
        const restored = captureRepositoryState(cwd, before);
        expect(isVerifiedEdit("run", false, {}, { cwd, before, after: restored })).toBe(false);
        expect(read.mock.calls.filter(([path]) => typeof path === "number")).toHaveLength(3);
      } finally {
        read.mockRestore();
        stat.mockRestore();
        clock.mockRestore();
      }
    },
  );

  it("reuses entries older than capture and re-hashes when the clock reaches their tick", () => {
    const captureMs = Date.now();
    const timestampNs = BigInt(captureMs - 1) * 1_000_000n;
    const clock = spyOn(Date, "now").mockReturnValue(captureMs);
    const fstat = fs.fstatSync;
    const stat = spyOn(fs, "fstatSync").mockImplementation((fd) =>
      Object.assign(fstat(fd, { bigint: true }), {
        mtimeNs: timestampNs,
        ctimeNs: timestampNs,
      }),
    );
    const read = spyOn(fs, "readFileSync");
    try {
      const before = captureRepositoryState(cwd);
      const unchanged = captureRepositoryState(cwd, before);
      expect(isVerifiedEdit("run", false, {}, { cwd, before, after: unchanged })).toBe(false);
      expect(read.mock.calls.filter(([path]) => typeof path === "number")).toHaveLength(1);
      clock.mockReturnValue(captureMs - 1);
      writeFileSync(join(cwd, "tracked"), "replaced\n");
      const after = captureRepositoryState(cwd, before);
      expect(isVerifiedEdit("run", false, {}, { cwd, before, after })).toBe(true);
      expect(read.mock.calls.filter(([path]) => typeof path === "number")).toHaveLength(2);
    } finally {
      read.mockRestore();
      stat.mockRestore();
      clock.mockRestore();
    }
  });

  it("invalidates cached bytes after a same-size edit with restored mtime", () => {
    const before = captureRepositoryState(cwd);
    const stat = fs.statSync(join(cwd, "tracked"));
    writeFileSync(join(cwd, "tracked"), "replaced\n");
    fs.utimesSync(join(cwd, "tracked"), stat.atime, stat.mtime);
    const read = spyOn(fs, "readFileSync");
    try {
      const after = captureRepositoryState(cwd, before);
      expect(isVerifiedEdit("run", false, {}, { cwd, before, after })).toBe(true);
      expect(read.mock.calls.filter(([path]) => typeof path === "number")).toHaveLength(1);
    } finally {
      read.mockRestore();
    }
  });

  it.each([0o644, 0o755])("records regular-file bytes and mode %s", (mode) => {
    const clean = captureRepositoryState(cwd);
    expect(clean.kind).toBe("git");
    if (clean.kind !== "git") throw new Error("missing repository evidence");
    expect(clean.tree).toBe(git(cwd, "rev-parse", "HEAD^{tree}"));
    const bytes = Buffer.from([0, 0xff, 10, 13, 0x80]);
    writeFileSync(join(cwd, "tracked"), bytes);
    chmodSync(join(cwd, "tracked"), mode);
    const changed = captureRepositoryState(cwd, clean);
    expect(changed.kind).toBe("git");
    if (changed.kind !== "git") throw new Error("missing repository evidence");
    expect(changed.tracked.get("tracked")).toEqual({
      mode: mode === 0o755 ? "100755" : "100644",
      object: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    });
  });

  it("reads the opened file when its path becomes a symlink after fstat", () => {
    const before = captureRepositoryState(cwd);
    expect(before.kind).toBe("git");
    const fstat = fs.fstatSync;
    const probe = spyOn(fs, "fstatSync").mockImplementation((fd) => {
      const stat = fstat(fd, { bigint: true });
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
    expect(state.tracked.get("tracked")).toEqual({
      mode: "120000",
      object: createHash("sha1").update("blob 14\0missing-target").digest("hex"),
    });
  });

  function nestedFixture() {
    const parent = join(cwd, "dir");
    mkdirSync(parent);
    writeFileSync(join(parent, "file"), "nested original\n");
    launchHead = commit(cwd, launchHead);
    return parent;
  }

  it("rechecks shared parents after cached observations", () => {
    const parent = nestedFixture();
    const before = captureRepositoryState(cwd);
    const external = join(agentsRoot, "external");
    mkdirSync(external);
    writeFileSync(join(external, "file"), "external bytes\n");
    const fstat = fs.fstatSync;
    const probe = spyOn(fs, "fstatSync").mockImplementation((fd) => {
      const stat = fstat(fd, { bigint: true });
      renameSync(parent, join(agentsRoot, "saved-parent"));
      symlinkSync(external, parent);
      return stat;
    });
    const read = spyOn(fs, "readFileSync");
    try {
      expect(captureRepositoryState(cwd, before).kind).toBe("unavailable");
      expect(read.mock.calls.filter(([path]) => typeof path === "number")).toHaveLength(0);
    } finally {
      probe.mockRestore();
      read.mockRestore();
    }
  });

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

  it.each(["completion", "exploration"])("rejects HEAD-only moves at %s", async (gate) => {
    writeFileSync(join(cwd, "tracked"), "second commit\n");
    const second = commit(cwd, launchHead);
    const result = await run(
      [
        { toolName: "run", action: () => git(cwd, "reset", "--soft", launchHead) },
        { toolName: "read" },
        { toolName: "read" },
        { toolName: "read" },
      ],
      undefined,
      gate === "exploration" ? 2 : 20,
    );
    expect(git(cwd, "rev-parse", "HEAD")).not.toBe(second);
    if (gate === "completion") expect(result.noEditNoBlocked).toBe(true);
    else expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
    expect(result.exitCode).toBe(1);
  });

  it.each(["completion", "exploration"])("rejects a dirty soft reset at %s", async (gate) => {
    writeFileSync(join(cwd, "tracked"), "second commit\n");
    commit(cwd, launchHead);
    writeFileSync(join(cwd, "tracked"), "original\n");
    const result = await run(
      [
        { toolName: "run", action: () => git(cwd, "reset", "--soft", launchHead) },
        { toolName: "read" },
        { toolName: "read" },
        { toolName: "read" },
      ],
      undefined,
      gate === "exploration" ? 2 : 20,
    );
    if (gate === "completion") expect(result.noEditNoBlocked).toBe(true);
    else expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
    expect(result.exitCode).toBe(1);
  });

  it.each(["completion", "exploration"])(
    "rejects switching to an existing branch at %s",
    async (gate) => {
      writeFileSync(join(cwd, "tracked"), "existing branch\n");
      const existing = commit(cwd, launchHead);
      git(cwd, "branch", "existing", existing);
      git(cwd, "reset", "--hard", launchHead);
      const result = await run(
        [
          { toolName: "run", action: () => git(cwd, "switch", "existing") },
          { toolName: "read" },
          { toolName: "read" },
          { toolName: "read" },
        ],
        undefined,
        gate === "exploration" ? 2 : 20,
      );
      if (gate === "completion") expect(result.noEditNoBlocked).toBe(true);
      else expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
      expect(result.exitCode).toBe(1);
    },
  );

  it.each(
    ["failure", "overflow", "timeout"].flatMap((kind) =>
      ["completion", "exploration"].map((gate) => [kind, gate]),
    ),
  )(
    "rejects a pre-existing branch when launch history is incomplete: %s at %s",
    async (kind, gate) => {
      writeFileSync(join(cwd, "tracked"), "existing branch\n");
      const existing = commit(cwd, launchHead);
      git(cwd, "branch", "existing", existing);
      const spawn = childProcess.spawnSync;
      const tree = git(cwd, "rev-parse", "HEAD^{tree}");
      const probe = spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
        if (args[0] === "git" && (args[1] as string[]).includes("--all")) {
          expect(args[1]).toContain("--max-count=10001");
          const result = spawn(...args);
          return {
            ...result,
            status: kind === "failure" || kind === "timeout" ? 1 : 0,
            error:
              kind === "timeout"
                ? Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
                : undefined,
            stdout: Buffer.from(`${tree}\n`.repeat(10_001)),
          };
        }
        return spawn(...args);
      });
      try {
        git(cwd, "reset", "--hard", launchHead);
        const result = await run(
          [
            { toolName: "run", action: () => git(cwd, "switch", "existing") },
            { toolName: "read" },
            { toolName: "read" },
            { toolName: "read" },
          ],
          undefined,
          gate === "exploration" ? 2 : 20,
        );
        if (gate === "completion") expect(result.noEditNoBlocked).toBe(true);
        else expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
        expect(result.exitCode).toBe(1);
        expect(
          probe.mock.calls.filter(([, args]) => (args as string[]).includes("--all")),
        ).toHaveLength(1);
      } finally {
        probe.mockRestore();
      }
    },
  );

  it.each(["completion", "exploration"])(
    "accepts new bytes with and without a commit at %s",
    async (gate) => {
      for (const committed of [false, true]) {
        const result = await run(
          [
            { toolName: "read" },
            {
              toolName: "run",
              action: () => {
                writeFileSync(join(cwd, "tracked"), `new edit ${committed}\n`);
                if (committed) commit(cwd, git(cwd, "rev-parse", "HEAD"));
              },
            },
            { toolName: "read" },
            { toolName: "read" },
          ],
          undefined,
          gate === "exploration" ? 2 : 20,
        );
        expect(result.exitCode).toBe(0);
        expect(result.explorationBudgetExhausted).toBeUndefined();
      }
    },
  );

  it.each(["completion", "exploration"])(
    "rejects manually restored historical bytes at %s",
    async (gate) => {
      writeFileSync(join(cwd, "tracked"), "second commit\n");
      commit(cwd, launchHead);
      const result = await run(
        [
          { toolName: "run", action: () => writeFileSync(join(cwd, "tracked"), "original\n") },
          { toolName: "read" },
          { toolName: "read" },
          { toolName: "read" },
        ],
        undefined,
        gate === "exploration" ? 2 : 20,
      );
      if (gate === "completion") expect(result.noEditNoBlocked).toBe(true);
      else expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
    },
  );

  it.each(["completion", "exploration"])(
    "rejects amend and identical branch switches at %s",
    async (gate) => {
      const tree = git(cwd, "rev-parse", "HEAD^{tree}");
      const amended = git(cwd, "commit-tree", tree, "-m", "identical");
      git(cwd, "branch", "identical", amended);
      const result = await run(
        [
          {
            toolName: "run",
            action: () => {
              const head = git(cwd, "commit-tree", tree, "-m", "amend");
              git(cwd, "reset", "--soft", head);
              git(cwd, "switch", "identical");
            },
          },
          { toolName: "read" },
          { toolName: "read" },
          { toolName: "read" },
        ],
        undefined,
        gate === "exploration" ? 2 : 20,
      );
      if (gate === "completion") expect(result.noEditNoBlocked).toBe(true);
      else expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
    },
  );

  it.each(["failure", "overflow", "timeout"])(
    "uses only file-tool evidence on incomplete launch history: %s",
    async (kind) => {
      const spawn = childProcess.spawnSync;
      const tree = git(cwd, "rev-parse", "HEAD^{tree}");
      const probe = spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
        if (args[0] === "git" && (args[1] as string[]).includes("--all")) {
          const result = spawn(...args);
          return {
            ...result,
            status: kind === "failure" || kind === "timeout" ? 1 : 0,
            error:
              kind === "timeout"
                ? Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
                : undefined,
            stdout: Buffer.from(`${tree}\n`.repeat(10_001)),
          };
        }
        return spawn(...args);
      });
      try {
        for (const gate of ["completion", "exploration"]) {
          const result = await run(
            [
              {
                toolName: "run",
                action: () => writeFileSync(join(cwd, "tracked"), `new edit ${gate}\n`),
              },
              { toolName: "read" },
              { toolName: "read" },
              { toolName: "read" },
            ],
            undefined,
            gate === "exploration" ? 2 : 20,
          );
          expect(result.exitCode).toBe(1);
          if (gate === "completion") expect(result.noEditNoBlocked).toBe(true);
          else expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
          const fileEdit = await run(
            [
              { toolName: "read" },
              {
                toolName: "write",
                action: () => writeFileSync(join(cwd, "tracked"), `file edit ${gate}\n`),
                result: {
                  content: [{ type: "text", text: "Successfully wrote 20 bytes to tracked" }],
                },
              },
              { toolName: "read" },
              { toolName: "read" },
            ],
            undefined,
            gate === "exploration" ? 2 : 20,
          );
          expect(fileEdit.exitCode).toBe(0);
          expect(fileEdit.explorationBudgetExhausted).toBeUndefined();
          expect(
            readLastRunSummary(join(agentsRoot, "builder", "runs"))?.repositoryHistoryCheckSkipped,
          ).toBe(kind === "failure" ? "unavailable" : kind === "overflow" ? "limit" : "timeout");
        }
      } finally {
        probe.mockRestore();
      }
    },
  );

  it.each(["sha1", "sha256"])("matches Git trees without touching the index (%s)", (format) => {
    rmSync(join(cwd, ".git"), { recursive: true });
    git(cwd, "init", "--quiet", `--object-format=${format}`);
    for (const path of ["a/x", "a.c", "a0", "quoted\t\n-é", "empty"]) {
      mkdirSync(join(cwd, path, ".."), { recursive: true });
      writeFileSync(join(cwd, path), path === "empty" ? "" : path);
    }
    chmodSync(join(cwd, "a0"), 0o755);
    symlinkSync("a/x", join(cwd, "link"));
    commit(cwd);
    const indexPath = join(cwd, ".git", "index");
    const index = readFileSync(indexPath);
    const before = captureRepositoryState(cwd);
    expect(before.kind).toBe("git");
    if (before.kind !== "git") throw new Error("missing repository evidence");
    expect(before.tree).toBe(git(cwd, "rev-parse", "HEAD^{tree}"));
    expect(readFileSync(indexPath)).toEqual(index);
    rmSync(join(cwd, "a", "x"));
    const after = captureRepositoryState(cwd, before);
    expect(readFileSync(indexPath)).toEqual(index);
    expect(after.kind).toBe("git");
    if (after.kind !== "git") throw new Error("missing repository evidence");
    git(cwd, "add", "-u");
    expect(after.tree).toBe(git(cwd, "write-tree"));
  });

  it("retains launch paths removed from the final index and HEAD", async () => {
    const result = await run([
      {
        toolName: "run",
        action: () => {
          rmSync(join(cwd, "tracked"));
          commit(cwd, launchHead);
        },
      },
    ]);
    expect(result.exitCode).toBe(0);
  });

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
      expect(committed.noEditNoBlocked).toBe(true);
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

  it("fails closed when launch history is unavailable", async () => {
    const headFile = join(cwd, ".git", "HEAD");
    const saved = readFileSync(headFile);
    writeFileSync(headFile, "broken HEAD\n");
    const result = await run([
      {
        toolName: "bash",
        action: () => {
          writeFileSync(headFile, saved);
          writeFileSync(join(cwd, "tracked"), "new edit\n");
        },
      },
    ]);
    expect(result.noEditNoBlocked).toBe(true);
  });

  it.each(["completion", "exploration"])(
    "accepts new bytes despite a missing final HEAD object at %s",
    async (gate) => {
      const result = await run(
        [
          { toolName: "read" },
          {
            toolName: "run",
            action: () => {
              writeFileSync(join(cwd, "tracked"), "new bytes\n");
              writeFileSync(join(cwd, ".git", "HEAD"), `${"0".repeat(40)}\n`);
            },
          },
          { toolName: "read" },
          { toolName: "read" },
        ],
        undefined,
        gate === "exploration" ? 2 : 20,
      );
      expect(result.exitCode).toBe(0);
      expect(result.explorationBudgetExhausted).toBeUndefined();
    },
  );

  it.each(["completion", "exploration"])(
    "rejects a soft reset that restores only HEAD paths at %s",
    async (gate) => {
      writeFileSync(join(cwd, "old-only"), "old tracked bytes\n");
      const older = commit(cwd, launchHead);
      rmSync(join(cwd, "old-only"));
      commit(cwd, older);
      writeFileSync(join(cwd, "old-only"), "unchanged untracked bytes\n");
      const result = await run(
        [
          { toolName: "run", action: () => git(cwd, "reset", "--soft", older) },
          { toolName: "read" },
          { toolName: "read" },
          { toolName: "read" },
        ],
        undefined,
        gate === "exploration" ? 2 : 20,
      );
      if (gate === "completion") expect(result.noEditNoBlocked).toBe(true);
      else expect(result.explorationBudgetExhausted).toEqual({ limit: 2, nonProgressCalls: 4 });
    },
  );

  it("fails closed when the final index listing fails", () => {
    const before = captureRepositoryState(cwd);
    writeFileSync(join(cwd, "tracked"), "new edit\n");
    const spawn = childProcess.spawnSync;
    const probe = spyOn(childProcess, "spawnSync").mockImplementation((...args) => {
      const result = spawn(...args);
      return args[0] === "git" && (args[1] as string[]).includes("ls-files")
        ? { ...result, status: 1 }
        : result;
    });
    try {
      const after = captureRepositoryState(cwd, before);
      expect(after).toEqual({ kind: "unavailable" });
      expect(isVerifiedEdit("run", false, {}, { cwd, before, after })).toBe(false);
    } finally {
      probe.mockRestore();
    }
  });

  it.each(["completion", "exploration"])(
    "ignores removed launch commit objects at %s",
    async (gate) => {
      const result = await run(
        [
          { toolName: "read" },
          {
            toolName: "run",
            action: () => {
              writeFileSync(join(cwd, "tracked"), "new edit\n");
              commit(cwd, launchHead);
              rmSync(join(cwd, ".git", "objects", launchHead.slice(0, 2), launchHead.slice(2)));
            },
          },
          { toolName: "read" },
          { toolName: "read" },
        ],
        undefined,
        gate === "exploration" ? 2 : 20,
      );
      expect(result.exitCode).toBe(0);
      expect(result.explorationBudgetExhausted).toBeUndefined();
    },
  );

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
