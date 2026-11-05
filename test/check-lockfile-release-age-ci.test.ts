// bob#390: the checker is the first `run:` step in each job with a `run:` step,
// except release-publish.yml's verify-ancestry job. Before it, reject an
// actions/cache step whose path has a component exactly .bun or .npm, or a
// `uses:` step with an input named cache or install.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO = join(import.meta.dir, "..");
const WORKFLOWS = join(REPO, ".github/workflows");
const CHECKER = "bun --no-install scripts/check-lockfile-release-age.mjs";
const CACHE_PATH_COMPONENT = /(?:^|[/\\])(?:\.bun|\.npm)(?:[/\\]|$)/;
const CACHE_OR_INSTALL_INPUT = /^(?:cache|install)$/;

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Permissions = Record<string, string> | string;
type Job = {
  needs?: string | string[];
  permissions?: Permissions;
  steps?: Step[];
};
type Workflow = { permissions?: Permissions; jobs?: Record<string, Job> };

const ANCESTRY_JOB = "verify-ancestry";

function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

// Permissions that grant a write scope, including `id-token: write`.
function writePermissions(job: Job, workflow: Workflow): string[] {
  const permissions = job.permissions === undefined ? workflow.permissions : job.permissions;
  if (permissions === undefined) return ["repository-default"];
  if (permissions === "write-all") return ["write-all"];
  if (permissions === null || typeof permissions !== "object") return [];
  return Object.entries(permissions)
    .filter(([, value]) => value === "write")
    .map(([name]) => name);
}

function hasCachePathComponent(step: Step): boolean {
  if (typeof step.uses !== "string" || !/^actions\/cache@/.test(step.uses)) return false;
  const declared = step.with?.path;
  const paths = Array.isArray(declared) ? declared : String(declared ?? "").split(/\r?\n/);
  return paths.some((path) => typeof path === "string" && CACHE_PATH_COMPONENT.test(path.trim()));
}

function cacheOrInstallInput(step: Step): string | null {
  if (typeof step.uses !== "string" || step.with === null || typeof step.with !== "object") {
    return null;
  }
  for (const key of Object.keys(step.with)) {
    if (CACHE_OR_INSTALL_INPUT.test(key)) return key;
  }
  return null;
}

function firstRunIndex(steps: Step[]): number {
  return steps.findIndex((step) => typeof step.run === "string");
}

function orderingProblems(workflow: Workflow, source: string): string[] {
  const problems: string[] = [];
  for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
    if (source === ".github/workflows/release-publish.yml" && job === ANCESTRY_JOB) continue;
    const steps = definition.steps ?? [];
    const firstRun = firstRunIndex(steps);
    if (firstRun === -1) continue;
    const where = `${source}: job "${job}"`;
    if ((steps[firstRun].run ?? "").trim() !== CHECKER) {
      problems.push(
        `${where} step ${firstRun + 1}: the first run step is not the ${CHECKER} checker`,
      );
    }
    for (let index = 0; index < firstRun; index += 1) {
      const step = steps[index];
      if (hasCachePathComponent(step)) {
        problems.push(
          `${where} step ${index + 1} (${step.name ?? step.uses}) is an actions/cache step whose path has a component exactly .bun or .npm before the first run step`,
        );
      }
      const input = cacheOrInstallInput(step);
      if (input !== null) {
        problems.push(
          `${where} step ${index + 1} (${step.uses}) sets input "${input}" before the first run step`,
        );
      }
    }
  }
  return problems;
}

