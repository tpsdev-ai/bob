import { afterEach, beforeEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CandidateRecord,
  candidateIdentity,
  candidateRecordPath,
} from "../../../src/capabilities/work/apply-patch.js";
import { publish } from "../../../src/capabilities/work/publish.js";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-publish-boundaries-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function commitObject(repo: string, tree: string): string {
  return git(
    repo,
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    `tree ${tree}\nauthor Fixture <fixture@bob.invalid> 1 +0000\ncommitter Fixture <fixture@bob.invalid> 1 +0000\n\nbase\n`,
  );
}

function fixture(path: string, declared: string[]) {
  const repo = join(scratch, "repo");
  const remote = join(scratch, "remote.git");
  const stateRoot = join(scratch, "state");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  const base = commitObject(repo, git(repo, ["mktree"], ""));
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), "candidate\n");
  git(repo, ["add", "--", path]);
  const tree = git(repo, ["write-tree"]);
  const binding: TaskBinding = {
    task_id: "task",
    publication_id: "publication",
    repository: repo,
    workspace: repo,
    artifact_root: join(scratch, "artifacts"),
    base_oid: base,
    mode: "build",
    declared_paths: declared,
    check_commands: ["check"],
    destination: { remote, ref: "refs/heads/main" },
  };
  const record: CandidateRecord = {
    ...binding,
    candidate_id: "",
    tree_oid: tree,
    patch_sha256: "c".repeat(64),
    artifact_path: "patch",
    changed_paths: [path],
    created_at: new Date().toISOString(),
  };
  record.candidate_id = candidateIdentity(record);
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(join(stateRoot, "candidates"), { mode: 0o700 });
  writeFileSync(candidateRecordPath(stateRoot, record.candidate_id), JSON.stringify(record));
  return {
    binding,
    stateRoot,
    params: { candidate_id: record.candidate_id, commit_message: "candidate" },
  };
}

for (const path of ["src/tab\tfile", "src/line\nfile", "src/return\rfile", 'src/quote"file']) {
  for (const prefix of ['"src', "src"]) {
    it(`compares ${JSON.stringify(path)} against literal prefix ${JSON.stringify(prefix)}`, async () => {
      const input = fixture(path, [prefix]);
      let checks = 0;
      const out = await publish({
        ...input,
        deps: {
          runCheck: async () => {
            checks++;
            return {
              outcome: "exited",
              exit_code: 1,
              cleanup_state: "group_empty",
              output_complete: true,
            };
          },
        },
      });
      expect(out.status).toBe("refused");
      expect(out.reason).toBe(prefix === "src" ? "check_failed" : "scope_violation");
      expect(checks).toBe(prefix === "src" ? 1 : 0);
      if (prefix !== "src") expect(out.detail?.offenders).toEqual([path]);
    });
  }
}

it("a remote head absent from the local object store is indeterminate", async () => {
  const input = fixture("source.txt", ["source.txt"]);
  input.binding.check_commands = [];
  const remote = input.binding.destination.remote;
  git(scratch, ["init", "-q", "--bare", remote]);
  const blob = git(remote, ["hash-object", "-w", "--stdin"], "remote-only\n");
  const tree = git(remote, ["mktree"], `100644 blob ${blob}\tremote.txt\n`);
  const remoteOid = commitObject(remote, tree);
  git(remote, ["update-ref", input.binding.destination.ref, remoteOid]);
  const missing = spawnSync("git", ["cat-file", "-e", remoteOid], {
    cwd: input.binding.repository,
    encoding: "utf8",
  });
  expect(missing.status).not.toBe(0);
  const out = await publish({
    ...input,
    deps: {
      runCheck: async () => {
        throw new Error("no checks requested");
      },
    },
  });
  expect(out.status, JSON.stringify(out)).toBe("indeterminate");
  expect(out.reason).toBe("ancestry_unknown");
  expect(out.push_state).toBe("unknown");
  expect(git(remote, ["rev-parse", input.binding.destination.ref])).toBe(remoteOid);
});
