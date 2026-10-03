// publish (bob#275, S2b): candidate checks and recoverable publication.
//
// Local git fixtures, no network: a real builder repository, a real bare remote
// in the test's temp dir. Cases drive `publish` directly
// or through the tool the capability registers.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPatch,
  type GitInvocation,
  type GitResult,
} from "../../../src/capabilities/work/apply-patch.js";
import {
  type CheckReport,
  type CheckRunner,
  type PublishParams,
  publish,
  publishJournalPath,
} from "../../../src/capabilities/work/index.js";
import { writeJournalAtomic } from "../../../src/capabilities/work/publish.js";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-publish-"));
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

function realGit(args: string[], inv: GitInvocation): GitResult {
  const env: NodeJS.ProcessEnv = { ...gitEnv() };
  if (inv.indexFile !== undefined) env.GIT_INDEX_FILE = inv.indexFile;
  const r = spawnSync("git", args, {
    cwd: inv.cwd,
    env,
    input: inv.input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { status: -1, stdout: "", stderr: r.error.message };
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

function git(args: string[], cwd: string): string {
  const r = realGit(args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Fixture {
  repo: string;
  bare: string;
  artifactRoot: string;
  base: string;
  stateRoot: string;
}

// A builder repository at `base`, a bare remote, an artifact root and a state
// root, each outside the others.
function makeFixture(): Fixture {
  const repo = join(scratch, "repo");
  const bare = join(scratch, "remote.git");
  const artifactRoot = join(scratch, "artifacts");
  const stateRoot = join(scratch, "state");
  mkdirSync(repo, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  git(["init", "-q"], repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 1;\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "base"], repo);
  git(["init", "-q", "--bare", bare], scratch);
  const base = git(["rev-parse", "HEAD"], repo);
  return { repo, bare, artifactRoot, base, stateRoot };
}

// Push the base commit so the remote ref exists at the authorized prior state.
function seedRemote(fx: Fixture): void {
  git(["push", fx.bare, `HEAD:refs/heads/main`], fx.repo);
}

function patchFrom(fx: Fixture, mutate: (repo: string) => void): { patch: Buffer; tree: string } {
  mutate(fx.repo);
  git(["add", "-A"], fx.repo);
  git(["commit", "-qm", "change"], fx.repo);
  const tree = git(["rev-parse", "HEAD^{tree}"], fx.repo);
  const diff = realGit(["diff", "--binary", "-M", "-C", fx.base, "HEAD"], { cwd: fx.repo });
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  const patch = Buffer.from(diff.stdout, "utf8");
  git(["reset", "--hard", "-q", fx.base], fx.repo);
  return { patch, tree };
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
    declared_paths: ["src/widget.ts"],
    check_commands: [],
    destination: { remote: fx.bare, ref: "refs/heads/main", create: true },
    ...over,
  };
}

interface Built {
  candidate_id: string;
  tree_oid: string;
  patch_sha256: string;
}

// Build a stored candidate from a patch. Returns the candidate's ids.
function buildCandidate(fx: Fixture, b: TaskBinding, mutate: (repo: string) => void): Built {
  const { patch, tree } = patchFrom(fx, mutate);
  writeFileSync(join(fx.artifactRoot, "p.patch"), patch);
  const out = applyPatch({
    binding: b,
    params: {
      patch_artifact: { path: "p.patch", sha256: sha256(patch) },
      expected_base: b.base_oid,
    },
    stateRoot: fx.stateRoot,
    deps: { git: realGit },
  });
  if (!out.ok) throw new Error(`applyPatch refused: ${out.reason} ${out.message}`);
  expect(out.tree_oid).toBe(tree);
  return { candidate_id: out.candidate_id, tree_oid: out.tree_oid, patch_sha256: out.patch_sha256 };
}

const okCheck: CheckRunner = async (): Promise<CheckReport> => ({
  outcome: "exited",
  exit_code: 0,
  cleanup_state: "group_empty",
  output_complete: true,
});

function params(_fx: Fixture, built: Built, over: Partial<PublishParams> = {}): PublishParams {
  return { candidate_id: built.candidate_id, commit_message: "feat: a change", ...over };
}

function remoteOid(fx: Fixture): string | null {
  const r = realGit(["ls-remote", fx.bare, "refs/heads/main"], { cwd: fx.repo });
  if (r.status !== 0) throw new Error(`ls-remote failed: ${r.stderr}`);
  const line = r.stdout.trim();
  return line === "" ? null : line.split(/\s+/)[0];
}

function remoteTree(fx: Fixture, oid: string): string {
  return git(["rev-parse", `${oid}^{tree}`], fx.bare);
}

function remoteParent(fx: Fixture, oid: string): string {
  return git(["rev-parse", `${oid}^`], fx.bare);
}

function remoteCommitCount(fx: Fixture): number {
  return Number(git(["rev-list", "--count", "refs/heads/main"], fx.bare));
}

function snapshot(fx: Fixture): Record<string, string> {
  return {
    head: git(["rev-parse", "HEAD"], fx.repo),
    refs: git(["show-ref"], fx.repo),
    status: realGit(["status", "--porcelain"], { cwd: fx.repo }).stdout,
    index: sha256(readFileSync(join(fx.repo, ".git", "index"))),
  };
}

describe("publish — a stored candidate becomes a remote commit", () => {
  it("publishes the candidate: remote tree == candidate tree, parent == pinned base; the builder checkout is untouched", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const before = snapshot(fx);
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.status).toBe("published");
    expect(out.push_state).toBe("confirmed_present");
    expect(out.commit_oid).not.toBeNull();
    const oid = out.commit_oid as string;
    expect(remoteOid(fx)).toBe(oid);
    expect(remoteTree(fx, oid)).toBe(built.tree_oid);
    expect(remoteParent(fx, oid)).toBe(fx.base);
    expect(remoteCommitCount(fx)).toBe(2);
    expect(snapshot(fx)).toEqual(before);
    expect(existsSync(publishJournalPath(fx.stateRoot, b.publication_id))).toBe(true);
  });

  it("reports already-published idempotently when the remote already contains the commit", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const first = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(first.status).toBe("published");
    const second = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(second.status).toBe("published");
    expect(second.commit_oid).toBe(first.commit_oid);
    expect(remoteCommitCount(fx)).toBe(2);
  });

  it("apply mode publishes only the task's expected tree", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const { patch, tree } = patchFrom(fx, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 3;\n"),
    );
    writeFileSync(join(fx.artifactRoot, "p.patch"), patch);
    const b = binding(fx, {
      mode: "apply",
      patch_sha256: sha256(patch),
      expected_tree_oid: tree,
    });
    const applied = applyPatch({
      binding: b,
      params: {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: b.base_oid,
      },
      stateRoot: fx.stateRoot,
      deps: { git: realGit },
    });
    if (!applied.ok) throw new Error(applied.reason);
    const out = await publish({
      binding: b,
      params: { candidate_id: applied.candidate_id, commit_message: "chore: apply" },
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.status).toBe("published");
    expect(remoteTree(fx, out.commit_oid as string)).toBe(tree);
    expect(remoteParent(fx, out.commit_oid as string)).toBe(fx.base);
  });
});

describe("publish — candidate association and scope", () => {
  it("no task binding: unknown_task, nothing pushed", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const before = remoteOid(fx);
    const out = await publish({
      binding: undefined,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("unknown_task");
    expect(remoteOid(fx)).toBe(before);
  });

  it("an unknown candidate: candidate_unknown, nothing pushed", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const before = remoteOid(fx);
    const out = await publish({
      binding: b,
      params: { candidate_id: "0".repeat(40), commit_message: "x" },
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.reason).toBe("candidate_unknown");
    expect(remoteOid(fx)).toBe(before);
  });

  it("a candidate from another publication: candidate_mismatch, nothing pushed", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const before = remoteOid(fx);
    const other = binding(fx, { publication_id: "pub-2" });
    const out = await publish({
      binding: other,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.reason).toBe("candidate_mismatch");
    expect(remoteOid(fx)).toBe(before);
  });

  it("an out-of-scope path refuses by name even when checks would pass", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    // Declares only src/widget.ts, but the candidate also changes README.md.
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) => {
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n");
      writeFileSync(join(r, "README.md"), "changed\n");
    });
    const before = remoteOid(fx);
    let checks = 0;
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: {
        git: realGit,
        runCheck: async () => {
          checks += 1;
          return {
            outcome: "exited",
            exit_code: 0,
            cleanup_state: "group_empty",
            output_complete: true,
          };
        },
      },
    });
    expect(out.reason).toBe("scope_violation");
    expect(out.detail?.offenders).toContain("README.md");
    expect(checks).toBe(0);
    expect(remoteOid(fx)).toBe(before);
  });

  it("a declared directory prefix admits files under it", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { declared_paths: ["src"] });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.status).toBe("published");
  });

  it("an out-of-scope add, delete and rename all refuse and name the offending paths", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { declared_paths: ["src/widget.ts"] });
    const built = buildCandidate(fx, b, (r) => {
      // Add an undeclared generated file, delete an undeclared file, and rename
      // the declared file out of scope.
      mkdirSync(join(r, "dist"), { recursive: true });
      writeFileSync(join(r, "dist", "widget.js"), "generated\n");
      rmSync(join(r, "README.md"));
      git(["mv", "src/widget.ts", "widget.ts"], r);
    });
    const before = remoteOid(fx);
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.reason).toBe("scope_violation");
    const offenders = out.detail?.offenders as string[];
    expect(offenders).toContain("dist/widget.js");
    expect(offenders).toContain("README.md");
    expect(offenders).toContain("widget.ts");
    expect(remoteOid(fx)).toBe(before);
  });

  it("in apply mode a candidate tree that is not the task's expected tree refuses before push", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const { patch, tree } = patchFrom(fx, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 3;\n"),
    );
    writeFileSync(join(fx.artifactRoot, "p.patch"), patch);
    // The authorized binding the candidate was built under.
    const authorized = binding(fx, {
      mode: "apply",
      patch_sha256: sha256(patch),
      expected_tree_oid: tree,
    });
    const applied = applyPatch({
      binding: authorized,
      params: {
        patch_artifact: { path: "p.patch", sha256: sha256(patch) },
        expected_base: authorized.base_oid,
      },
      stateRoot: fx.stateRoot,
      deps: { git: realGit },
    });
    if (!applied.ok) throw new Error(applied.reason);
    // A different authorized expected tree for the same publication.
    const wrongTree = patchFrom(fx, (r) => writeFileSync(join(r, "README.md"), "other\n")).tree;
    const mismatched = binding(fx, {
      mode: "apply",
      patch_sha256: sha256(patch),
      expected_tree_oid: wrongTree,
    });
    const before = remoteOid(fx);
    let checks = 0;
    const out = await publish({
      binding: mismatched,
      params: { candidate_id: applied.candidate_id, commit_message: "chore: apply" },
      stateRoot: fx.stateRoot,
      deps: {
        git: realGit,
        runCheck: async () => {
          checks += 1;
          return {
            outcome: "exited",
            exit_code: 0,
            cleanup_state: "group_empty",
            output_complete: true,
          };
        },
      },
    });
    expect(out.reason).toBe("expected_tree_mismatch");
    expect(checks).toBe(0);
    expect(remoteOid(fx)).toBe(before);
  });
});

