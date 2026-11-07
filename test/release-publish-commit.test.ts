// The release guard script picks the one commit a release run stages and refuses
// it unless it is on main. A manual dispatch must use the v<version> tag's
// commit, not the dispatched ref's commit; the workflow test below pins that
// every job after the guard checks out the guard's output sha.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO = join(import.meta.dir, "..");
const WORKFLOW = join(REPO, ".github", "workflows", "release-publish.yml");
const SCRIPT = join(REPO, "scripts", "resolve-release-commit.mjs");
const GUARD_JOB = "verify-ancestry";
const GUARD_SHA = "$" + "{{ needs.verify-ancestry.outputs.sha }}";

// GITHUB_* variables are dropped so the test never writes into a real step's
// output file when the suite runs inside Actions.
const BASE_ENV: Record<string, string | undefined> = { ...process.env };
for (const key of [
  "GITHUB_OUTPUT",
  "GITHUB_EVENT_NAME",
  "GITHUB_SHA",
  "GITHUB_REF_NAME",
  "VERSION",
]) {
  delete BASE_ENV[key];
}
Object.assign(BASE_ENV, {
  GIT_AUTHOR_NAME: "Release guard test",
  GIT_AUTHOR_EMAIL: "guard@example.invalid",
  GIT_COMMITTER_NAME: "Release guard test",
  GIT_COMMITTER_EMAIL: "guard@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: BASE_ENV, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

type Repo = { root: string; work: string };

// A real repository with a real origin: one base commit pushed to main.
function makeRepo(): Repo {
  const root = mkdtempSync(join(tmpdir(), "bob-release-commit-"));
  const remote = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", work);
  git(work, "remote", "add", "origin", remote);
  git(work, "commit", "--allow-empty", "-m", "base");
  git(work, "push", "origin", "main");
  return { root, work };
}

function guard(
  repo: Repo,
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ["--no-install", SCRIPT], {
    cwd: repo.work,
    env: { ...BASE_ENV, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

const dispatch = (version: string) => ({
  GITHUB_EVENT_NAME: "workflow_dispatch",
  VERSION: version,
});

test("a tag present on main is accepted and prints its commit", () => {
  const repo = makeRepo();
  try {
    const head = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "v1.2.3");
    const output = join(repo.root, "output");
    writeFileSync(output, "");
    const result = guard(repo, { ...dispatch("1.2.3"), GITHUB_OUTPUT: output });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`sha=${head}`);
    expect(readFileSync(output, "utf8")).toBe(`sha=${head}\n`);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("a missing tag is refused by name", () => {
  const repo = makeRepo();
  try {
    const result = guard(repo, dispatch("9.9.9"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v9.9.9");
    expect(result.stderr).toContain("does not exist");
    expect(result.stdout).not.toContain("sha=");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("a tag on an unmerged commit is refused", () => {
  const repo = makeRepo();
  try {
    git(repo.work, "checkout", "-b", "unmerged");
    git(repo.work, "commit", "--allow-empty", "-m", "unmerged change");
    const unmerged = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "v2.0.0");
    git(repo.work, "checkout", "main");
    const result = guard(repo, dispatch("2.0.0"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v2.0.0");
    expect(result.stderr).toContain(unmerged);
    expect(result.stderr).toContain("not an ancestor of origin/main");
    expect(result.stdout).not.toContain("sha=");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("an annotated tag is peeled to its commit", () => {
  const repo = makeRepo();
  try {
    const commit = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "-a", "v3.0.0", "-m", "release");
    const tagObject = git(repo.work, "rev-parse", "refs/tags/v3.0.0");
    expect(tagObject).not.toBe(commit);
    const result = guard(repo, dispatch("3.0.0"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`sha=${commit}`);
    expect(result.stdout).not.toContain(tagObject);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test.each(["1.2.3;id", "../x", ""])(
  "invalid version %j is refused before any git call",
  (version) => {
    const repo = makeRepo();
    try {
      const bin = join(repo.root, "fake-bin");
      mkdirSync(bin);
      const marker = join(repo.root, "git-called");
      writeFileSync(join(bin, "git"), `#!/bin/sh\ntouch "$MARKER"\nexit 1\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, ["--no-install", SCRIPT], {
        cwd: repo.work,
        env: {
          ...BASE_ENV,
          PATH: `${bin}:${BASE_ENV.PATH ?? ""}`,
          MARKER: marker,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          VERSION: version,
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(existsSync(marker)).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is not a version");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("the tag-push path accepts the run's commit only when it is on main", () => {
  const repo = makeRepo();
  try {
    const head = git(repo.work, "rev-parse", "HEAD");
    const accepted = guard(repo, { GITHUB_EVENT_NAME: "push", GITHUB_SHA: head });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(`sha=${head}`);

    git(repo.work, "checkout", "-b", "unmerged");
    git(repo.work, "commit", "--allow-empty", "-m", "unmerged change");
    const unmerged = git(repo.work, "rev-parse", "HEAD");
    const refused = guard(repo, { GITHUB_EVENT_NAME: "push", GITHUB_SHA: unmerged });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not an ancestor of origin/main");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

type Step = {
  uses?: string;
  run?: string;
  id?: string;
  name?: string;
  with?: Record<string, unknown>;
};
type Job = { needs?: string | string[]; steps?: Step[]; outputs?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, Job> };

function needsOf(job: Job | undefined): string[] {
  if (job?.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function afterGuard(jobs: Record<string, Job>, name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  for (const need of needsOf(jobs[name])) {
    if (need === GUARD_JOB || afterGuard(jobs, need, seen)) return true;
  }
  return false;
}

test("every job after the guard checks out the guard's output sha", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const jobs = workflow.jobs ?? {};
  const guard = jobs[GUARD_JOB];
  expect(guard).toBeDefined();
  const guardStep = guard?.steps?.find(
    (step) => step.run === "bun --no-install scripts/resolve-release-commit.mjs",
  );
  expect(guardStep?.id).toBeDefined();
  expect(guard?.outputs?.sha).toBe(`\${{ steps.${guardStep?.id}.outputs.sha }}`);

  const dependents = Object.keys(jobs).filter(
    (name) => name !== GUARD_JOB && afterGuard(jobs, name),
  );
  expect(dependents.sort()).toEqual(["github-release", "stage-publish"]);
  for (const name of dependents) {
    const checkouts = (jobs[name].steps ?? []).filter(
      (step) => step.uses?.startsWith("actions/checkout@") === true,
    );
    expect(checkouts.length, `${name} has no checkout`).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step.with?.ref, `${name} must check out the guard's sha`).toBe(GUARD_SHA);
      const ref = String(step.with?.ref ?? "");
      expect(ref).not.toContain("github.sha");
      expect(ref).not.toContain("github.ref_name");
    }
  }
});