test("the checker is the first run step of each job with a run step, except release-publish.yml verify-ancestry", () => {
  const sources = readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  expect(sources.length).toBeGreaterThan(0);
  const problems = sources.flatMap((name) => {
    const workflow = parseYaml(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;
    return orderingProblems(workflow, `.github/workflows/${name}`);
  });
  expect(problems).toEqual([]);
});

test("a first run step different from the checker is red", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  bun-i:",
      "    steps:",
      "      - run: bun i",
      `      - run: ${CHECKER}`,
      "  bun-a:",
      "    steps:",
      "      - run: bun a",
      `      - run: ${CHECKER}`,
      "  npm-prefix:",
      "    steps:",
      "      - run: npm --prefix . install",
      `      - run: ${CHECKER}`,
      "  continued:",
      "    steps:",
      "      - run: |",
      "          bun \\",
      "            install --frozen-lockfile",
      `      - run: ${CHECKER}`,
    ].join("\n"),
  ) as Workflow;
  expect(orderingProblems(workflow, "fixture.yml")).toEqual([
    `fixture.yml: job "bun-i" step 1: the first run step is not the ${CHECKER} checker`,
    `fixture.yml: job "bun-a" step 1: the first run step is not the ${CHECKER} checker`,
    `fixture.yml: job "npm-prefix" step 1: the first run step is not the ${CHECKER} checker`,
    `fixture.yml: job "continued" step 1: the first run step is not the ${CHECKER} checker`,
  ]);
});

test("an actions/cache step whose path has a component exactly .bun or .npm before the checker is red", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  cache-before:",
      "    steps:",
      "      - name: Cache bun install",
      "        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      "        with:",
      "          path: ~/.bun/install/cache",
      `      - run: ${CHECKER}`,
      "  cache-after:",
      "    steps:",
      `      - run: ${CHECKER}`,
      "      - name: Cache npm",
      "        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      "        with:",
      "          path: ~/.npm",
    ].join("\n"),
  ) as Workflow;
  expect(orderingProblems(workflow, "fixture.yml")).toEqual([
    'fixture.yml: job "cache-before" step 1 (Cache bun install) is an actions/cache step whose path has a component exactly .bun or .npm before the first run step',
  ]);
});

test("a uses step with an input named cache or install before the checker is red", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  cache-input:",
      "    steps:",
      "      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
      "        with:",
      '          node-version: "22"',
      "          cache: npm",
      `      - run: ${CHECKER}`,
      "  version-only:",
      "    steps:",
      "      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
      "        with:",
      '          node-version: "22"',
      `      - run: ${CHECKER}`,
    ].join("\n"),
  ) as Workflow;
  expect(orderingProblems(workflow, "fixture.yml")).toEqual([
    'fixture.yml: job "cache-input" step 1 (actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1) sets input "cache" before the first run step',
  ]);
});

test("a job with only uses steps is exempt", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  uses-only:",
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
      "        with:",
      '          bun-version: "1.4.4"',
    ].join("\n"),
  ) as Workflow;
  expect(orderingProblems(workflow, "fixture.yml")).toEqual([]);
});

function dependsOn(jobs: Record<string, Job>, from: string, target: string): boolean {
  const stack = [...needsOf(jobs[from])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const name = stack.pop();
    if (name === undefined) continue;
    if (name === target) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    const job = jobs[name];
    if (job !== undefined) stack.push(...needsOf(job));
  }
  return false;
}

