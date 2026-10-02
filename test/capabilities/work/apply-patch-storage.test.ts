import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
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
          ...deps,
        },
      }),
  };
}

describe("candidate storage with stubbed git and real filesystem operations", () => {
  it("stores a complete owner-only record from a private staging directory", () => {
    const fx = setup();
    const out = fx.apply({
      writeCandidateRecord: (fd, data) => {
        const stages = readdirSync(fx.dir);
        expect(stages).toHaveLength(1);
        const stage = join(fx.dir, stages[0]);
        expect(lstatSync(stage).isDirectory()).toBe(true);
        expect(lstatSync(stage).mode & 0o777).toBe(0o700);
        expect(readdirSync(stage)).toEqual(["record.json"]);
        writeFileSync(fd, data);
        expect(readFileSync(join(stage, "record.json"), "utf8")).toBe(data);
      },
    });
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
          const stage = readdirSync(fx.dir).find((name) => name.startsWith(".tmp-"));
          expect(stage).toBeDefined();
          expect(readFileSync(join(fx.dir, stage as string, "record.json"), "utf8")).toBe(data);
          wrote = true;
        },
      });
      expect(wrote).toBe(true);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe("storage_failed");
        expect(out.message).toContain("changed after it was pinned");
      }
      expect(readdirSync(fx.dir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
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

  for (const mode of [0o720, 0o702, 0o750, 0o705]) {
    it(`refuses candidate directory mode ${mode.toString(8)} before writing`, () => {
      const fx = setup();
      mkdirSync(fx.dir, { recursive: true, mode: 0o700 });
      chmodSync(fx.dir, mode);
      let wrote = false;
      const out = fx.apply({
        writeCandidateRecord: () => {
          wrote = true;
        },
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("storage_failed");
      expect(wrote).toBe(false);
      expect(readdirSync(fx.dir)).toEqual([]);
      fx.assertUntouched();
    });
  }

  for (const replacement of ["symlink", "file"] as const) {
    it(`refuses a candidates ${replacement} before writing`, () => {
      const fx = setup();
      mkdirSync(fx.stateRoot, { mode: 0o700 });
      if (replacement === "symlink") symlinkSync(fx.repo, fx.dir);
      else writeFileSync(fx.dir, "occupied");
      let wrote = false;
      const out = fx.apply({
        writeCandidateRecord: () => {
          wrote = true;
        },
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("storage_failed");
      expect(wrote).toBe(false);
      fx.assertUntouched();
    });
  }

  it("refuses a foreign owner reported by fstat before writing", () => {
    const fx = setup();
    const actualFstat = fs.fstatSync;
    const stat = spyOn(fs, "fstatSync").mockImplementation(((
      ...args: Parameters<typeof actualFstat>
    ) => {
      const result = actualFstat(...args);
      if (typeof result.uid === "bigint") result.uid += 1n;
      return result;
    }) as typeof actualFstat);
    try {
      let wrote = false;
      const out = fx.apply({
        writeCandidateRecord: () => {
          wrote = true;
        },
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe("storage_failed");
        expect(out.message).toContain("owned by uid");
      }
      expect(wrote).toBe(false);
      expect(readdirSync(fx.dir)).toEqual([]);
      fx.assertUntouched();
    } finally {
      stat.mockRestore();
    }
  });

  it("a failed staging-directory removal rolls back the renamed record", () => {
    const fx = setup();
    const out = fx.apply({
      writeCandidateRecord: (fd, data) => {
        writeFileSync(fd, data);
        const [stage] = readdirSync(fx.dir);
        writeFileSync(join(fx.dir, stage, "block-removal"), "occupied");
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("storage_failed");
    expect(readdirSync(fx.dir)).toEqual([]);
    fx.assertUntouched();
  });

  it("a failed staging-directory creation refuses without leaving a record", () => {
    const fx = setup();
    const actualMkdtemp = fs.mkdtempSync;
    const makeTemp = spyOn(fs, "mkdtempSync").mockImplementation(((
      ...args: Parameters<typeof actualMkdtemp>
    ) => {
      if (String(args[0]) === join(fx.dir, ".tmp-")) throw new Error("mkdtemp failed");
      return actualMkdtemp(...args);
    }) as typeof actualMkdtemp);
    try {
      const out = fx.apply();
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe("storage_failed");
        expect(out.message).toContain("mkdtemp failed");
      }
      expect(readdirSync(fx.dir)).toEqual([]);
      fx.assertUntouched();
    } finally {
      makeTemp.mockRestore();
    }
  });

  it("a failed record open removes the staging directory", () => {
    const fx = setup();
    const actualOpen = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation((...args) => {
      if (basename(String(args[0])) === "record.json") throw new Error("open failed");
      return actualOpen(...args);
    });
    try {
      const out = fx.apply();
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe("storage_failed");
        expect(out.message).toContain("open failed");
      }
      expect(readdirSync(fx.dir)).toEqual([]);
      fx.assertUntouched();
    } finally {
      open.mockRestore();
    }
  });

  for (const failedClose of ["record", "directory"] as const) {
    it(`a failed ${failedClose} close refuses and removes the created record`, () => {
      const fx = setup();
      const actualOpen = fs.openSync;
      const actualClose = fs.closeSync;
      let targetFd: number | undefined;
      let injected = false;
      const open = spyOn(fs, "openSync").mockImplementation((...args) => {
        const fd = actualOpen(...args);
        if (failedClose === "directory" && String(args[0]) === fx.dir) targetFd = fd;
        return fd;
      });
      const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
        actualClose(fd);
        if (fd === targetFd && !injected) {
          injected = true;
          throw new Error(`${failedClose} close failed`);
        }
      });
      try {
        const out = fx.apply({
          writeCandidateRecord: (fd, data) => {
            if (failedClose === "record") targetFd = fd;
            writeFileSync(fd, data);
          },
        });
        expect(injected).toBe(true);
        expect(out.ok).toBe(false);
        if (!out.ok) {
          expect(out.reason).toBe("storage_failed");
          expect(out.message).toContain(`${failedClose} close failed`);
        }
        expect(readdirSync(fx.dir)).toEqual([]);
        fx.assertUntouched();
      } finally {
        open.mockRestore();
        close.mockRestore();
      }
    });
  }
});
