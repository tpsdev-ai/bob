// apply_patch (bob#275, S2a): deterministic patch application against a fresh,
// tool-owned index.
//
// Local git fixtures, no network. Cases drive the tool the capability registers
// (through wireWork) or applyPatch directly; the success cases apply a real
// patch and assert the resulting tree, and that the caller's worktree, index and
// HEAD are byte-identical after.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPatch,
  candidateRecordPath,
  type GitInvocation,
  type GitResult,
} from "../../../src/capabilities/work/apply-patch.js";
import { type WorkPiLike, wireWork } from "../../../src/capabilities/work/capability.js";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-apply-patch-"));
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

function run(args: string[], cwd: string, input?: Buffer): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    env: gitEnv(),
    input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

function git(args: string[], cwd: string): string {
  const r = run(args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The candidate id the tool derives, so a test can occupy the record's final
// name (the fixtures' binding uses task-1 / pub-1).
function candidateId(fx: Fixture, tree: string, digest: string): string {
  return createHash("sha256")
    .update(Buffer.from(["task-1", "pub-1", fx.repo, fx.base, tree, digest].join("\0")))
    .digest("hex")
    .slice(0, 40);
}

interface Fixture {
  repo: string;
  base: string;
  artifactRoot: string;
}

function makeFixture(): Fixture {
  const repo = join(scratch, "repo");
  const artifactRoot = join(scratch, "artifacts");
  mkdirSync(repo, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  git(["init", "-q"], repo);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  writeFileSync(join(repo, "b.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "crlf.txt"), "l1\r\nl2\r\n");
  mkdirSync(join(repo, "dir"), { recursive: true });
  writeFileSync(join(repo, "dir", "x.txt"), "x\n");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 254, 255]));
  git(["add", "-A"], repo);
  git(["commit", "-qm", "base"], repo);
  return { repo, base: git(["rev-parse", "HEAD"], repo), artifactRoot };
}

// Make a change, produce a binary patch from `base` to it, then restore the
// repo to `base` (so the caller's checkout is at the pinned base when the tool
// runs).
function patchFrom(fx: Fixture, mutate: (repo: string) => void): { patch: Buffer; tree: string } {
  mutate(fx.repo);
  git(["add", "-A"], fx.repo);
  git(["commit", "-qm", "change"], fx.repo);
  const tree = git(["rev-parse", "HEAD^{tree}"], fx.repo);
  const diff = run(["diff", "--binary", "-M", "-C", fx.base, "HEAD"], fx.repo);
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  const patch = Buffer.from(diff.stdout, "utf8");
  git(["reset", "--hard", "-q", fx.base], fx.repo);
  return { patch, tree };
}

function writeArtifact(fx: Fixture, name: string, bytes: Buffer): string {
  writeFileSync(join(fx.artifactRoot, name), bytes);
  return name;
}

function binding(fx: Fixture, over: Partial<TaskBinding> = {}): TaskBinding {
  return {
    task_id: "task-1",
    publication_id: "pub-1",
    repository: fx.repo,
    workspace: fx.repo,
    base_oid: fx.base,
    mode: "build",
    artifact_root: fx.artifactRoot,
    declared_paths: [],
    check_commands: [],
    destination: { remote: "origin", ref: "refs/heads/main" },
    ...over,
  };
}

interface Applied {
  details: Record<string, unknown>;
  text: string;
}

// Drive the tool the capability registered, through wireWork.
function wire(b: TaskBinding | undefined, opts: { bindingError?: string; deps?: unknown } = {}) {
  const tools: Record<string, { execute: (id: string, params: unknown) => Promise<Applied> }> = {};
  const fake: WorkPiLike = {
    registerTool(tool) {
      tools[tool.name] = tool as unknown as {
        execute: (id: string, params: unknown) => Promise<Applied>;
      };
    },
  };
  const { manager } = wireWork({
    pi: fake,
    stateRoot: join(scratch, "state"),
    log: () => {},
    ...(b !== undefined ? { taskBinding: b } : {}),
    ...(opts.bindingError !== undefined ? { taskBindingError: opts.bindingError } : {}),
    ...(opts.deps !== undefined ? { applyPatchDeps: opts.deps } : {}),
  });
  return {
    manager,
    stateRoot: join(scratch, "state"),
    async apply(params: unknown): Promise<Applied> {
      return tools.apply_patch.execute("call-1", params);
    },
  };
}

function snapshot(repo: string): Record<string, string> {
  return {
    head: git(["rev-parse", "HEAD"], repo),
    tree: git(["rev-parse", "HEAD^{tree}"], repo),
    refs: git(["show-ref"], repo),
    status: run(["status", "--porcelain"], repo).stdout,
    index: sha256(readFileSync(join(repo, ".git", "index"))),
  };
}

describe("apply_patch — success shapes yield the expected tree", () => {
  const shapes: Array<{ name: string; mutate: (repo: string) => void }> = [
    { name: "add", mutate: (r) => writeFileSync(join(r, "added.txt"), "new\n") },
    { name: "modify", mutate: (r) => writeFileSync(join(r, "a.txt"), "hello world\n") },
    { name: "delete", mutate: (r) => rmSync(join(r, "b.txt")) },
    {
      name: "rename",
      mutate: (r) => {
        git(["mv", "dir/x.txt", "dir/y.txt"], r);
      },
    },
    { name: "exec bit", mutate: (r) => chmodSync(join(r, "dir", "x.txt"), 0o755) },
    {
      name: "binary",
      mutate: (r) => writeFileSync(join(r, "bin.dat"), Buffer.from([9, 8, 7, 250, 251, 0])),
    },
    {
      name: "preserved line endings",
      mutate: (r) => writeFileSync(join(r, "crlf.txt"), "l1\r\nl2\r\nl3\r\n"),
    },
    {
      name: "trailing whitespace is not repaired",
      mutate: (r) => writeFileSync(join(r, "a.txt"), "hello  \n"),
    },
  ];

  for (const shape of shapes) {
    it(`${shape.name}: the returned tree_oid equals the change's tree and the caller is untouched`, async () => {
      const fx = makeFixture();
      const { patch, tree } = patchFrom(fx, shape.mutate);
      writeArtifact(fx, "p.patch", patch);
      const before = snapshot(fx.repo);

      const w = wire(binding(fx));
      const out = await w.apply({
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: fx.base,
      });
      w.manager.endRunSync();

      expect(out.details.refused).toBe(false);
      expect(out.details.tree_oid).toBe(tree);
      expect(out.details.base_oid).toBe(fx.base);
      expect(out.details.patch_sha256).toBe(sha256(patch));
      expect(Array.isArray(out.details.changed_paths)).toBe(true);
      // The candidate record exists under the tool-owned state root.
      expect(existsSync(candidateRecordPath(w.stateRoot, String(out.details.candidate_id)))).toBe(
        true,
      );
      // The caller's checkout is byte-identical.
      expect(snapshot(fx.repo)).toEqual(before);
    });
  }

  it("a patch with add/modify/delete/rename/exec/binary in one go reports every changed path", async () => {
    const fx = makeFixture();
    const { patch, tree } = patchFrom(fx, (r) => {
      writeFileSync(join(r, "added.txt"), "new\n");
      writeFileSync(join(r, "a.txt"), "hello world\n");
      rmSync(join(r, "b.txt"));
      writeFileSync(join(r, "bin.dat"), Buffer.from([9, 8, 7]));
      chmodSync(join(r, "dir", "x.txt"), 0o755);
      git(["mv", "dir/x.txt", "dir/y.txt"], r);
    });
    writeArtifact(fx, "p.patch", patch);
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(patch) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.tree_oid).toBe(tree);
    const changed = out.details.changed_paths as string[];
    for (const p of ["added.txt", "a.txt", "b.txt", "bin.dat", "dir/x.txt", "dir/y.txt"]) {
      expect(changed).toContain(p);
    }
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("concurrent calls use independent indexes and both succeed", async () => {
    const fx = makeFixture();
    const one = patchFrom(fx, (r) => writeFileSync(join(r, "one.txt"), "1\n"));
    // `patchFrom` resets to base, so build the second patch from the same base.
    const two = patchFrom(fx, (r) => writeFileSync(join(r, "two.txt"), "2\n"));
    writeArtifact(fx, "one.patch", one.patch);
    writeArtifact(fx, "two.patch", two.patch);
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const [r1, r2] = await Promise.all([
      w.apply({
        patch_artifact: { path: "one.patch", sha256: sha256(one.patch) },
        expected_base: fx.base,
      }),
      w.apply({
        patch_artifact: { path: "two.patch", sha256: sha256(two.patch) },
        expected_base: fx.base,
      }),
    ]);
    w.manager.endRunSync();
    expect(r1.details.tree_oid).toBe(one.tree);
    expect(r2.details.tree_oid).toBe(two.tree);
    expect(r1.details.candidate_id).not.toBe(r2.details.candidate_id);
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("apply mode accepts the task-authorized artifact", async () => {
    const fx = makeFixture();
    const { patch, tree } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const w = wire(
      binding(fx, { mode: "apply", patch_sha256: sha256(patch), expected_tree_oid: tree }),
    );
    const before = snapshot(fx.repo);
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(patch) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.tree_oid).toBe(tree);
    expect(snapshot(fx.repo)).toEqual(before);
  });
});

describe("apply_patch — no scratch outlives the call (bob#277 leak check)", () => {
  it("a success and a refusal that reaches the index both leave no scratch dir", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const w = wire(binding(fx));

    const ok = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(patch) },
      expected_base: fx.base,
    });
    expect(ok.details.refused).toBe(false);
    // The only entry the tool left under its state root is the candidate record.
    expect(readdirSync(w.stateRoot)).toEqual(["candidates"]);

    // A refusal that parses the patch and reaches the fresh index must not leave
    // the scratch directory behind either.
    const nope = Buffer.from(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-nope\n+stillnope\n",
    );
    writeArtifact(fx, "nope.patch", nope);
    const refused = await w.apply({
      patch_artifact: { path: "nope.patch", sha256: sha256(nope) },
      expected_base: fx.base,
    });
    expect(refused.details.refused).toBe(true);
    expect(readdirSync(w.stateRoot).filter((n) => n.startsWith("apply-"))).toEqual([]);
    w.manager.endRunSync();
  });
});

