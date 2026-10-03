// publish end to end (bob#275, S2b): apply_patch -> candidate -> checks ->
// publish -> interrupted-push recovery, against a real local bare remote (no
// network), driven through the tools the capability registers.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WorkPiLike, wireWork } from "../../../src/capabilities/work/capability.js";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";

interface ToolOut {
  details: Record<string, unknown>;
  text: string;
}

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-publish-e2e-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Tools {
  apply_patch: { execute: (id: string, p: unknown) => Promise<ToolOut> };
  run: {
    execute: (
      id: string,
      p: unknown,
      signal?: unknown,
      update?: unknown,
      ctx?: { cwd: string },
    ) => Promise<ToolOut>;
  };
  publish: { execute: (id: string, p: unknown, signal?: AbortSignal) => Promise<ToolOut> };
  manager: ReturnType<typeof wireWork>["manager"];
  stateRoot: string;
}

function wireTools(
  b: TaskBinding | undefined,
  stateRoot: string,
  publishDeps?: unknown,
  maxLiveJobs?: number,
): Tools {
  const tools: Record<string, { execute: (id: string, p: unknown) => Promise<ToolOut> }> = {};
  const fake: WorkPiLike = {
    registerTool(tool) {
      tools[tool.name] = tool as unknown as {
        execute: (id: string, p: unknown) => Promise<ToolOut>;
      };
    },
  };
  const { manager } = wireWork({
    pi: fake,
    stateRoot,
    log: () => {},
    ...(maxLiveJobs !== undefined ? { maxLiveJobs } : {}),
    ...(b !== undefined ? { taskBinding: b } : {}),
    ...(publishDeps !== undefined ? { publishDeps: publishDeps as never } : {}),
  });
  return {
    apply_patch: tools.apply_patch,
    run: tools.run,
    publish: tools.publish,
    manager,
    stateRoot,
  };
}