describe("publish — checks gate the push", () => {
  it("a failing check refuses and never pushes", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { check_commands: ["false"] });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const before = remoteOid(fx);
    let seenCwd = "";
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: {
        git: realGit,
        runCheck: async (_command, cwd) => {
          seenCwd = cwd;
          const r = realGit(["status"], { cwd });
          return {
            outcome: r.status === 0 ? "exited" : "no_exit_status",
            exit_code: 1,
            cleanup_state: "group_empty",
            output_complete: true,
          };
        },
      },
    });
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("check_failed");
    expect(seenCwd).not.toBe("");
    expect(remoteOid(fx)).toBe(before);
  });

  it("maps every non-success check outcome to its reason and never pushes", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const cases: Array<{ report: CheckReport; reason: string }> = [
      {
        report: {
          outcome: "timed_out",
          exit_code: null,
          cleanup_state: "group_killed",
          output_complete: true,
        },
        reason: "check_timeout",
      },
      {
        report: {
          outcome: "cancelled",
          exit_code: null,
          cleanup_state: "group_empty",
          output_complete: true,
        },
        reason: "check_cancelled",
      },
      {
        report: {
          outcome: "no_exit_status",
          exit_code: null,
          cleanup_state: "group_empty",
          output_complete: true,
        },
        reason: "check_missing_status",
      },
      {
        report: {
          outcome: "exited",
          exit_code: 0,
          cleanup_state: "escaped_or_unverified",
          output_complete: true,
        },
        reason: "check_cleanup_unverified",
      },
      {
        report: {
          outcome: "exited",
          exit_code: 0,
          cleanup_state: "group_empty",
          output_complete: false,
        },
        reason: "check_incomplete",
      },
      {
        report: {
          outcome: "exited",
          exit_code: 3,
          cleanup_state: "group_empty",
          output_complete: true,
        },
        reason: "check_failed",
      },
    ];
    for (const c of cases) {
      const b = binding(fx, { publication_id: `pub-${c.reason}`, check_commands: ["x"] });
      const built = buildCandidate(fx, b, (r) =>
        writeFileSync(join(r, "src", "widget.ts"), `export const widget = "${c.reason}";\n`),
      );
      const before = remoteOid(fx);
      const out = await publish({
        binding: b,
        params: params(fx, built),
        stateRoot: fx.stateRoot,
        deps: { git: realGit, runCheck: async () => c.report },
      });
      expect(out.reason, c.reason).toBe(c.reason);
      expect(remoteOid(fx), c.reason).toBe(before);
    }
  });

  it("a check that mutates a tracked file refuses: publication tests only the stored candidate", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { check_commands: ["mutate"] });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const before = remoteOid(fx);
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: {
        git: realGit,
        runCheck: async (_command, cwd) => {
          writeFileSync(join(cwd, "src", "widget.ts"), "export const widget = 99;\n");
          return {
            outcome: "exited",
            exit_code: 0,
            cleanup_state: "group_empty",
            output_complete: true,
          };
        },
      },
    });
    expect(out.reason).toBe("materialized_tree_changed");
    expect(remoteOid(fx)).toBe(before);
  });

  it("materializes the stored candidate, not the builder's mutated checkout, and ignores generated files", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { check_commands: ["inspect"] });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    // Mutate the builder's checkout and stage a generated file AFTER the
    // candidate exists; publication must still test and push only the candidate.
    writeFileSync(join(fx.repo, "src", "widget.ts"), "export const widget = 999;\n");
    writeFileSync(join(fx.repo, "dist.js"), "generated\n");
    git(["add", "dist.js"], fx.repo);
    let sawContent = "";
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: {
        git: realGit,
        runCheck: async (_command, cwd) => {
          sawContent = readFileSync(join(cwd, "src", "widget.ts"), "utf8");
          // The generated file from the builder's checkout is not present.
          const generated = existsSync(join(cwd, "dist.js"));
          return {
            outcome: generated ? "exited" : "exited",
            exit_code: generated ? 1 : 0,
            cleanup_state: "group_empty",
            output_complete: true,
          };
        },
      },
    });
    expect(sawContent).toBe("export const widget = 2;\n");
    expect(out.status).toBe("published");
    expect(remoteTree(fx, out.commit_oid as string)).toBe(built.tree_oid);
  });
});

