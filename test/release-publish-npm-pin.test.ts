import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkNpmPinReleaseAge, readNpmPin } from "../scripts/check-npm-pin-release-age.mjs";

const REPO = join(import.meta.dir, "..");
const WORKFLOW = join(REPO, ".github", "workflows", "release-publish.yml");
const UPGRADE = "Upgrade npm to a staging-capable version";
const SELF_UPDATE =
  /^npm install -g npm@(\d+\.\d+\.\d+) --registry=https:\/\/registry\.npmjs\.org$/;
const PUBLISH = /^npm\s+(?:stage|publish)\b/;

type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function loadSteps(): Step[] {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  return workflow.jobs?.["stage-publish"]?.steps ?? [];
}

function workflowRegistryFlag(): string {
  const workflow = readFileSync(WORKFLOW, "utf8");
  expect(readNpmPin(workflow)).toMatch(/^\d+\.\d+\.\d+$/);
  const flag = loadSteps()
    .find((step) => step.name === UPGRADE)
    ?.run?.trim()
    .split(/\s+/)
    .find((argument) => argument.startsWith("--registry="));
  expect(flag).toBeDefined();
  return flag as string;
}

test("the default lookup origin matches the registry accepted from the workflow", async () => {
  const requests: string[] = [];
  const workflow = readFileSync(WORKFLOW, "utf8");
  expect(() => readNpmPin(workflow)).not.toThrow();
  const pin = readNpmPin(workflow);
  await expect(
    checkNpmPinReleaseAge({
      now: Date.parse("2026-01-01T00:00:00.000Z"),
      fetchImpl: async (url: string) => {
        requests.push(url);
        return Response.json({ time: { [pin]: "2020-01-01T00:00:00.000Z" } });
      },
    }),
  ).resolves.toMatchObject({ ok: true });
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).origin).toBe(
    new URL(workflowRegistryFlag().slice("--registry=".length)).origin,
  );
}, 5_000);

const npm = Bun.which("npm");
if (!npm) console.warn("Skipping real npm registry precedence test: npm is not on PATH");

