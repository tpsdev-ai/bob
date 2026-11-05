// bob#390: in every job of every workflow under .github/workflows/, a dedicated
// step whose trimmed `run` is exactly
// `bun --no-install scripts/check-lockfile-release-age.mjs` must precede the
// first dependency install. The test reads the directory instead of a list of
// files or jobs, so a workflow or job added later without that step fails here.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO = join(import.meta.dir, "..");
const WORKFLOWS = join(REPO, ".github/workflows");
const CHECKER = "bun --no-install scripts/check-lockfile-release-age.mjs";
// Dependency installs resolve the committed lockfile. `bun --no-install` and
// `bun run build` do not match, and a global tool install (`npm install -g ...`)
// does not read the project lockfile.
const INSTALL = /\b(?:bun\s+install|npm\s+(?:ci|install))\b/;
const GLOBAL_INSTALL = /(?:^|\s)(?:-g|--global)(?:\s|$)/;

type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function isDependencyInstall(run: string): boolean {
  return INSTALL.test(run) && !GLOBAL_INSTALL.test(run);
}

// Every job that installs a dependency must run the checker in an earlier step,
// as the step's whole command.
function installsWithoutEarlierCheck(workflow: Workflow, source: string): string[] {
  const problems: string[] = [];
  for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
    const steps = definition.steps ?? [];
    const install = steps.findIndex(
      (step) => typeof step.run === "string" && isDependencyInstall(step.run),
    );
    if (install === -1) continue;
    const check = steps.findIndex((step) => step.run?.trim() === CHECKER);
    if (check >= 0 && check < install) continue;
    const where = `${source}: job "${job}" step ${install + 1} (${steps[install].run})`;
    problems.push(
      check === -1
        ? `${where} installs dependencies with no dedicated ${CHECKER} step`
        : `${where} installs dependencies before the ${CHECKER} step (step ${check + 1})`,
    );
  }
  return problems;
}

test("every workflow job checks the lockfile release age before it installs", () => {
  const sources = readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  expect(sources.length).toBeGreaterThan(0);
  const problems = sources.flatMap((name) => {
    const workflow = parseYaml(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;
    return installsWithoutEarlierCheck(workflow, `.github/workflows/${name}`);
  });
  expect(problems).toEqual([]);
});

test("a checker step must be its own exact command, not a mention", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  echoed-check:",
      "    steps:",
      "      - run: echo scripts/check-lockfile-release-age.mjs",
      "      - run: bun install --frozen-lockfile",
    ].join("\n"),
  ) as Workflow;
  expect(installsWithoutEarlierCheck(workflow, "fixture.yml")).toEqual([
    'fixture.yml: job "echoed-check" step 2 (bun install --frozen-lockfile) installs dependencies with no dedicated bun --no-install scripts/check-lockfile-release-age.mjs step',
  ]);
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
      "  npm-global:",
      "    steps:",
      "      - run: npm install -g npm@^11.15.0",
      "  no-install:",
      "    steps:",
      "      - run: bun run build",
    ].join("\n"),
  ) as Workflow;
  expect(installsWithoutEarlierCheck(workflow, "fixture.yml")).toEqual([
    'fixture.yml: job "bun-install" step 1 (sfw bun install --frozen-lockfile) installs dependencies before the bun --no-install scripts/check-lockfile-release-age.mjs step (step 2)',
    'fixture.yml: job "npm-ci" step 1 (npm ci) installs dependencies with no dedicated bun --no-install scripts/check-lockfile-release-age.mjs step',
    'fixture.yml: job "npm-install" step 1 (npm install) installs dependencies with no dedicated bun --no-install scripts/check-lockfile-release-age.mjs step',
  ]);
});