describe("publish — the remote decides", () => {
  it("an absent remote ref without authorization refuses", async () => {
    const fx = makeFixture();
    // No seedRemote: refs/heads/main does not exist, and create is not set.
    const b = binding(fx, { destination: { remote: fx.bare, ref: "refs/heads/main" } });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.reason).toBe("remote_absent_unauthorized");
    expect(out.push_state).toBe("confirmed_absent");
    expect(remoteOid(fx)).toBeNull();
  });

  it("an incompatible remote ref refuses and preserves remote history", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    // Advance the remote to an unrelated commit on top of base.
    writeFileSync(join(fx.repo, "README.md"), "intervening\n");
    git(["add", "-A"], fx.repo);
    git(["commit", "-qm", "intervening"], fx.repo);
    const intervening = git(["rev-parse", "HEAD"], fx.repo);
    git(["push", fx.bare, "HEAD:refs/heads/main"], fx.repo);
    git(["reset", "--hard", "-q", fx.base], fx.repo);
    const beforeCount = remoteCommitCount(fx);
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.reason).toBe("remote_diverged");
    expect(remoteOid(fx)).toBe(intervening);
    expect(remoteCommitCount(fx)).toBe(beforeCount);
  });

  it("a push race that moves the ref between inspection and push is rejected, not forced", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    // The intervening commit.
    writeFileSync(join(fx.repo, "README.md"), "intervening\n");
    git(["add", "-A"], fx.repo);
    git(["commit", "-qm", "intervening"], fx.repo);
    const intervening = git(["rev-parse", "HEAD"], fx.repo);
    git(["reset", "--hard", "-q", fx.base], fx.repo);
    let raced = false;
    const racingGit = (args: string[], inv: GitInvocation): GitResult => {
      if (args[0] === "push" && !raced) {
        raced = true;
        // Move the remote after publish read the old ref but before its push.
        realGit(["push", fx.bare, `${intervening}:refs/heads/main`], { cwd: fx.repo });
      }
      return realGit(args, inv);
    };
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: racingGit, runCheck: okCheck },
    });
    expect(raced).toBe(true);
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("push_rejected");
    expect(remoteOid(fx)).toBe(intervening);
  });
});

