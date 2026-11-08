// The release guard script picks the one commit a release run stages and refuses
// it unless it is on main. A manual dispatch must use the v<version> tag's
// commit, not the dispatched ref's commit; the workflow test below pins that
// every job after the guard checks out the guard's output sha.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO = join(import.meta.dir, "..");
const WORKFLOW = join(REPO, ".github", "workflows", "release-publish.yml");
const SCRIPT = join(REPO, "scripts", "resolve-release-commit.mjs");
const VERIFY_TAG = join(REPO, "scripts", "verify-release-tag.mjs");
const EXTRACT = join(REPO, "scripts", "changelog-extract.mjs");
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

function pushTag(repo: Repo, tag: string): void {
  git(repo.work, "push", "origin", `refs/tags/${tag}`);
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

test("the remote tag check accepts a lightweight remote tag at the verified commit", () => {
  const repo = makeRepo();
  try {
    const head = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "v1.2.3");
    pushTag(repo, "v1.2.3");
    const result = verifyTag(repo, { TAG: "v1.2.3", EXPECTED_SHA: head });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("v1.2.3");
    expect(result.stdout).toContain(head);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("an annotated remote tag is compared by the commit its peeled ref names", () => {
  const repo = makeRepo();
  try {
    const head = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "-a", "v1.2.3", "-m", "release");
    const tagObject = git(repo.work, "rev-parse", "refs/tags/v1.2.3");
    expect(tagObject).not.toBe(head);
    pushTag(repo, "v1.2.3");

    const accepted = verifyTag(repo, { TAG: "v1.2.3", EXPECTED_SHA: head });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(head);

    // The tag object sha is not the compared value; the peeled commit is.
    const refused = verifyTag(repo, { TAG: "v1.2.3", EXPECTED_SHA: tagObject });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(tagObject);
    expect(refused.stderr).toContain(head);
    expect(refused.stdout).not.toContain("ok");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("a changed remote tag is refused naming both shas while the worktree's local tag stays unchanged", () => {
  const repo = makeRepo();
  try {
    const expected = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "-a", "v1.2.3", "-m", "release");
    pushTag(repo, "v1.2.3");
    git(repo.work, "commit", "--allow-empty", "-m", "moved on");
    const moved = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "push", "origin", "main");

    // Move the tag in the bare origin only; the worktree's local tag stays unchanged.
    git(join(repo.root, "origin.git"), "tag", "-f", "-a", "v1.2.3", "-m", "moved", moved);
    expect(git(repo.work, "rev-parse", "refs/tags/v1.2.3^{commit}")).toBe(expected);

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

test("a deleted remote tag is refused as missing while the worktree's local tag stays unchanged", () => {
  const repo = makeRepo();
  try {
    const head = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "v1.2.3");
    pushTag(repo, "v1.2.3");
    git(join(repo.root, "origin.git"), "tag", "-d", "v1.2.3");
    // The worktree's local tag stays unchanged after the remote tag is deleted.
    expect(git(repo.work, "rev-parse", "refs/tags/v1.2.3")).toBe(head);

    const result = verifyTag(repo, { TAG: "v1.2.3", EXPECTED_SHA: head });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v1.2.3");
    expect(result.stderr).toContain("missing");
    expect(result.stdout).not.toContain("ok");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

test("an unreadable origin is refused as unreadable at the pre-release check, never a pass", () => {
  const repo = makeRepo();
  try {
    const head = git(repo.work, "rev-parse", "HEAD");
    git(repo.work, "tag", "v1.2.3");
    pushTag(repo, "v1.2.3");
    git(repo.work, "remote", "set-url", "origin", join(repo.root, "missing.git"));

    const result = verifyTag(repo, { TAG: "v1.2.3", EXPECTED_SHA: head });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v1.2.3");
    expect(result.stderr).toContain("unreadable");
    expect(result.stdout).not.toContain("ok");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);

type Step = {
  if?: unknown;
  "continue-on-error"?: unknown;
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
  "continue-on-error"?: unknown;
  steps?: Step[];
  outputs?: Record<string, unknown>;
};
type Workflow = { jobs?: Record<string, Job> };

const VERSION_CHECK = "Verify the package version matches the resolved version";
const TAG_CHECK = "Compare the remote tag with the verified commit just before the release";
const TAG_COMMAND = "bun --no-install scripts/verify-release-tag.mjs";
const EXTRACT_STEP = "Extract CHANGELOG section";
const CREATE_RELEASE = "Create or update GitHub release";

function assertRequiredStep(
  workflow: Workflow,
  jobName: string,
  stepName: string,
  beforeName: string,
): Step {
  const job = workflow.jobs?.[jobName];
  expect(job, `${jobName} is missing`).toBeDefined();
  expect(job, jobName).not.toHaveProperty("if");
  expect(job, jobName).not.toHaveProperty("continue-on-error");
  expect(workflow).not.toHaveProperty("defaults.run.shell");
  expect(job, jobName).not.toHaveProperty("defaults.run.shell");
  const steps = job?.steps ?? [];
  expect(steps.filter((step) => step.name === stepName).length, stepName).toBe(1);
  const at = steps.findIndex((step) => step.name === stepName);
  const before = steps.findIndex((step) => step.name === beforeName);
  expect(at, `${stepName} is missing`).toBeGreaterThanOrEqual(0);
  expect(before, `${beforeName} is missing`).toBeGreaterThanOrEqual(0);
  expect(at, `${stepName} must precede ${beforeName}`).toBeLessThan(before);
  const step = steps[at];
  expect(step, stepName).not.toHaveProperty("if");
  expect(step, stepName).not.toHaveProperty("continue-on-error");
  expect(step, stepName).not.toHaveProperty("shell");
  if (stepName === TAG_CHECK) {
    const commands = steps.filter((candidate) => candidate.run === TAG_COMMAND);
    expect(commands.length, TAG_COMMAND).toBe(1);
    expect(step).toBe(commands[0]);
    expect(step.env).toEqual({ TAG: GUARD_TAG, EXPECTED_SHA: GUARD_SHA });
    const releases = steps.filter((candidate) =>
      /\bgh\s+release\s+(?:create|edit)\b/.test(candidate.run ?? ""),
    );
    expect(releases.length, "gh release create/edit").toBe(1);
    expect(steps[before]).toBe(releases[0]);
  }
  if (stepName === VERSION_CHECK) expect(step.env).toEqual({ VERSION: GUARD_VERSION });
  return step;
}

function assertVersionCheck(workflow: Workflow): void {
  const step = assertRequiredStep(workflow, "stage-publish", VERSION_CHECK, "Stage-publish");
  const root = mkdtempSync(join(tmpdir(), "bob-release-version-"));
  try {
    for (const [version, status] of [
      ["1.2.3", 0],
      ["1.2.4", 1],
    ] as const) {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "version-fixture", version }),
      );
      const result = spawnSync("bash", ["-e", "-c", step.run ?? ""], {
        cwd: root,
        env: { ...BASE_ENV, VERSION: "1.2.3" },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status, `package ${version}: ${result.stdout}${result.stderr}`).toBe(status);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChangelogExtraction(workflow: Workflow): string {
  const extract = assertRequiredStep(workflow, "github-release", EXTRACT_STEP, CREATE_RELEASE);
  expect(extract.env?.VERSION).toBe(GUARD_VERSION);
  const command =
    /^\s*node scripts\/changelog-extract\.mjs "\$VERSION" CHANGELOG\.md > ([A-Za-z0-9._/-]+)\s*$/m.exec(
      extract.run ?? "",
    );
  expect(
    command,
    "extraction must invoke changelog-extract.mjs with VERSION and redirect notes",
  ).not.toBeNull();
  const notesFile = command?.[1] ?? "";
  const create = workflow.jobs?.["github-release"]?.steps?.find(
    (step) => step.name === CREATE_RELEASE,
  );
  const notesArguments = [...(create?.run ?? "").matchAll(/--notes-file\s+([^\s\\]+)/g)];
  expect(notesArguments.length, "release must read a notes file").toBeGreaterThan(0);
  for (const argument of notesArguments) expect(argument[1]).toBe(notesFile);
  return notesFile;
}

const REQUIRED_STEPS = [
  ["stage-publish", VERSION_CHECK, "Stage-publish"],
  ["github-release", TAG_CHECK, CREATE_RELEASE],
  ["github-release", EXTRACT_STEP, CREATE_RELEASE],
] as const;

test.each(REQUIRED_STEPS)("%s requires %s before %s", (job, step, before) => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  assertRequiredStep(workflow, job, step, before);
});

for (const [job, step, before] of REQUIRED_STEPS) {
  test.each(["workflow", "job", "step"])(`${step} refuses a %s shell override`, (scope) => {
    const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const required = assertRequiredStep(workflow, job, step, before);
    if (scope === "step") Object.assign(required, { shell: "echo {0}" });
    else {
      Object.assign(scope === "workflow" ? workflow : workflow.jobs?.[job], {
        defaults: { run: { shell: "echo {0}" } },
      });
    }
    expect(() => assertRequiredStep(workflow, job, step, before)).toThrow();
  });

  test.each([
    ["if", false],
    ["if", "github.event_name == 'push'"],
    ["continue-on-error", true],
    ["continue-on-error", false],
  ] as const)(`${step} refuses %s: %j`, (key, value) => {
    const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const required = assertRequiredStep(workflow, job, step, before);
    required[key] = value;
    expect(() => assertRequiredStep(workflow, job, step, before)).toThrow();
  });

  test(`${job} refuses continue-on-error for ${step}`, () => {
    const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const spec = workflow.jobs?.[job];
    if (spec === undefined) throw new Error(`Missing ${job}`);
    spec["continue-on-error"] = true;
    expect(() => assertRequiredStep(workflow, job, step, before)).toThrow();
  });

  test(`${job} refuses a job condition for ${step}`, () => {
    const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const spec = workflow.jobs?.[job];
    if (spec === undefined) throw new Error(`Missing ${job}`);
    Object.assign(spec, { if: false });
    expect(() => assertRequiredStep(workflow, job, step, before)).toThrow();
  });

  test(`${step} refuses placement after ${before}`, () => {
    const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const required = assertRequiredStep(workflow, job, step, before);
    const steps = workflow.jobs?.[job]?.steps ?? [];
    steps.splice(steps.indexOf(required), 1);
    steps.splice(steps.findIndex((candidate) => candidate.name === before) + 1, 0, required);
    expect(() => assertRequiredStep(workflow, job, step, before)).toThrow();
  });
}

test.each(["create", "edit"])("tag comparison refuses an earlier gh release %s step", (command) => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const required = assertRequiredStep(workflow, "github-release", TAG_CHECK, CREATE_RELEASE);
  const steps = workflow.jobs?.["github-release"]?.steps ?? [];
  steps.splice(steps.indexOf(required), 0, {
    name: "Early release",
    run: `gh release ${command} "$TAG"`,
  });
  expect(() => assertRequiredStep(workflow, "github-release", TAG_CHECK, CREATE_RELEASE)).toThrow();
});

test.each([
  "renamed conditional verifier",
  "renamed failure-tolerant verifier",
  "failure-tolerant verifier",
  "duplicate name",
  "duplicate command",
  "wrong env",
])("tag comparison refuses %s", (mutation) => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const required = assertRequiredStep(workflow, "github-release", TAG_CHECK, CREATE_RELEASE);
  const steps = workflow.jobs?.["github-release"]?.steps ?? [];
  if (
    mutation === "renamed conditional verifier" ||
    mutation === "renamed failure-tolerant verifier"
  ) {
    required.name = "Renamed verifier";
    if (mutation === "renamed conditional verifier") required.if = false;
    else required["continue-on-error"] = true;
    steps.splice(steps.indexOf(required), 0, { name: TAG_CHECK, run: "echo verified" });
  } else if (mutation === "failure-tolerant verifier") {
    required["continue-on-error"] = true;
  } else if (mutation === "duplicate name") {
    steps.push({ name: TAG_CHECK, run: "echo verified" });
  } else if (mutation === "duplicate command") {
    steps.push({ name: "Duplicate verifier", run: TAG_COMMAND, env: required.env });
  } else {
    required.env = { TAG: GUARD_TAG, EXPECTED_SHA: INPUT_VERSION };
  }
  expect(() => assertRequiredStep(workflow, "github-release", TAG_CHECK, CREATE_RELEASE)).toThrow();
});

test("workflow version script accepts a matching package and refuses a mismatch", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  assertVersionCheck(workflow);
});

test.each(["exit 0", "echo verified"])("version check refuses a script bypass: %s", (mutation) => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const step = assertRequiredStep(workflow, "stage-publish", VERSION_CHECK, "Stage-publish");
  step.run = mutation === "exit 0" ? `exit 0\n${step.run}` : "echo verified";
  expect(() => assertVersionCheck(workflow)).toThrow();
});

test("changelog extraction writes the release notes file", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  assertChangelogExtraction(workflow);
});

test.each([
  ["run", 'echo "Release v$VERSION" > release-notes.md'],
  ["run", 'node scripts/changelog-extract.mjs "1.2.3" CHANGELOG.md > release-notes.md'],
  ["run", 'node scripts/changelog-extract.mjs "$VERSION" CHANGELOG.md > different-notes.md'],
  ["env", { VERSION: INPUT_VERSION }],
] as const)("changelog extraction refuses mismatched %s: %j", (key, value) => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  assertChangelogExtraction(workflow);
  const extract = assertRequiredStep(workflow, "github-release", EXTRACT_STEP, CREATE_RELEASE);
  Object.assign(extract, { [key]: value });
  expect(() => assertChangelogExtraction(workflow)).toThrow();
});

// A checkout step is identified by the action it runs, not by the pin after the
// `@`: GitHub resolves the owner and repository case-insensitively, so
// `Actions/checkout@<sha>` runs the checkout action. The pin itself must be a
// full commit sha, which check-action-pins.mjs enforces.
function isCheckout(step: Step): boolean {
  const uses = step.uses ?? "";
  const at = uses.indexOf("@");
  return at > 0 && uses.slice(0, at).toLowerCase() === "actions/checkout";
}

const FORBIDDEN_INTERPOLATIONS: ReadonlyArray<{ expression: string; pattern: RegExp }> = [
  { expression: "$" + "{{ github.ref_name }}", pattern: /\$\{\{\s*github\.ref_name\s*\}\}/ },
  { expression: "$" + "{{ github.ref }}", pattern: /\$\{\{\s*github\.ref\s*\}\}/ },
  { expression: "$" + "{{ inputs.* }}", pattern: /\$\{\{\s*inputs\.[^}]*\}\}/ },
];

// Every `${{ }}` expression in a `run:` body or a `with:` value must be listed
// here, compared on whitespace-normalised text. A run body takes no
// branch- or input-derived value: those go through `env:`, which puts the value
// in the environment rather than in the script text, and the command quotes the
// variable.
const ALLOWED_IN_RUN: readonly string[] = [];

const ALLOWED_IN_WITH: ReadonlyArray<{ expression: string; keys: readonly string[] }> = [
  // The guard's verified sha, as a checkout `ref`: the commit a later job
  // builds and stages is the one the guard checked is on main.
  { expression: "needs.verify-ancestry.outputs.sha", keys: ["ref"] },
  // Cache-key material: the runner OS and a lockfile hash, used to name a
  // cache entry.
  { expression: "runner.os", keys: ["key", "restore-keys"] },
  { expression: "hashFiles('bun.lock')", keys: ["key"] },
];

function allowedWithExpressions(key: string): string[] {
  return ALLOWED_IN_WITH.filter((entry) => entry.keys.includes(key)).map(
    (entry) => entry.expression,
  );
}

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;

function expressionsIn(text: string): string[] {
  return [...text.matchAll(EXPRESSION)].map((match) => match[1].replace(/\s+/g, " ").trim());
}

function stepLabel(step: Step, index: number): string {
  return step.name ?? step.uses ?? `step ${index + 1}`;
}

// A `run:` body is command text and a `with:` value is passed to an action.
// `env:` keeps a value out of the script text, and the command still has to
// quote the variable.
function interpolationProblems(job: string, step: Step, index: number): string[] {
  const problems: string[] = [];
  const check = (key: string, value: unknown, allowed: readonly string[]): void => {
    if (typeof value !== "string") return;
    for (const expression of expressionsIn(value)) {
      if (!allowed.includes(expression)) {
        problems.push(`${job} / ${stepLabel(step, index)} / ${key}: ${expression}`);
      }
    }
  };
  if (step.run !== undefined) check("run", step.run, ALLOWED_IN_RUN);
  for (const [key, value] of Object.entries(step.with ?? {})) {
    check(key, value, allowedWithExpressions(key));
  }
  return problems;
}

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

function assertGuardJobConditions(workflow: Workflow): void {
  const jobs = workflow.jobs ?? {};
  for (const [name, job] of Object.entries(jobs)) {
    if (name === GUARD_JOB || afterGuard(jobs, name)) {
      expect(job, name).not.toHaveProperty("if");
    }
  }
}

test("the guard and its dependent jobs carry no condition", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  assertGuardJobConditions(workflow);
});

test.each([GUARD_JOB, "stage-publish", "github-release", "indirect-release"])(
  "%s refuses a job condition in the guard graph",
  (name) => {
    const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const jobs = workflow.jobs ?? {};
    jobs["indirect-release"] = { needs: "github-release" };
    assertGuardJobConditions(workflow);
    Object.assign(jobs[name], { if: false });
    expect(() => assertGuardJobConditions(workflow)).toThrow();
  },
);

test("every release-publish checkout leaves no credentials in .git/config", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const checkouts = Object.entries(workflow.jobs ?? {}).flatMap(([job, spec]) =>
    (spec.steps ?? []).filter((step) => isCheckout(step)).map((step) => ({ job, step })),
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
  // A manual dispatch resolves from the v<version> tag, not from the run's ref;
  // the guard is not itself pinned to a ref that came from a job output.
  const guardCheckouts = (guard?.steps ?? []).filter((step) => isCheckout(step));
  expect(guardCheckouts.length).toBe(1);
  expect("ref" in (guardCheckouts[0].with ?? {})).toBe(false);

  const dependents = Object.keys(jobs).filter(
    (name) => name !== GUARD_JOB && afterGuard(jobs, name),
  );
  expect(dependents.sort()).toEqual(["github-release", "stage-publish"]);
  for (const name of dependents) {
    const checkouts = (jobs[name].steps ?? []).filter((step) => isCheckout(step));
    expect(checkouts.length, `${name} has no checkout`).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step.with?.ref, `${name} must check out the guard's sha`).toBe(GUARD_SHA);
      const ref = String(step.with?.ref ?? "");
      expect(ref).not.toContain("github.sha");
      expect(ref).not.toContain("github.ref_name");
    }
  }
});