describe("apply_patch — refusals carry a stable reason and leave the checkout untouched", () => {
  it("no task binding: unknown_task", async () => {
    const fx = makeFixture();
    const before = snapshot(fx.repo);
    const w = wire(undefined);
    const out = await w.apply({
      patch_artifact: { path: "x", sha256: "0".repeat(64) },
      expected_base: "a".repeat(40),
    });
    w.manager.endRunSync();
    expect(out.details.refused).toBe(true);
    expect(out.details.reason).toBe("unknown_task");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("a malformed binding: invalid_binding", async () => {
    const fx = makeFixture();
    const before = snapshot(fx.repo);
    const w = wire(undefined, {
      bindingError: 'task binding is invalid: mode must be "build" or "apply"',
    });
    const out = await w.apply({
      patch_artifact: { path: "x", sha256: "0".repeat(64) },
      expected_base: "a".repeat(40),
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("invalid_binding");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("a malformed expected_base: invalid_base", async () => {
    const fx = makeFixture();
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: "0".repeat(64) },
      expected_base: "not-a-commit",
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("invalid_base");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("the wrong base: base_mismatch", async () => {
    const fx = makeFixture();
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: "0".repeat(64) },
      expected_base: "b".repeat(40),
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("base_mismatch");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("a missing artifact: artifact_missing", async () => {
    const fx = makeFixture();
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "nope.patch", sha256: "0".repeat(64) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("artifact_missing");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("an artifact outside its root: unsafe_artifact_path", async () => {
    const fx = makeFixture();
    writeFileSync(join(scratch, "outside.patch"), "x");
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "../outside.patch", sha256: "0".repeat(64) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("unsafe_artifact_path");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("a wrong digest: digest_mismatch, and nothing is applied", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: "0".repeat(64) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("digest_mismatch");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("apply mode with an unauthorized digest: digest_mismatch", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const before = snapshot(fx.repo);
    const w = wire(
      binding(fx, {
        mode: "apply",
        patch_sha256: "d".repeat(64),
        expected_tree_oid: "e".repeat(40),
      }),
    );
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(patch) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("digest_mismatch");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("apply mode with the authorized digest but a different result tree: tree_mismatch", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    // The tree another authorized edit to the same base produces.
    const wrongTree = patchFrom(fx, (r) =>
      writeFileSync(join(r, "b.txt"), "one\ntwo\nthree\nfour\n"),
    ).tree;
    writeArtifact(fx, "p.patch", patch);
    const before = snapshot(fx.repo);
    const w = wire(
      binding(fx, { mode: "apply", patch_sha256: sha256(patch), expected_tree_oid: wrongTree }),
    );
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(patch) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.refused).toBe(true);
    expect(out.details.reason).toBe("tree_mismatch");
    expect(snapshot(fx.repo)).toEqual(before);
    expect(existsSync(join(w.stateRoot, "candidates"))).toBe(false);
  });

  it("a malformed patch: malformed_patch", async () => {
    const fx = makeFixture();
    writeArtifact(fx, "p.patch", Buffer.from("this is not a patch\n"));
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(Buffer.from("this is not a patch\n")) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("malformed_patch");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("conflicting hunks are refused whole (no partial candidate)", async () => {
    const fx = makeFixture();
    const conflicting = Buffer.from(
      [
        "diff --git a/a.txt b/a.txt",
        "index 0000000..1111111 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-goodbye",
        "+goodbye world",
        "",
      ].join("\n"),
    );
    writeArtifact(fx, "p.patch", conflicting);
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(conflicting) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("patch_does_not_apply");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("an unsafe Git path: unsafe_git_path", async () => {
    const fx = makeFixture();
    const unsafe = Buffer.from(
      [
        "diff --git a/../evil b/../evil",
        "new file mode 100644",
        "index 0000000..e69de29",
        "--- /dev/null",
        "+++ b/../evil",
        "@@ -0,0 +1 @@",
        "+evil",
        "",
      ].join("\n"),
    );
    writeArtifact(fx, "p.patch", unsafe);
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(unsafe) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("unsafe_git_path");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("a symlink change: unsupported_entry_type", async () => {
    const fx = makeFixture();
    const symlink = Buffer.from(
      [
        "diff --git a/link b/link",
        "new file mode 120000",
        "index 0000000..0000000",
        "--- /dev/null",
        "+++ b/link",
        "@@ -0,0 +1 @@",
        "+target",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    writeArtifact(fx, "p.patch", symlink);
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(symlink) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("unsupported_entry_type");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("a submodule change: unsupported_entry_type", async () => {
    const fx = makeFixture();
    const submodule = Buffer.from(
      [
        "diff --git a/sub b/sub",
        "new file mode 160000",
        "index 0000000..1234567",
        "--- /dev/null",
        "+++ b/sub",
        "@@ -0,0 +1 @@",
        "+Subproject commit 1234567890123456789012345678901234567890",
        "",
      ].join("\n"),
    );
    writeArtifact(fx, "p.patch", submodule);
    const before = snapshot(fx.repo);
    const w = wire(binding(fx));
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(submodule) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();
    expect(out.details.reason).toBe("unsupported_entry_type");
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("a state root that cannot hold the index: storage_failed", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    // stateRoot is a regular FILE, so the index directory cannot be created.
    const fileState = join(scratch, "state-file");
    writeFileSync(fileState, "not a dir\n");
    const out = applyPatch({
      binding: binding(fx),
      params: {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: fx.base,
      },
      stateRoot: fileState,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("storage_failed");
  });

  it("a state root whose parent is a regular file: storage_failed, naming the directory failure", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const before = snapshot(fx.repo);
    const parent = join(scratch, "parent-file");
    writeFileSync(parent, "not a dir\n");
    const stateRoot = join(parent, "state");
    const out = applyPatch({
      binding: binding(fx),
      params: {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: fx.base,
      },
      stateRoot,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("storage_failed");
      expect(out.message).toContain("ENOTDIR");
      expect(out.message).toContain(stateRoot);
    }
    expect(snapshot(fx.repo)).toEqual(before);
    expect(readFileSync(parent, "utf8")).toBe("not a dir\n");
    expect(existsSync(stateRoot)).toBe(false);
  });

  it("a state root inside the repository: storage_failed, the checkout unchanged and no candidate stored", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const before = snapshot(fx.repo);
    // A temp directory under the caller's own tree: TMPDIR inside the workspace.
    const stateRoot = join(fx.repo, "state");
    const out = applyPatch({
      binding: binding(fx),
      params: {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: fx.base,
      },
      stateRoot,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("storage_failed");
    expect(snapshot(fx.repo)).toEqual(before);
    // Nothing was created there, so no candidate record can exist.
    expect(existsSync(stateRoot)).toBe(false);
    expect(existsSync(candidateRecordPath(stateRoot, "candidate"))).toBe(false);
  });

  it("a state root that is a symlink: storage_failed", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const target = join(scratch, "real-state");
    mkdirSync(target);
    const stateRoot = join(scratch, "state-link");
    symlinkSync(target, stateRoot);
    const out = applyPatch({
      binding: binding(fx),
      params: {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: fx.base,
      },
      stateRoot,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("storage_failed");
    // The link's target was not written through either.
    expect(readdirSync(target)).toEqual([]);
    expect(existsSync(candidateRecordPath(target, "candidate"))).toBe(false);
  });

  it("a state root with mode 0755: storage_failed", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const stateRoot = join(scratch, "state-0755");
    mkdirSync(stateRoot);
    chmodSync(stateRoot, 0o755);
    const out = applyPatch({
      binding: binding(fx),
      params: {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: fx.base,
      },
      stateRoot,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("storage_failed");
    expect(readdirSync(stateRoot)).toEqual([]);
    expect(existsSync(candidateRecordPath(stateRoot, "candidate"))).toBe(false);
  });

  it("a candidates directory that is a symlink into the checkout: storage_failed, the checkout unchanged and nothing written through the link", async () => {
    const fx = makeFixture();
    const { patch } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const stateRoot = join(scratch, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    // The candidate directory is a symlink into the caller's checkout: a
    // recursive mkdir accepts it and the record write follows it there.
    const planted = join(fx.repo, "planted");
    mkdirSync(planted);
    symlinkSync(planted, join(stateRoot, "candidates"));
    const before = snapshot(fx.repo);
    const out = applyPatch({
      binding: binding(fx),
      params: {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: fx.base,
      },
      stateRoot,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("storage_failed");
    // Nothing was written through the link, and the checkout is byte-identical.
    expect(readdirSync(planted)).toEqual([]);
    expect(snapshot(fx.repo)).toEqual(before);
  });

  it("a rename that fails: storage_failed, and no temporary record is left behind", async () => {
    const fx = makeFixture();
    const { patch, tree } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const stateRoot = join(scratch, "state");
    const dir = join(stateRoot, "candidates");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The record's final name is occupied by a directory, so the rename fails
    // after the temporary record was written.
    const id = candidateId(fx, tree, sha256(patch));
    mkdirSync(join(dir, `${id}.json`));
    const out = applyPatch({
      binding: binding(fx),
      params: {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: fx.base,
      },
      stateRoot,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("storage_failed");
      expect(out.message).toContain("could not be stored");
    }
    // The temporary record was removed: the occupied name is all that is left.
    expect(readdirSync(dir)).toEqual([`${id}.json`]);
  });
});

describe("apply_patch — the verified bytes are applied, not a reopened path", () => {
  it("swapping the artifact file after the digest check does not change the result", async () => {
    const fx = makeFixture();
    const real = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    const swap = patchFrom(fx, (r) => writeFileSync(join(r, "swapped.txt"), "different\n"));
    writeArtifact(fx, "p.patch", real.patch);
    const before = snapshot(fx.repo);

    const w = wire(binding(fx), {
      deps: {
        afterDigestVerified: (_bytes: Buffer, artifactPath: string) => {
          // Replace the artifact with a DIFFERENT patch after verification.
          writeFileSync(artifactPath, swap.patch);
        },
      },
    });
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(real.patch) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();

    // The verified bytes applied: the result is `real`, not `swap`.
    expect(out.details.tree_oid).toBe(real.tree);
    expect(out.details.changed_paths).toEqual(["a.txt"]);
    expect(snapshot(fx.repo)).toEqual(before);
  });
});

describe("apply_patch — a fake git runner proves the caller's index is never used", () => {
  it("the index-touching git calls name a tool-owned GIT_INDEX_FILE, and the caller's index is untouched", async () => {
    const fx = makeFixture();
    const { patch, tree } = patchFrom(fx, (r) => writeFileSync(join(r, "a.txt"), "hello world\n"));
    writeArtifact(fx, "p.patch", patch);
    const before = snapshot(fx.repo);

    const calls: GitInvocation[] = [];
    const w = wire(binding(fx), {
      deps: {
        git: (args: string[], inv: GitInvocation): GitResult => {
          calls.push(inv);
          const env: NodeJS.ProcessEnv = { ...gitEnv() };
          if (inv.indexFile !== undefined) env.GIT_INDEX_FILE = inv.indexFile;
          const r = spawnSync("git", args, {
            cwd: inv.cwd,
            env,
            input: inv.input,
            encoding: "buffer",
            maxBuffer: 64 * 1024 * 1024,
          });
          return {
            status: r.status ?? -1,
            stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
            stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
          };
        },
      },
    });
    const out = await w.apply({
      patch_artifact: { path: "p.patch", sha256: sha256(patch) },
      expected_base: fx.base,
    });
    w.manager.endRunSync();

    expect(out.details.tree_oid).toBe(tree);
    // Every call that touches the index named a fresh index file under the state
    // root, never the repo's .git/index.
    for (const inv of calls) {
      if (inv.indexFile !== undefined) expect(inv.indexFile).toContain(join(scratch, "state"));
    }
    expect(calls.some((c) => c.indexFile !== undefined)).toBe(true);
    expect(snapshot(fx.repo)).toEqual(before);
  });
});