describe("publish — recovery and identity", () => {
  it("recovers the exact persisted commit after an interrupted push with a lost acknowledgement", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    let interrupted = true;
    const deps = {
      git: realGit,
      runCheck: okCheck,
      afterPushAccepted: () => {
        if (interrupted) throw new Error("publisher terminated");
      },
    };
    await expect(
      publish({ binding: b, params: params(fx, built), stateRoot: fx.stateRoot, deps }),
    ).rejects.toThrow("publisher terminated");
    // The remote accepted the push; the publisher never recorded it.
    const pushed = remoteOid(fx);
    expect(pushed).not.toBeNull();
    expect(remoteCommitCount(fx)).toBe(2);
    // The intent pins the commit before the push.
    const journal = JSON.parse(
      readFileSync(publishJournalPath(fx.stateRoot, b.publication_id), "utf8"),
    ) as { commit_oid?: string; phase?: string };
    expect(journal.commit_oid).toBe(pushed);
    expect(journal.phase).toBe("pushing");
    interrupted = false;
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps,
    });
    expect(out.status).toBe("published");
    expect(out.commit_oid).toBe(pushed);
    expect(remoteCommitCount(fx)).toBe(2);
  });

  it("reusing a publication identity with different candidate content refuses", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const first = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(first.status).toBe("published");
    const other = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 5;\n"),
    );
    const out = await publish({
      binding: b,
      params: params(fx, other),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck },
    });
    expect(out.reason).toBe("publication_conflict");
    expect(remoteCommitCount(fx)).toBe(2);
  });

  it("in-process retries for one publication identity serialize; one commit lands", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const [a, c] = await Promise.all([
      publish({
        binding: b,
        params: params(fx, built),
        stateRoot: fx.stateRoot,
        deps: { git: realGit, runCheck: okCheck },
      }),
      publish({
        binding: b,
        params: params(fx, built),
        stateRoot: fx.stateRoot,
        deps: { git: realGit, runCheck: okCheck },
      }),
    ]);
    expect(a.status).toBe("published");
    expect(c.status).toBe("published");
    expect(a.commit_oid).toBe(c.commit_oid);
    expect(remoteCommitCount(fx)).toBe(2);
  });

  it("an intent-write failure refuses before any external effect", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const before = remoteOid(fx);
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: {
        git: realGit,
        runCheck: okCheck,
        writeJournal: () => {
          throw new Error("disk full");
        },
      },
    });
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("storage_failed");
    expect(remoteOid(fx)).toBe(before);
  });

  it("a failed journal read is never treated as absence", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx);
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const before = remoteOid(fx);
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: {
        git: realGit,
        runCheck: okCheck,
        readJournal: () => {
          throw new Error("EIO");
        },
      },
    });
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("storage_failed");
    expect(out.detail?.reason).toBe("journal_read_failed");
    expect(remoteOid(fx)).toBe(before);
  });
});