test.skipIf(!npm)(
  "real npm uses the workflow registry over project and environment settings",
  () => {
    const registryFlag = workflowRegistryFlag();
    const root = mkdtempSync(join(tmpdir(), "bob-npm-registry-"));
    try {
      const home = join(root, "home");
      const project = join(root, "project");
      mkdirSync(home);
      mkdirSync(project);
      writeFileSync(join(project, ".npmrc"), "registry=https://registry.example.invalid/\n");
      const result = spawnSync(npm as string, ["config", "get", "registry", registryFlag], {
        cwd: project,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          npm_config_registry: "https://other.example.invalid/",
          npm_config_userconfig: join(home, ".npmrc"),
          npm_config_globalconfig: join(root, "global.npmrc"),
          npm_config_update_notifier: "false",
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("https://registry.npmjs.org/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

function assertion(version: string): string {
  return `v=$(npm --version) || { echo "npm --version failed" >&2; exit 1; }; test "$v" = "${version}" || { echo "npm is $v, expected the pinned ${version}" >&2; exit 1; }`;
}

function pinProblems(steps: Step[]): string[] {
  const upgrades = steps.filter((step) => step.name === UPGRADE);
  if (upgrades.length !== 1) return ["expected one named npm upgrade step"];
  const upgrade = upgrades[0];
  const match = SELF_UPDATE.exec(upgrade.run?.trim() ?? "");
  if (!match)
    return [
      "npm upgrade must be exactly npm install -g npm@<x.y.z> --registry=https://registry.npmjs.org",
    ];
  const version = match[1];
  const [major, minor] = version.split(".").map(Number);
  const problems: string[] = [];
  if (!(major > 11 || (major === 11 && minor >= 15))) {
    problems.push("npm pin must support staging (>=11.15.0)");
  }
  let commands = 0;
  for (const [index, step] of steps.entries()) {
    const lines = (step.run ?? "")
      .trim()
      .split("\n")
      .map((line) => line.trim());
    for (const [line, command] of lines.entries()) {
      if (!PUBLISH.test(command)) continue;
      commands++;
      if (steps.indexOf(upgrade) >= index) {
        problems.push(`${step.name}: npm upgrade must precede stage/publish`);
      }
      if (lines[line - 1] !== assertion(version)) {
        problems.push(
          `${step.name}: stage/publish must immediately follow the npm ${version} assertion`,
        );
      }
    }
  }
  if (commands === 0) problems.push("expected a stage/publish command");
  return problems;
}

test("the named npm upgrade pins an exact version before direct npm stage/publish lines, with matching assertions", () => {
  expect(pinProblems(loadSteps())).toEqual([]);
});

test.each(["npm stage publish", "npm publish --access public"])(
  "%s requires its own immediately preceding assertion",
  (command) => {
    const steps = loadSteps();
    const version = SELF_UPDATE.exec(
      steps.find((step) => step.name === UPGRADE)?.run?.trim() ?? "",
    )?.[1];
    expect(version).toBeDefined();
    steps.push({ name: "Additional publish", run: `${assertion(version as string)}\n${command}` });
    expect(pinProblems(steps)).toEqual([]);
    steps[steps.length - 1].run = command;
    expect(pinProblems(steps)).toContain(
      `Additional publish: stage/publish must immediately follow the npm ${version} assertion`,
    );
  },
);

test.each([
  [
    "assertion removed",
    (steps: Step[]) => {
      const step = steps.find((step) => step.name === "Stage-publish");
      if (step?.run)
        step.run = step.run
          .split("\n")
          .filter((line) => !line.trim().startsWith("v=$(npm --version)"))
          .join("\n");
    },
    "Stage-publish: stage/publish must immediately follow the npm 11.21.1 assertion",
  ],
  [
    "assertion names a different version",
    (steps: Step[]) => {
      const step = steps.find((step) => step.name === "Stage-publish");
      if (step?.run) step.run = step.run.replaceAll("11.21.1", "11.21.2");
    },
    "Stage-publish: stage/publish must immediately follow the npm 11.21.1 assertion",
  ],
  [
    "upgrade moved after publish",
    (steps: Step[]) => {
      const index = steps.findIndex((step) => step.name === UPGRADE);
      steps.push(...steps.splice(index, 1));
    },
    "Stage-publish: npm upgrade must precede stage/publish",
  ],
  [
    "upgrade changed to a range",
    (steps: Step[]) => {
      const step = steps.find((step) => step.name === UPGRADE);
      if (step) step.run = "npm install -g npm@^11.21.1";
    },
    "npm upgrade must be exactly npm install -g npm@<x.y.z> --registry=https://registry.npmjs.org",
  ],
] satisfies [string, (steps: Step[]) => void, string][])(
  "%s is refused",
  (_name, mutate, problem) => {
    const steps = loadSteps();
    mutate(steps);
    expect(pinProblems(steps)).toContain(problem);
  },
);

test.each([
  ["pinned version", true, 0],
  ["different version", false, 0],
  ["failed probe printing the pin", true, 1],
] as const)(
  "the workflow shell checks the npm probe status and version before its direct npm stage command: %s",
  (_name, matches, probeStatus) => {
    const steps = loadSteps();
    const version = SELF_UPDATE.exec(
      steps.find((step) => step.name === UPGRADE)?.run?.trim() ?? "",
    )?.[1];
    expect(version).toBeDefined();
    const script = steps.find((step) => step.name === "Stage-publish")?.run;
    expect(script).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "bob-npm-pin-"));
    try {
      const marker = join(root, "published");
      writeFileSync(
        join(root, "npm"),
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "$BOB_TEST_NPM_VERSION"; exit "$BOB_TEST_NPM_PROBE_STATUS"; fi',
          'if [ "$1" = "stage" ] && [ "$2" = "publish" ]; then touch "$BOB_TEST_PUBLISH_MARKER"; exit 0; fi',
          "exit 2",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", script as string], {
        cwd: REPO,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          BOB_TEST_NPM_VERSION: matches ? version : "0.0.0",
          BOB_TEST_NPM_PROBE_STATUS: String(probeStatus),
          BOB_TEST_PUBLISH_MARKER: marker,
        },
        encoding: "utf8",
      });
      const allowed = matches && probeStatus === 0;
      expect(result.status, result.stderr).toBe(allowed ? 0 : 1);
      expect(existsSync(marker)).toBe(allowed);
      if (probeStatus !== 0) expect(result.stderr).toContain("npm --version failed");
      if (!matches) expect(result.stderr).toContain(`expected the pinned ${version}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
