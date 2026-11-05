// bob#390: the release-age check must run before the first dependency install
// in every CI job that installs. The test reads the real workflow instead of a
// list of job names, so a job added later without the check fails here.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO = join(import.meta.dir, "..");
const CHECKER = "scripts/check-lockfile-release-age.mjs";
// The install commands CI uses. `bun --no-install` and `bun run build` do not match.
const INSTALL = /\b(?:bun\s+install|npm\s+(?:ci|install))\b/;

type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

// Every job that installs must run the checker in an earlier step.
function installsWithoutEarlierCheck(workflow: Workflow, source: string): string[] {
  const problems: string[] = [];
  for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
    const steps = definition.steps ?? [];
    const install = steps.findIndex(
      (step) => typeof step.run === "string" && INSTALL.test(step.run),
    );
    if (install === -1) continue;
    const check = steps.findIndex((step) => step.run?.includes(CHECKER) === true);
    if (check >= 0 && check < install) continue;
    const where = `${source}: job "${job}" step ${install + 1} (${steps[install].run})`;
    problems.push(
      check === -1
        ? `${where} installs dependencies with no ${CHECKER} step`
        : `${where} installs dependencies before the ${CHECKER} step (step ${check + 1})`,
    );
  }
  return problems;
}

test("every CI job checks the lockfile release age before it installs", () => {
  const source = ".github/workflows/ci.yml";
  const workflow = parseYaml(readFileSync(join(REPO, source), "utf8")) as Workflow;
  expect(installsWithoutEarlierCheck(workflow, source)).toEqual([]);
});

test("an install without an earlier check is reported in each install form", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  bun-install:",
      "    steps:",
      "      - run: sfw bun install --frozen-lockfile",
      "      - run: bun --no-install scripts/check-lockfile-release-age.mjs",
      "  npm-ci:",
      "    steps:",
      "      - run: npm ci",
      "  npm-install:",
      "    steps:",
      "      - run: npm install",
      "  no-install:",
      "    steps:",
      "      - run: bun run build",
    ].join("\n"),
  ) as Workflow;
  expect(installsWithoutEarlierCheck(workflow, "fixture.yml")).toEqual([
    'fixture.yml: job "bun-install" step 1 (sfw bun install --frozen-lockfile) installs dependencies before the scripts/check-lockfile-release-age.mjs step (step 2)',
    'fixture.yml: job "npm-ci" step 1 (npm ci) installs dependencies with no scripts/check-lockfile-release-age.mjs step',
    'fixture.yml: job "npm-install" step 1 (npm install) installs dependencies with no scripts/check-lockfile-release-age.mjs step',
  ]);
});
