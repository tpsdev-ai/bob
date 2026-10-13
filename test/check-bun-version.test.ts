// bob#355: the version pin check. package.json's packageManager is the source
// of truth for the bun version bob's lockfile is written with; every workflow
// step that uses oven-sh/setup-bun must install it. The check fails on a
// missing, non-literal or drifting bun-version input, on an unparseable
// workflow, and on a packageManager that is not a pinned bun; a run with no
// setup-bun step to check is a finding too.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBunVersionPins } from "../scripts/check-bun-version.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SETUP_BUN = "      - uses: oven-sh/setup-bun@v2";

// A workflow with one job whose steps are the given YAML fragments, each
// indented as a list item under `steps:`.
function workflow(...steps: string[]): string {
  return [
    "name: fixture",
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...steps,
    "",
  ].join("\n");
}

// A fixture repo with a package.json (packageManager optional) and the given
// workflow files, as [name, contents].
function fixture(
  packageManager: string | undefined,
  workflows: Array<[string, string]> = [
    ["ci.yml", workflow(SETUP_BUN, "        with:", '          bun-version: "1.3.10"')],
  ],
): string {
  const root = mkdtempSync(join(tmpdir(), "bob-bun-version-"));
  roots.push(root);
  const pkg: Record<string, unknown> = { name: "fixture" };
  if (packageManager !== undefined) pkg.packageManager = packageManager;
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of workflows) writeFileSync(join(dir, name), contents);
  return root;
}

test("a workflow whose setup-bun step carries the declared version passes", () => {
  expect(checkBunVersionPins({ root: fixture("bun@1.3.10") })).toEqual({
    declared: "1.3.10",
    pins: 1,
    errors: [],
  });
});

test("a removed bun-version input is reported with its file and step", () => {
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [["ci.yml", workflow(SETUP_BUN)]]),
  });
  expect(result.pins).toBe(1);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain(".github/workflows/ci.yml: job build");
  expect(result.errors[0]).toContain("no bun-version input");
});

test("a changed bun-version is reported with its file and step", () => {
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [
      ["ci.yml", workflow(SETUP_BUN, "        with:", '          bun-version: "1.4.2"')],
    ]),
  });
  expect(result.errors).toEqual([
    '.github/workflows/ci.yml: job build, step using oven-sh/setup-bun@v2: setup-bun bun-version 1.4.2 does not match package.json\'s bun 1.3.10; set it to "1.3.10"',
  ]);
});

test("a non-literal bun-version expression is reported", () => {
  // Split so a linter does not read the expression as a template string.
  const expression = "          bun-version: " + "$" + "{{ vars.BUN }}";
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [["ci.yml", workflow(SETUP_BUN, "        with:", expression)]]),
  });
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("is not a literal version");
});

test("a workflow that does not parse is reported rather than skipped", () => {
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [["ci.yml", "jobs: [unclosed\n"]]),
  });
  expect(result.pins).toBe(0);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain(".github/workflows/ci.yml: could not be parsed as YAML");
});

test("a setup-bun step in every workflow and job is checked", () => {
  const bad = workflow(SETUP_BUN, "        with:", '          bun-version: "1.4.2"');
  const twoJobs = [
    "name: fixture",
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    SETUP_BUN,
    "        with:",
    '          bun-version: "1.3.10"',
    "  release:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    SETUP_BUN,
    "        with:",
    '          bun-version: "1.4.2"',
    "",
  ].join("\n");
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [
      ["ci.yml", twoJobs],
      ["release.yml", bad],
    ]),
  });
  expect(result.pins).toBe(3);
  expect(result.errors).toHaveLength(2);
  expect(result.errors[0]).toContain(".github/workflows/ci.yml:");
  expect(result.errors[1]).toContain(".github/workflows/release.yml:");
});

test("an absent packageManager is a finding, not a pass", () => {
  const result = checkBunVersionPins({ root: fixture(undefined) });
  expect(result.declared).toBeUndefined();
  expect(result.errors.join("\n")).toContain("packageManager is not a pinned");
});

test("a packageManager that is not a pinned bun is a finding", () => {
  const result = checkBunVersionPins({ root: fixture("pnpm@8.0.0") });
  expect(result.declared).toBeUndefined();
  expect(result.errors.join("\n")).toContain("packageManager is not a pinned");
});

test("no setup-bun step to check is a finding, not a vacuous pass", () => {
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [["ci.yml", workflow("      - run: echo hi")]]),
  });
  expect(result.pins).toBe(0);
  expect(result.errors.join("\n")).toContain("no oven-sh/setup-bun step found");
});

test("this repository's own setup-bun steps match its package.json", () => {
  // The real component: this repo's package.json and its actual workflows.
  expect(checkBunVersionPins().errors).toEqual([]);
});
