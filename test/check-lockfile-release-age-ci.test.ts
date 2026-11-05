// bob#390: the lockfile release-age checker is the first run step of every
// workflow job that runs commands, except the release workflow's ancestry
// guard job, which runs no repository script. An actions/cache step whose path
// contains .bun or .npm, and a uses step with an input named cache or install,
// may not precede the checker.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO = join(import.meta.dir, "..");
const WORKFLOWS = join(REPO, ".github/workflows");
const CHECKER = "bun --no-install scripts/check-lockfile-release-age.mjs";
// A package cache under the user's Bun or npm cache directory.
const PACKAGE_CACHE_PATH = /(?:^|[/\\])(?:\.bun|\.npm)(?:[/\\]|$)/;
// A `uses:` input that installs or restores dependencies.
const INSTALL_INPUT = /^(?:cache|install)$/;

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = {
  needs?: string | string[];
  permissions?: Record<string, string> | string;
  steps?: Step[];
};
type Workflow = { jobs?: Record<string, Job> };

const ANCESTRY_CHECK = "git merge-base --is-ancestor";

// The ancestry guard job runs git commands only, so it cannot also run the
// checker. It is the one job the ordering rule skips.
function isAncestryGuard(job: Job): boolean {
  return (job.steps ?? []).some(
    (step) => typeof step.run === "string" && step.run.includes(ANCESTRY_CHECK),
  );
}

function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

// Permissions that grant a write scope, including `id-token: write`.
function writePermissions(job: Job): string[] {
  const permissions = job.permissions;
  if (permissions === null || typeof permissions !== "object") return [];
  return Object.entries(permissions)
    .filter(([, value]) => value === "write")
    .map(([name]) => name);
}

function restoresPackageCache(step: Step): boolean {
  if (typeof step.uses !== "string" || !/^actions\/cache@/.test(step.uses)) return false;
  const declared = step.with?.path;
  const paths = Array.isArray(declared) ? declared : String(declared ?? "").split(/\r?\n/);
  return paths.some((path) => typeof path === "string" && PACKAGE_CACHE_PATH.test(path.trim()));
}

function installInput(step: Step): string | null {
  if (typeof step.uses !== "string" || step.with === null || typeof step.with !== "object") {
    return null;
  }
  for (const key of Object.keys(step.with)) {
    if (INSTALL_INPUT.test(key)) return key;
  }
  return null;
}

function firstRunIndex(steps: Step[]): number {
  return steps.findIndex((step) => typeof step.run === "string");
}

// Jobs with no run step are exempt. Everywhere else the first run step must be
// the checker, and nothing before it may fetch packages.
function orderingProblems(workflow: Workflow, source: string): string[] {
  const problems: string[] = [];
  for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
    if (isAncestryGuard(definition)) continue;
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
      if (restoresPackageCache(step)) {
        problems.push(
          `${where} step ${index + 1} (${step.name ?? step.uses}) restores a package cache before the first run step`,
        );
      }
      const input = installInput(step);
      if (input !== null) {
        problems.push(
          `${where} step ${index + 1} (${step.uses}) sets install input "${input}" before the first run step`,
        );
      }
    }
  }
  return problems;
}

test("the checker is the first run step of every workflow job that runs commands", () => {
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

test("a run step before the checker is red whatever its text", () => {
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

test("a package-cache restore before the checker is red", () => {
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
    'fixture.yml: job "cache-before" step 1 (Cache bun install) restores a package cache before the first run step',
  ]);
});

test("a uses step whose inputs install dependencies before the checker is red", () => {
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
    'fixture.yml: job "cache-input" step 1 (actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1) sets install input "cache" before the first run step',
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

test("the release workflow's ancestry guard is read-only and checks out without credentials", () => {
  const workflow = loadWorkflow("release-publish.yml");
  const jobs = workflow.jobs ?? {};
  const guards = Object.keys(jobs).filter((name) => isAncestryGuard(jobs[name]));
  expect(guards).toHaveLength(1);
  const guard = jobs[guards[0]];
  expect(writePermissions(guard)).toEqual([]);
  expect(guard.permissions).not.toHaveProperty("id-token");
  const checkout = (guard.steps ?? []).find(
    (step) => typeof step.uses === "string" && /^actions\/checkout@/.test(step.uses),
  );
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
});

test("every job with id-token or a write permission needs the ancestry guard", () => {
  const workflow = loadWorkflow("release-publish.yml");
  const jobs = workflow.jobs ?? {};
  const guard = Object.keys(jobs).find((name) => isAncestryGuard(jobs[name]));
  expect(guard).toBeDefined();
  const privileged = Object.entries(jobs).filter(([, job]) => {
    const permissions = job.permissions;
    if (permissions === null || typeof permissions !== "object") return false;
    return permissions["id-token"] === "write" || writePermissions(job).length > 0;
  });
  expect(privileged.length).toBeGreaterThan(0);
  for (const [name] of privileged) {
    expect(dependsOn(jobs, name, guard as string)).toBe(true);
  }
});

test("a job that holds a write permission needs a prerequisite before a repository script", () => {
  const problems: string[] = [];
  for (const source of workflowSources()) {
    const workflow = loadWorkflow(source);
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      if (writePermissions(job).length === 0) continue;
      const runsRepositoryScript = (job.steps ?? []).some(
        (step) => typeof step.run === "string" && /\bscripts\//.test(step.run),
      );
      if (runsRepositoryScript && needsOf(job).length === 0) {
        problems.push(
          `.github/workflows/${source}: job "${name}" holds a write permission and runs a repository script with no needs:`,
        );
      }
    }
  }
  expect(problems).toEqual([]);
});