function workflowSources(): string[] {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

function loadWorkflow(name: string): Workflow {
  return parseYaml(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;
}

test("the release guard has no effective write permission or id-token and checkout sets persist-credentials false", () => {
  const workflow = loadWorkflow("release-publish.yml");
  const jobs = workflow.jobs ?? {};
  const guard = jobs[ANCESTRY_JOB];
  expect(guard).toBeDefined();
  expect(writePermissions(guard, workflow)).toEqual([]);
  expect(guard.permissions).not.toHaveProperty("id-token");
  const checkout = (guard.steps ?? []).find(
    (step) => typeof step.uses === "string" && /^actions\/checkout@/.test(step.uses),
  );
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
});

test("every release job with an effective write permission needs verify-ancestry directly or transitively", () => {
  const workflow = loadWorkflow("release-publish.yml");
  const jobs = workflow.jobs ?? {};
  expect(jobs[ANCESTRY_JOB]).toBeDefined();
  const privileged = Object.entries(jobs).filter(
    ([, job]) => writePermissions(job, workflow).length > 0,
  );
  expect(privileged.length).toBeGreaterThan(0);
  for (const [name] of privileged) {
    expect(dependsOn(jobs, name, ANCESTRY_JOB), `${name} must need verify-ancestry`).toBe(true);
  }
});

test("each job with an effective write permission outside release-publish.yml has no run step", () => {
  const problems: string[] = [];
  for (const source of workflowSources()) {
    if (source === "release-publish.yml") continue;
    const workflow = loadWorkflow(source);
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      if (writePermissions(job, workflow).length === 0) continue;
      if ((job.steps ?? []).some((step) => Object.hasOwn(step, "run"))) {
        problems.push(
          `.github/workflows/${source}: job "${name}" has an effective write permission and a run: step`,
        );
      }
    }
  }
  expect(problems).toEqual([]);
});

test.each([
  ["job write-all", { permissions: "write-all" }, { permissions: { contents: "read" } }],
  ["inherited write", {}, { permissions: { contents: "write" } }],
  ["repository default", {}, {}],
] satisfies [string, Job, Workflow][])("%s is counted as privileged", (_name, job, workflow) => {
  expect(writePermissions(job, workflow).length).toBeGreaterThan(0);
});

test("job permissions override workflow permissions", () => {
  expect(writePermissions({ permissions: {} }, { permissions: "write-all" })).toEqual([]);
  expect(writePermissions({}, { permissions: "read-all" })).toEqual([]);
  expect(writePermissions({}, { permissions: "write-all" })).toEqual(["write-all"]);
});

test("the release guard accepts a merged commit and refuses an unmerged commit", () => {
  const workflow = loadWorkflow("release-publish.yml");
  const steps = workflow.jobs?.[ANCESTRY_JOB]?.steps ?? [];
  const guards = steps.filter((step) => step.name === "Verify the run's commit is on main");
  expect(guards).toHaveLength(1);
  const script = guards[0].run;
  expect(typeof script).toBe("string");
  const root = mkdtempSync(join(tmpdir(), "bob-release-ancestry-"));
  const checkout = join(root, "checkout");
  const remote = join(root, "origin.git");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Release guard test",
    GIT_AUTHOR_EMAIL: "guard@example.invalid",
    GIT_COMMITTER_NAME: "Release guard test",
    GIT_COMMITTER_EMAIL: "guard@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  function git(...args: string[]): string {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  try {
    git("init", "--bare", "--initial-branch=main", remote);
    git("init", "--initial-branch=main", checkout);
    git("-C", checkout, "remote", "add", "origin", remote);
    git("-C", checkout, "commit", "--allow-empty", "-m", "base");
    git("-C", checkout, "checkout", "-b", "merged");
    git("-C", checkout, "commit", "--allow-empty", "-m", "merged change");
    const merged = git("-C", checkout, "rev-parse", "HEAD");
    git("-C", checkout, "checkout", "main");
    git("-C", checkout, "merge", "--no-ff", "merged", "-m", "merge change");
    git("-C", checkout, "push", "origin", "main");
    git("-C", checkout, "checkout", "-b", "unmerged");
    git("-C", checkout, "commit", "--allow-empty", "-m", "unmerged change");
    const unmerged = git("-C", checkout, "rev-parse", "HEAD");
    for (const [sha, accepted] of [
      [merged, true],
      [unmerged, false],
    ] as const) {
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", script as string], {
        cwd: checkout,
        env: { ...env, GITHUB_SHA: sha },
        encoding: "utf8",
      });
      if (accepted) expect(result.status, result.stderr).toBe(0);
      else {
        expect(result.status).not.toBeNull();
        expect(result.status).not.toBe(0);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