describe("publish end to end — interrupted push, then recovery", () => {
  it("publishes the exact stored candidate after an interrupted push, with no extra commit", async () => {
    const repo = join(scratch, "repo");
    const bare = join(scratch, "remote.git");
    const artifactRoot = join(scratch, "artifacts");
    const stateRoot = join(scratch, "state");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    git(["init", "-q"], repo);
    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo);
    git(["init", "-q", "--bare", bare], scratch);
    git(["push", bare, "HEAD:refs/heads/main"], repo);

    // A patch changing the declared file.
    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 2;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "change"], repo);
    const tree = git(["rev-parse", "HEAD^{tree}"], repo);
    const diff = spawnSync("git", ["diff", "--binary", "-M", "-C", base, "HEAD"], {
      cwd: repo,
      env: gitEnv(),
      encoding: "buffer",
    });
    const patch = Buffer.from(diff.stdout);
    git(["reset", "--hard", "-q", base], repo);
    writeFileSync(join(artifactRoot, "p.patch"), patch);

    const binding: TaskBinding = {
      task_id: "task-1",
      publication_id: "pub-e2e",
      repository: repo,
      workspace: repo,
      base_oid: base,
      mode: "build",
      artifact_root: artifactRoot,
      declared_paths: ["src/widget.ts"],
      // A real check that the materialized candidate holds the declared file.
      check_commands: ["test -f src/widget.ts"],
      destination: { remote: bare, ref: "refs/heads/main", create: true },
    };

    let interrupt = true;
    const t = wireTools(binding, stateRoot, {
      afterPushAccepted: () => {
        if (interrupt) throw new Error("publisher terminated");
      },
    });

    // 1. apply_patch -> a stored candidate.
    const applied = await t.apply_patch.execute("c1", {
      patch_artifact: { path: "p.patch", sha256: sha256(patch) },
      expected_base: base,
    });
    expect(applied.details.refused).toBe(false);
    expect(applied.details.tree_oid).toBe(tree);
    const candidateId = String(applied.details.candidate_id);

    // 2. publish -> the push lands but the publisher is terminated before it
    // records success.
    await expect(
      t.publish.execute("c2", { candidate_id: candidateId, commit_message: "feat: e2e" }),
    ).rejects.toThrow("publisher terminated");
    const pushed = git(["rev-parse", "refs/heads/main"], bare);
    expect(git(["rev-parse", `${pushed}^{tree}`], bare)).toBe(tree);
    expect(Number(git(["rev-list", "--count", "refs/heads/main"], bare))).toBe(2);

    // 3. Retry -> recovery records the exact persisted commit, no extra commit.
    interrupt = false;
    const recovered = await t.publish.execute("c3", {
      candidate_id: candidateId,
      commit_message: "feat: e2e",
    });
    expect(recovered.details.status).toBe("published");
    expect(recovered.details.commit_oid).toBe(pushed);
    expect(Number(git(["rev-list", "--count", "refs/heads/main"], bare))).toBe(2);

    t.manager.endRunSync();
  });

  it("refuses a candidate that is not the recorded one, by name, without touching the remote", async () => {
    const repo = join(scratch, "repo");
    const bare = join(scratch, "remote.git");
    const stateRoot = join(scratch, "state");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q"], repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo);
    git(["init", "-q", "--bare", bare], scratch);
    git(["push", bare, "HEAD:refs/heads/main"], repo);
    const binding: TaskBinding = {
      task_id: "task-1",
      publication_id: "pub-e2e-2",
      repository: repo,
      workspace: repo,
      base_oid: base,
      mode: "build",
      artifact_root: join(scratch, "artifacts"),
      declared_paths: [],
      check_commands: [],
      destination: { remote: bare, ref: "refs/heads/main", create: true },
    };
    const t = wireTools(binding, stateRoot);
    const before = git(["rev-parse", "refs/heads/main"], bare);
    const out = await t.publish.execute("c1", {
      candidate_id: "0".repeat(40),
      commit_message: "x",
    });
    expect(out.details.status).toBe("refused");
    expect(out.details.reason).toBe("candidate_unknown");
    expect(git(["rev-parse", "refs/heads/main"], bare)).toBe(before);
    t.manager.endRunSync();
  });

  it("publication checks exclude BOB_TEST_CREDENTIAL and BASH_ENV", async () => {
    const repo = join(scratch, "repo");
    const bare = join(scratch, "remote.git");
    const artifactRoot = join(scratch, "artifacts");
    const stateRoot = join(scratch, "state");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    git(["init", "-q"], repo);
    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo);
    git(["init", "-q", "--bare", bare], scratch);
    git(["push", bare, "HEAD:refs/heads/main"], repo);

    // A patch changing the declared file.
    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 2;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "change"], repo);
    const diff = spawnSync("git", ["diff", "--binary", "-M", "-C", base, "HEAD"], {
      cwd: repo,
      env: gitEnv(),
      encoding: "buffer",
    });
    const patch = Buffer.from(diff.stdout);
    git(["reset", "--hard", "-q", base], repo);
    writeFileSync(join(artifactRoot, "p.patch"), patch);

    const binding: TaskBinding = {
      task_id: "task-1",
      publication_id: "pub-e2e",
      repository: repo,
      workspace: repo,
      base_oid: base,
      mode: "build",
      artifact_root: artifactRoot,
      declared_paths: ["src/widget.ts"],
      // A real check that the materialized candidate holds the declared file.
      check_commands: [
        'test -z "$BOB_TEST_CREDENTIAL$BASH_ENV" && test "$(cat src/widget.ts)" = "export const widget = 2;"',
      ],
      destination: { remote: bare, ref: "refs/heads/main", create: true },
    };

    const old = process.env.BOB_TEST_CREDENTIAL;
    const oldBashEnv = process.env.BASH_ENV;
    process.env.BOB_TEST_CREDENTIAL = "secret-fixture";
    const startup = join(scratch, "startup.sh");
    writeFileSync(startup, "exit 41\n");
    process.env.BASH_ENV = startup;
    const t = wireTools(binding, stateRoot);
    try {
      const applied = await t.apply_patch.execute("apply", {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: base,
      });
      const out = await t.publish.execute("publish", {
        candidate_id: applied.details.candidate_id,
        commit_message: "check env",
      });
      expect(out.details.status).toBe("published");
    } finally {
      if (old === undefined) delete process.env.BOB_TEST_CREDENTIAL;
      else process.env.BOB_TEST_CREDENTIAL = old;
      if (oldBashEnv === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = oldBashEnv;
      t.manager.endRunSync();
    }
  });

  it("an ordinary successful run cannot satisfy a candidate publication check", async () => {
    const repo = join(scratch, "repo");
    const bare = join(scratch, "remote.git");
    const artifactRoot = join(scratch, "artifacts");
    const stateRoot = join(scratch, "state");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    git(["init", "-q"], repo);
    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo);
    git(["init", "-q", "--bare", bare], scratch);
    git(["push", bare, "HEAD:refs/heads/main"], repo);

    // A patch changing the declared file.
    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 2;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "change"], repo);
    const diff = spawnSync("git", ["diff", "--binary", "-M", "-C", base, "HEAD"], {
      cwd: repo,
      env: gitEnv(),
      encoding: "buffer",
    });
    const patch = Buffer.from(diff.stdout);
    git(["reset", "--hard", "-q", base], repo);
    writeFileSync(join(artifactRoot, "p.patch"), patch);

    const binding: TaskBinding = {
      task_id: "task-1",
      publication_id: "pub-e2e",
      repository: repo,
      workspace: repo,
      base_oid: base,
      mode: "build",
      artifact_root: artifactRoot,
      declared_paths: ["src/widget.ts"],
      // A real check that the materialized candidate holds the declared file.
      check_commands: ['test "$(cat src/widget.ts)" = "export const widget = 1;"'],
      destination: { remote: bare, ref: "refs/heads/main", create: true },
    };

    const t = wireTools(binding, stateRoot);
    try {
      const ordinary = await t.run.execute(
        "run",
        { command: binding.check_commands[0] },
        undefined,
        undefined,
        { cwd: repo },
      );
      expect(ordinary.details.outcome).toBe("exited");
      expect(ordinary.details.exit_code).toBe(0);
      const applied = await t.apply_patch.execute("apply", {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: base,
      });
      const out = await t.publish.execute("publish", {
        candidate_id: applied.details.candidate_id,
        commit_message: "candidate evidence",
      });
      expect(out.details.status).toBe("refused");
      expect(out.details.reason).toBe("check_failed");
      expect(git(["rev-parse", "refs/heads/main"], bare)).toBe(base);
    } finally {
      t.manager.endRunSync();
    }
  });

  it("an abort of the publish call while a check runs cancels that check and never pushes", async () => {
    const repo = join(scratch, "repo");
    const bare = join(scratch, "remote.git");
    const artifactRoot = join(scratch, "artifacts");
    const stateRoot = join(scratch, "state");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    git(["init", "-q"], repo);
    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo);
    git(["init", "-q", "--bare", bare], scratch);
    git(["push", bare, "HEAD:refs/heads/main"], repo);

    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 2;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "change"], repo);
    const diff = spawnSync("git", ["diff", "--binary", "-M", "-C", base, "HEAD"], {
      cwd: repo,
      env: gitEnv(),
      encoding: "buffer",
    });
    const patch = Buffer.from(diff.stdout);
    git(["reset", "--hard", "-q", base], repo);
    writeFileSync(join(artifactRoot, "p.patch"), patch);

    const binding: TaskBinding = {
      task_id: "task-1",
      publication_id: "pub-e2e-abort",
      repository: repo,
      workspace: repo,
      base_oid: base,
      mode: "build",
      artifact_root: artifactRoot,
      declared_paths: ["src/widget.ts"],
      check_commands: ["sleep 60"],
      destination: { remote: bare, ref: "refs/heads/main", create: true },
    };

    const t = wireTools(binding, stateRoot);
    try {
      const applied = await t.apply_patch.execute("apply", {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: base,
      });
      const ac = new AbortController();
      const started = setInterval(() => {
        if (t.manager.list().length > 0) {
          clearInterval(started);
          ac.abort();
        }
      }, 10);
      const out = await t.publish.execute(
        "publish",
        { candidate_id: applied.details.candidate_id, commit_message: "aborted" },
        ac.signal,
      );
      clearInterval(started);
      expect(out.details.status).toBe("refused");
      expect(out.details.reason).toBe("aborted");
      expect(git(["rev-parse", "refs/heads/main"], bare)).toBe(base);
      const [job] = t.manager.list();
      await job.done;
      expect(t.manager.report(job).outcome).toBe("cancelled");
    } finally {
      t.manager.endRunSync();
    }
  });

  it("an aborted publish returns after the cancelled check has exited, and an immediate retry runs its check", async () => {
    const repo = join(scratch, "repo");
    const bare = join(scratch, "remote.git");
    const artifactRoot = join(scratch, "artifacts");
    const stateRoot = join(scratch, "state");
    const go = join(scratch, "go");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    git(["init", "-q"], repo);
    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo);
    git(["init", "-q", "--bare", bare], scratch);
    git(["push", bare, "HEAD:refs/heads/main"], repo);

    writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 2;\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "change"], repo);
    const diff = spawnSync("git", ["diff", "--binary", "-M", "-C", base, "HEAD"], {
      cwd: repo,
      env: gitEnv(),
      encoding: "buffer",
    });
    const patch = Buffer.from(diff.stdout);
    git(["reset", "--hard", "-q", base], repo);
    writeFileSync(join(artifactRoot, "p.patch"), patch);

    const binding: TaskBinding = {
      task_id: "task-1",
      publication_id: "pub-e2e-abort-retry",
      repository: repo,
      workspace: repo,
      base_oid: base,
      mode: "build",
      artifact_root: artifactRoot,
      declared_paths: ["src/widget.ts"],
      check_commands: [`test -f '${go}' || sleep 60`],
      destination: { remote: bare, ref: "refs/heads/main", create: true },
    };

    const t = wireTools(binding, stateRoot, undefined, 1);
    try {
      const applied = await t.apply_patch.execute("apply", {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: base,
      });
      const ac = new AbortController();
      const started = setInterval(() => {
        if (t.manager.list().length > 0) {
          clearInterval(started);
          ac.abort();
        }
      }, 10);
      const out = await t.publish.execute(
        "publish",
        { candidate_id: applied.details.candidate_id, commit_message: "aborted" },
        ac.signal,
      );
      clearInterval(started);
      expect(out.details.reason).toBe("aborted");
      // The check process has exited before publish returned.
      const [job] = t.manager.list();
      expect(job.phase).toBe("finished");
      expect(t.manager.report(job).outcome).toBe("cancelled");
      expect(readdirSync(stateRoot).filter((n) => n.startsWith("publish-checkout-"))).toEqual([]);

      writeFileSync(go, "");
      const retry = await t.publish.execute("retry", {
        candidate_id: applied.details.candidate_id,
        commit_message: "aborted",
      });
      expect(retry.details.reason).toBeUndefined();
      expect(retry.details.status).toBe("published");
    } finally {
      t.manager.endRunSync();
    }
  });

  it("without a task binding, publish refuses by name (unknown_task)", async () => {
    const t = wireTools(undefined, join(scratch, "state"));
    const out = await t.publish.execute("c1", {
      candidate_id: "0".repeat(40),
      commit_message: "x",
    });
    expect(out.details.status).toBe("refused");
    expect(out.details.reason).toBe("unknown_task");
    t.manager.endRunSync();
  });
});
