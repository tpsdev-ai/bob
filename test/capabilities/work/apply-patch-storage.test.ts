import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type ApplyPatchDeps,
  applyPatch,
  candidateRecordPath,
} from "../../../src/capabilities/work/apply-patch.js";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-candidate-storage-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function setup() {
  const repo = join(scratch, "repo");
  const artifactRoot = join(scratch, "artifacts");
  mkdirSync(repo);
  mkdirSync(artifactRoot);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  };
  git(["init", "-q"]);
  writeFileSync(join(repo, "a.txt"), "unchanged\n");
  git(["add", "a.txt"]);
  const patch = Buffer.from("stubbed git input\n");
  writeFileSync(join(artifactRoot, "p.patch"), patch);
  const digest = createHash("sha256").update(patch).digest("hex");
  const tree = "b".repeat(40);
  const binding: TaskBinding = {
    task_id: "task-1",
    publication_id: "pub-1",
    repository: repo,
    workspace: repo,
    base_oid: "a".repeat(40),
    mode: "build",
    artifact_root: artifactRoot,
    declared_paths: [],
    check_commands: [],
    destination: { remote: "origin", ref: "refs/heads/main" },
  };
  const id = createHash("sha256")
    .update(
      [binding.task_id, binding.publication_id, repo, binding.base_oid, tree, digest].join("\0"),
    )
    .digest("hex")
    .slice(0, 40);
  const stateRoot = join(scratch, "state");
  const dir = join(stateRoot, "candidates");
  const checkout = () => ({
    files: readdirSync(repo, { recursive: true }).sort(),
    content: readFileSync(join(repo, "a.txt")),
    index: readFileSync(join(repo, ".git", "index")),
    head: readFileSync(join(repo, ".git", "HEAD")),
  });
  const before = checkout();
  return {
    repo,
    dir,
    stateRoot,
    tree,
    recordPath: candidateRecordPath(stateRoot, id),
    assertUntouched: () => expect(checkout()).toEqual(before),
    apply: (deps: ApplyPatchDeps = {}) =>
      applyPatch({
        binding,
        params: {
          patch_artifact: { path: "p.patch", sha256: digest },
          expected_base: binding.base_oid,
        },
        stateRoot,
        deps: {
          git: (args) => {
            switch (args[0]) {
              case "read-tree":
              case "apply":
              case "diff-tree":
                return { status: 0, stdout: "", stderr: "" };
              case "write-tree":
                return { status: 0, stdout: tree, stderr: "" };
              default:
                throw new Error(`unexpected git call: ${args.join(" ")}`);
            }
          },
          uniqueSuffix: () => "storage-test",
          ...deps,
        },
      }),
  };
}

describe("candidate storage with stubbed git and real filesystem operations", () => {
  it("stores a complete owner-only record by path", () => {
    const fx = setup();
    const out = fx.apply();
    expect(out.ok).toBe(true);
    expect(JSON.parse(readFileSync(fx.recordPath, "utf8")).tree_oid).toBe(fx.tree);
    expect(lstatSync(fx.recordPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(fx.dir)).toHaveLength(1);
    fx.assertUntouched();
  });

  for (const replacement of ["symlink", "directory"] as const) {
    it(`a candidates ${replacement} swapped after the pin: storage_failed, created file removed, checkout unchanged`, () => {
      const fx = setup();
      const moved = join(fx.stateRoot, "pinned-candidates");
      let wrote = false;
      const out = fx.apply({
        beforeCandidateWrite: (dir) => {
          renameSync(dir, moved);
          if (replacement === "symlink") symlinkSync(fx.repo, dir);
          else mkdirSync(dir, { mode: 0o700 });
        },
        writeCandidateRecord: (fd, data) => {
          writeFileSync(fd, data);
          expect(readFileSync(join(fx.dir, ".tmp-storage-test"), "utf8")).toBe(data);
          wrote = true;
        },
      });
      expect(wrote).toBe(true);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe("storage_failed");
        expect(out.message).toContain("changed after it was pinned");
      }
      expect(existsSync(join(fx.dir, ".tmp-storage-test"))).toBe(false);
      expect(existsSync(fx.recordPath)).toBe(false);
      expect(readdirSync(moved)).toEqual([]);
      fx.assertUntouched();
    });
  }

  it("a failed write removes the partial temporary record", () => {
    const fx = setup();
    const out = fx.apply({
      writeCandidateRecord: (fd) => {
        writeFileSync(fd, "partial");
        throw new Error("write failed");
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("storage_failed");
      expect(out.message).toContain("write failed");
    }
    expect(readdirSync(fx.dir)).toEqual([]);
    fx.assertUntouched();
  });

  it("a failed rename removes the temporary record", () => {
    const fx = setup();
    const out = fx.apply({
      beforeCandidateWrite: () => mkdirSync(fx.recordPath),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("storage_failed");
    expect(readdirSync(fx.dir)).toEqual([basename(fx.recordPath)]);
    fx.assertUntouched();
  });
});
