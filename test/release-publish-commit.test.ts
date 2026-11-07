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
const VERIFY_TAG = join(REPO, "scripts", "verify-release-tag.mjs");
const GUARD_JOB = "verify-ancestry";
const GUARD_SHA = "$" + "{{ needs.verify-ancestry.outputs.sha }}";
const GUARD_VERSION = "$" + "{{ needs.verify-ancestry.outputs.version }}";
const GUARD_TAG = "$" + "{{ needs.verify-ancestry.outputs.tag }}";
const INPUT_VERSION = "$" + "{{ inputs.version }}";

// GITHUB_* variables are dropped so the test never writes into a real step's
// output file when the suite runs inside Actions.
const BASE_ENV: Record<string, string | undefined> = { ...process.env };
for (const key of [
  "GITHUB_OUTPUT",
  "GITHUB_EVENT_NAME",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_ACTIONS",
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

function verifyTag(
  repo: Repo,
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ["--no-install", VERIFY_TAG], {
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
    expect(readFileSync(output, "utf8")).toBe(`sha=${head}\nversion=1.2.3\ntag=v1.2.3\n`);
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
    const accepted = guard(repo, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/v8.0.0",
      GITHUB_SHA: head,
    });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(`sha=${head}`);

    git(repo.work, "checkout", "-b", "unmerged");
    git(repo.work, "commit", "--allow-empty", "-m", "unmerged change");
    const unmerged = git(repo.work, "rev-parse", "HEAD");
    const refused = guard(repo, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/v8.0.0",
      GITHUB_SHA: unmerged,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not an ancestor of origin/main");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("a tag push ancestry refusal names the version derived from the ref", () => {
  const repo = makeRepo();
  try {
    const merged = git(repo.work, "rev-parse", "HEAD");
    const accepted = guard(repo, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/v7.0.0",
      GITHUB_SHA: merged,
    });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(`sha=${merged}`);

    git(repo.work, "checkout", "-b", "unmerged");
    git(repo.work, "commit", "--allow-empty", "-m", "unmerged change");
    const unmerged = git(repo.work, "rev-parse", "HEAD");
    const refused = guard(repo, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/v7.0.0",
      GITHUB_SHA: unmerged,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("v7.0.0");
    expect(refused.stderr).toContain(unmerged);
    expect(refused.stderr).toContain("not an ancestor of origin/main");
    expect(refused.stdout).not.toContain("sha=");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test.each(["refs/heads/main", "refs/tags/release", "refs/tags/v1.2"])(
  "a tag push whose ref %s is not a v<version> tag is refused by ref",
  (ref) => {
    const repo = makeRepo();
    try {
      const head = git(repo.work, "rev-parse", "HEAD");
      const result = guard(repo, {
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: ref,
        GITHUB_SHA: head,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(ref);
      expect(result.stderr).toContain("is not a v<version> tag");
      expect(result.stdout).not.toContain("sha=");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("a tag that points at a tree or blob is refused by version", () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo.work, "release.txt"), "release\n");
    git(repo.work, "add", "release.txt");
    git(repo.work, "commit", "-m", "add release file");
    const tree = git(repo.work, "rev-parse", "HEAD^{tree}");
    const blob = git(repo.work, "rev-parse", "HEAD:release.txt");
    git(repo.work, "tag", "v4.0.0", tree);
    git(repo.work, "tag", "v4.0.1", blob);

    for (const version of ["4.0.0", "4.0.1"]) {
      const result = guard(repo, dispatch(version));
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`v${version}`);
      expect(result.stderr).toContain("does not point at a commit");
      expect(result.stdout).not.toContain("sha=");
    }
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("a git error while peeling is a failure, not a refusal", () => {
  const repo = makeRepo();
  try {
    const bin = join(repo.root, "fake-bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\ncase "$*" in\n  *"^{commit}"*) echo "fatal: simulated git failure" >&2; exit 128 ;;\nesac\necho 1111111111111111111111111111111111111111\n',
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, ["--no-install", SCRIPT], {
      cwd: repo.work,
      env: { ...BASE_ENV, ...dispatch("5.0.0"), PATH: bin },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("git rev-parse");
    expect(result.stderr).toContain("fatal: simulated git failure");
    expect(result.stderr).not.toContain("does not point at a commit");
    expect(result.stdout).not.toContain("sha=");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("a missing git is a failure, not a refusal", () => {
  const repo = makeRepo();
  try {
    const bin = join(repo.root, "empty-bin");
    mkdirSync(bin);
    const result = spawnSync(process.execPath, ["--no-install", SCRIPT], {
      cwd: repo.work,
      env: { ...BASE_ENV, ...dispatch("5.0.1"), PATH: bin },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("git rev-parse --verify --quiet refs/tags/v5.0.1");
    expect(result.stderr).toContain("failed:");
    expect(result.stderr).not.toContain("does not point at a commit");
    expect(result.stdout).not.toContain("sha=");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("a failed output write is a guard failure with its own exit code", () => {
  const repo = makeRepo();
  try {
    git(repo.work, "tag", "v1.2.3");
    const output = join(repo.root, "output-dir");
    mkdirSync(output);
    const result = guard(repo, { ...dispatch("1.2.3"), GITHUB_OUTPUT: output });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("GITHUB_OUTPUT");
    expect(result.stderr).toContain(output);
    expect(result.stderr).toContain("EISDIR");
    expect(result.stdout).not.toContain("sha=");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test.each([
  ["unset", undefined],
  ["empty", ""],
])(
  "under Actions an %s GITHUB_OUTPUT is a guard failure naming it",
  (_name, output) => {
    const repo = makeRepo();
    try {
      git(repo.work, "tag", "v1.2.3");
      const env: Record<string, string> = {
        ...(dispatch("1.2.3") as Record<string, string>),
        GITHUB_ACTIONS: "true",
      };
      if (output !== undefined) env.GITHUB_OUTPUT = output;
      const result = guard(repo, env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("GITHUB_OUTPUT");
      expect(result.stdout).not.toContain("sha=");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("outside Actions an unset GITHUB_OUTPUT keeps the stdout sha line", () => {
  const repo = makeRepo();
  try {
    const head = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "v1.2.3");
    const result = guard(repo, dispatch("1.2.3"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`sha=${head}`);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("the release tag check accepts an annotated tag that still peels to the verified commit", () => {
  const repo = makeRepo();
  try {
    const head = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "-a", "v1.2.3", "-m", "release");
    const tagObject = git(repo.work, "rev-parse", "refs/tags/v1.2.3");
    expect(tagObject).not.toBe(head);
    const result = verifyTag(repo, { TAG: "v1.2.3", EXPECTED_SHA: head });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("v1.2.3");
    expect(result.stdout).toContain(head);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("a tag moved after verification is refused naming the tag and both shas", () => {
  const repo = makeRepo();
  try {
    const expected = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "-a", "v1.2.3", "-m", "release");
    git(repo.work, "commit", "--allow-empty", "-m", "moved on");
    const moved = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "-f", "-a", "v1.2.3", "-m", "moved");

    const result = verifyTag(repo, { TAG: "v1.2.3", EXPECTED_SHA: expected });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v1.2.3");
    expect(result.stderr).toContain(expected);
    expect(result.stderr).toContain(moved);
    expect(result.stdout).not.toContain("ok");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

type Step = {
  uses?: string;
  run?: string;
  id?: string;
  name?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  outputs?: Record<string, unknown>;
};
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

test("every release-publish checkout leaves no credentials in .git/config", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const checkouts = Object.entries(workflow.jobs ?? {}).flatMap(([job, spec]) =>
    (spec.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/checkout@") === true)
      .map((step) => ({ job, step })),
  );
  expect(checkouts.length).toBeGreaterThan(0);
  for (const { job, step } of checkouts) {
    expect(step.with?.["persist-credentials"], `${job} checkout keeps the token`).toBe(false);
  }
});

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
  expect(guard?.outputs?.version).toBe(`\${{ steps.${guardStep?.id}.outputs.version }}`);
  expect(guard?.outputs?.tag).toBe(`\${{ steps.${guardStep?.id}.outputs.tag }}`);
  // The manual path reads the version input; the tag-push path reads the
  // runner's own GITHUB_REF, so VERSION is the only env the step maps.
  expect(guardStep?.env?.VERSION).toBe(INPUT_VERSION);
  // The guard resolves the commit from the run's ref; it is not itself pinned
  // to a ref that came from a job output.
  const guardCheckouts = (guard?.steps ?? []).filter(
    (step) => step.uses?.startsWith("actions/checkout@") === true,
  );
  expect(guardCheckouts.length).toBe(1);
  expect("ref" in (guardCheckouts[0].with ?? {})).toBe(false);

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

test("the GitHub release job takes its version and tag from the guard outputs", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const jobs = workflow.jobs ?? {};
  const release = jobs["github-release"];
  expect(release).toBeDefined();
  // A tag push must not be the only release path.
  expect(release?.if).toBeUndefined();

  const steps = release?.steps ?? [];
  for (const step of steps) {
    for (const [key, value] of Object.entries(step.env ?? {})) {
      expect(
        String(value),
        `${step.name ?? step.uses} ${key} must not read the dispatched ref`,
      ).not.toContain("github.ref_name");
    }
  }

  const create = steps.find((step) => step.name === "Create or update GitHub release");
  expect(create).toBeDefined();
  expect(create?.env?.TAG).toBe(GUARD_TAG);
  expect(create?.env?.VERSION).toBe(GUARD_VERSION);

  const verify = steps.findIndex(
    (step) => step.run === "bun --no-install scripts/verify-release-tag.mjs",
  );
  const createAt = steps.indexOf(create as Step);
  expect(verify, "the release job must call the tag check").toBeGreaterThanOrEqual(0);
  expect(verify, "the tag check must precede the release command").toBeLessThan(createAt);
  expect(steps[verify].env?.TAG).toBe(GUARD_TAG);
  expect(steps[verify].env?.EXPECTED_SHA).toBe(GUARD_SHA);
});