test("run bodies and with values hold no expression outside the allowlist", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const problems = Object.entries(workflow.jobs ?? {}).flatMap(([job, spec]) =>
    (spec.steps ?? []).flatMap((step, index) => interpolationProblems(job, step, index)),
  );
  expect(problems, `expressions outside the allowlist:\n${problems.join("\n")}`).toEqual([]);
});

test("stage-publish does not resolve the ref itself; the guard derives the version from GITHUB_REF on a tag push", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const stage = workflow.jobs?.["stage-publish"];
  expect(stage).toBeDefined();
  const steps = stage?.steps ?? [];

  for (const [index, step] of steps.entries()) {
    for (const [key, value] of Object.entries(step.env ?? {})) {
      for (const { expression, pattern } of FORBIDDEN_INTERPOLATIONS) {
        expect(
          pattern.test(String(value)),
          `stage-publish ${stepLabel(step, index)} ${key} must not interpolate ${expression}`,
        ).toBe(false);
      }
    }
  }

  for (const name of ["Verify the package version matches the resolved version", "Summary"]) {
    const step = steps.find((candidate) => candidate.name === name);
    expect(step, `${name} is missing`).toBeDefined();
    expect(step?.env?.VERSION, `${name} must take the guard's version`).toBe(GUARD_VERSION);
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

  const verifier = assertRequiredStep(workflow, "github-release", TAG_CHECK, CREATE_RELEASE);
  const verify = steps.indexOf(verifier);
  const createAt = steps.indexOf(create as Step);
  expect(verify, "the release job must call the tag check").toBeGreaterThanOrEqual(0);
  expect(verify, "the tag check must precede the release command").toBeLessThan(createAt);
  expect(steps[verify].env?.TAG).toBe(GUARD_TAG);
  expect(steps[verify].env?.EXPECTED_SHA).toBe(GUARD_SHA);
});