describe("publish — storage and authority", () => {
  function candidate() {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { check_commands: ["check"] });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    return { fx, b, built };
  }

  it("rejects traversal IDs before Git or storage access", async () => {
    const fx = {
      repo: "repo",
      bare: "bare",
      artifactRoot: "artifacts",
      base: "a".repeat(40),
      stateRoot: join(scratch, "absent"),
    };
    const b = binding(fx);
    let calls = 0;
    const deps = {
      git: () => {
        calls++;
        throw new Error("unexpected git");
      },
    };
    for (const id of ["../escape", "/absolute", "a/b", "a\\b", ".", "a\0b"]) {
      const badCandidate = await publish({
        binding: b,
        params: { candidate_id: id, commit_message: "x" },
        stateRoot: fx.stateRoot,
        deps,
      });
      expect(badCandidate.reason).toBe("invalid_request");
      const badPublication = await publish({
        binding: { ...b, publication_id: id },
        params: { candidate_id: "a".repeat(40), commit_message: "x" },
        stateRoot: fx.stateRoot,
        deps,
      });
      expect(badPublication.reason).toBe("invalid_binding");
    }
    expect(calls).toBe(0);
    expect(existsSync(fx.stateRoot)).toBe(false);
  });

  it("pins the fetch endpoint even when the named remote has a different pushurl", async () => {
    const { fx, b, built } = candidate();
    const other = join(scratch, "other.git");
    git(["init", "-q", "--bare", other], scratch);
    git(["remote", "add", "origin", fx.bare], fx.repo);
    git(["remote", "set-url", "--push", "origin", other], fx.repo);
    b.destination.remote = "origin";
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: {
        runCheck: async () => {
          git(["config", `url.${other}.pushInsteadOf`, fx.bare], fx.repo);
          return okCheck("", "");
        },
      },
    });
    expect(out.status).toBe("published");
    expect(remoteOid(fx)).toBe(out.commit_oid);
    expect(git(["ls-remote", other], fx.repo)).toBe("");
  });

  it("refuses URL rewrite configuration", async () => {
    const { fx, b, built } = candidate();
    git(["config", "url./redirect.pushInsteadOf", fx.bare], fx.repo);
    const out = await publish({
      binding: b,
      params: params(fx, built),
      stateRoot: fx.stateRoot,
      deps: { runCheck: okCheck },
    });
    expect(out.reason).toBe("invalid_binding");
    expect(remoteOid(fx)).toBe(fx.base);
  });

  it("refuses pr by name before storage or push even with a PR binding", async () => {
    const fx = {
      repo: "repo",
      bare: "bare",
      artifactRoot: "artifacts",
      base: "a".repeat(40),
      stateRoot: join(scratch, "absent"),
    };
    const out = await publish({
      binding: binding(fx, { pr: { base: "main" } }),
      params: {
        candidate_id: "a".repeat(40),
        commit_message: "x",
        pr: { title: "T", body: "B" },
      } as PublishParams,
      stateRoot: fx.stateRoot,
    });
    expect(out.reason).toBe("pr_unsupported");
    expect(out.message).toContain("PR creation is a later slice");
    expect(existsSync(fx.stateRoot)).toBe(false);
  });

  it("syncs journal bytes before rename and the directory after rename", () => {
    const root = join(scratch, "state");
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(join(root, "publications"), { mode: 0o700 });
    const path = publishJournalPath(root, "pub");
    const synced: string[] = [];
    writeJournalAtomic(path, "intent", (fd) => {
      const isFile = fstatSync(fd).isFile();
      synced.push(isFile ? "file" : "directory");
      if (isFile) expect(existsSync(path)).toBe(false);
      else expect(readFileSync(path, "utf8")).toBe("intent");
      fsyncSync(fd);
    });
    expect(synced).toEqual(["file", "directory", "directory"]);
  });

  it("a failed file sync leaves the old journal intact", () => {
    const root = join(scratch, "state");
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(join(root, "publications"), { mode: 0o700 });
    const path = publishJournalPath(root, "pub");
    writeFileSync(path, "old");
    expect(() =>
      writeJournalAtomic(path, "new", () => {
        throw new Error("sync failed");
      }),
    ).toThrow("sync failed");
    expect(readFileSync(path, "utf8")).toBe("old");
  });
});
