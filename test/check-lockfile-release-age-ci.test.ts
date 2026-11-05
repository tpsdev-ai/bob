// bob#390: a dedicated checker step must precede every npm or bun install
// command (global or not) and every recognised package-cache restore.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO = join(import.meta.dir, "..");
const WORKFLOWS = join(REPO, ".github/workflows");
const CHECKER = "bun --no-install scripts/check-lockfile-release-age.mjs";
// npm and Bun install commands, global or not.
// `bun --no-install` and `bun run build` do not match.
const PROJECT_INSTALL = /^(?:npm\s+ci\b|npm\s+(?:install|i)\b|bun\s+(?:install|add)\b)/;
// A package cache under the user's Bun or npm cache directory.
const PACKAGE_CACHE_PATH = /(?:^|[/\\])(?:\.bun|\.npm)(?:[/\\]|$)/;

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

// Classify each command in a `run` separately.
function splitCommands(run: string): string[] {
  return run
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
}

function isProjectDependencyInstall(command: string): boolean {
  const trimmed = command.replace(/^sfw\s+/, "");
  return PROJECT_INSTALL.test(trimmed);
}

function isDependencyInstall(run: string): boolean {
  return splitCommands(run).some(isProjectDependencyInstall);
}

function restoresPackageCache(step: Step): boolean {
  if (typeof step.uses !== "string" || !/^actions\/cache@/.test(step.uses)) return false;
  const declared = step.with?.path;
  const paths = Array.isArray(declared) ? declared : String(declared ?? "").split(/\r?\n/);
  return paths.some((path) => typeof path === "string" && PACKAGE_CACHE_PATH.test(path.trim()));
}

type Gate = { index: number; kind: "install" | "cache" };

function firstGate(steps: Step[]): Gate | null {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (typeof step.run === "string" && isDependencyInstall(step.run)) {
      return { index, kind: "install" };
    }
    if (restoresPackageCache(step)) return { index, kind: "cache" };
  }
  return null;
}

// Every job that installs a dependency or restores a package cache must run the
// checker in an earlier step, as the step's whole command.
function installsWithoutEarlierCheck(workflow: Workflow, source: string): string[] {
  const problems: string[] = [];
  for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
    const steps = definition.steps ?? [];
    const gate = firstGate(steps);
    if (gate === null) continue;
    const check = steps.findIndex((step) => step.run?.trim() === CHECKER);
    if (check >= 0 && check < gate.index) continue;
    const step = steps[gate.index];
    const detail =
      gate.kind === "install"
        ? `${step.run}) installs dependencies`
        : `${step.name ?? step.uses}) restores a package cache`;
    const where = `${source}: job "${job}" step ${gate.index + 1} (${detail}`;
    problems.push(
      check === -1
        ? `${where} with no dedicated ${CHECKER} step`
        : `${where} before the ${CHECKER} step (step ${check + 1})`,
    );
  }
  return problems;
}

test("every installing workflow job checks the lockfile release age before it installs", () => {
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
    'fixture.yml: job "npm-global" step 1 (npm install -g npm@^11.15.0) installs dependencies with no dedicated bun --no-install scripts/check-lockfile-release-age.mjs step',
  ]);
});

test("global installs before the checker are reported alone and in a mixed run", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  mixed:",
      "    steps:",
      "      - run: npm install -g npm@^11.15.0 && sfw bun install --frozen-lockfile",
      "      - run: bun --no-install scripts/check-lockfile-release-age.mjs",
      "  global-only:",
      "    steps:",
      "      - run: npm install -g npm@^11.15.0",
      "      - run: bun --no-install scripts/check-lockfile-release-age.mjs",
    ].join("\n"),
  ) as Workflow;
  expect(installsWithoutEarlierCheck(workflow, "fixture.yml")).toEqual([
    'fixture.yml: job "mixed" step 1 (npm install -g npm@^11.15.0 && sfw bun install --frozen-lockfile) installs dependencies before the bun --no-install scripts/check-lockfile-release-age.mjs step (step 2)',
    'fixture.yml: job "global-only" step 1 (npm install -g npm@^11.15.0) installs dependencies before the bun --no-install scripts/check-lockfile-release-age.mjs step (step 2)',
  ]);
});

test("a package-cache restore after the checker passes and one before it fails", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  cache-before:",
      "    steps:",
      "      - name: Cache bun install",
      "        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      "        with:",
      "          path: ~/.bun/install/cache",
      "      - run: bun --no-install scripts/check-lockfile-release-age.mjs",
      "  cache-after:",
      "    steps:",
      "      - run: bun --no-install scripts/check-lockfile-release-age.mjs",
      "      - name: Cache npm",
      "        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      "        with:",
      "          path: ~/.npm",
      "      - run: sfw bun install --frozen-lockfile",
    ].join("\n"),
  ) as Workflow;
  expect(installsWithoutEarlierCheck(workflow, "fixture.yml")).toEqual([
    'fixture.yml: job "cache-before" step 1 (Cache bun install) restores a package cache before the bun --no-install scripts/check-lockfile-release-age.mjs step (step 2)',
  ]);
});
