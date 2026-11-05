// bob#390: the lockfile release-age checker is the first run step of every
// workflow job that runs commands. No package-cache restore and no `uses:`
// step whose inputs install dependencies may precede it.
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
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

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