function versionOutputKey(workflow: Workflow, job: string, stepName: string): string {
  const step = (workflow.jobs?.[job]?.steps ?? []).find((candidate) => candidate.name === stepName);
  const expression = String(step?.env?.VERSION ?? "");
  const match = /needs\.verify-ancestry\.outputs\.([A-Za-z0-9_]+)/.exec(expression);
  expect(match, `${stepName} VERSION is ${JSON.stringify(expression)}`).not.toBeNull();
  return match?.[1] ?? "";
}

test("the guard's written version feeds the real changelog extractor", () => {
  const repo = makeRepo();
  try {
    git(repo.work, "tag", "v1.2.3");
    const output = join(repo.root, "github-output");
    writeFileSync(output, "");
    const guarded = guard(repo, {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      VERSION: "1.2.3",
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: output,
    });
    expect(guarded.status, guarded.stderr).toBe(0);

    // Read the version the resolver wrote under the key the release job's
    // extractor step names, so a wrong key in either place fails this test.
    const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
    const key = versionOutputKey(workflow, "github-release", "Extract CHANGELOG section");
    const written = Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    const version = written[key] ?? "";
    expect(version).toBe("1.2.3");

    const changelog = join(repo.root, "CHANGELOG.md");
    writeFileSync(
      changelog,
      "## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- Something.\n\n## [1.2.2] - 2025-12-01\n\n- Older.\n",
    );
    const notesFile = assertChangelogExtraction(workflow);
    const extract = assertRequiredStep(workflow, "github-release", EXTRACT_STEP, CREATE_RELEASE);
    mkdirSync(join(repo.root, "scripts"));
    copyFileSync(EXTRACT, join(repo.root, "scripts", "changelog-extract.mjs"));
    const matched = spawnSync("bash", ["-c", extract.run ?? ""], {
      cwd: repo.root,
      env: { ...BASE_ENV, VERSION: version },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(matched.status, matched.stderr).toBe(0);
    const notes = readFileSync(join(repo.root, notesFile), "utf8");
    expect(notes).toContain("### Fixed");
    expect(notes).toContain("- Something.");
    expect(notes).not.toContain("- Older.");

    writeFileSync(changelog, "## [1.2.2] - 2025-12-01\n\n- Older.\n");
    const missing = spawnSync("bash", ["-c", extract.run ?? ""], {
      cwd: repo.root,
      env: { ...BASE_ENV, VERSION: version },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("changelog-extract: no '## [1.2.3]' section found");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30_000);
