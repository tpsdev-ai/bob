// bob#355: the version pin check. package.json's packageManager is the source
// of truth for the bun version bob's lockfile is written with; every workflow
// step that uses oven-sh/setup-bun must install it. The check fails on a
// missing, non-literal or drifting bun-version input, on a workflow that cannot
// be read or parsed, and on a package.json that cannot be read, is not a JSON
// object, or does not pin a bun; a run with no setup-bun step to check is a
// finding too. It needs no installed dependency, so CI runs it before
// `bun install`.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkBunVersionPins } from "../scripts/check-bun-version.mjs";

const REPO = join(import.meta.dir, "..");

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

test("a package.json that is valid JSON but not an object is an invalid manifest shape", () => {
  for (const [contents, shape] of [
    ["null", "null"],
    ["[]", "an array"],
    ['"bun@1.3.10"', "a string"],
  ]) {
    const root = fixture("bun@1.3.10");
    writeFileSync(join(root, "package.json"), `${contents}\n`);
    const result = checkBunVersionPins({ root });
    expect(result.declared).toBeUndefined();
    expect(result.errors).toEqual([
      `package.json has an invalid manifest shape: expected a JSON object, got ${shape}`,
    ]);
  }
});

test("a package.json that is not JSON is a parse error, not a read error", () => {
  const root = fixture("bun@1.3.10");
  writeFileSync(join(root, "package.json"), "{ not json\n");
  const result = checkBunVersionPins({ root });
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toStartWith("package.json could not be parsed as JSON: ");
});

// Mode 000 does not stop root from reading, so this case needs a non-root uid
// (CI's runner user is one).
test.skipIf(process.getuid?.() === 0)(
  "a workflow that cannot be read is a read error, not a YAML parse error",
  () => {
    const root = fixture("bun@1.3.10", [
      ["ci.yml", workflow(SETUP_BUN, "        with:", '          bun-version: "1.3.10"')],
      ["locked.yml", workflow(SETUP_BUN, "        with:", '          bun-version: "1.3.10"')],
    ]);
    const locked = join(root, ".github", "workflows", "locked.yml");
    chmodSync(locked, 0o000);
    try {
      const result = checkBunVersionPins({ root });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toStartWith(".github/workflows/locked.yml: could not be read: ");
      expect(result.errors[0]).not.toContain("YAML");
    } finally {
      chmodSync(locked, 0o644);
    }
  },
);

test("a workflow of more than one YAML document is reported rather than skipped", () => {
  const drifting = workflow(SETUP_BUN, "        with:", '          bun-version: "1.4.2"');
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [
      ["ci.yml", workflow(SETUP_BUN, "        with:", '          bun-version: "1.3.10"')],
      ["two.yml", `${drifting}---\n${drifting}`],
    ]),
  });
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toStartWith(".github/workflows/two.yml: ");
});

test("the check runs on bun with no node_modules, as CI runs it before the install", () => {
  // A copy of the checker, package.json and the real workflows in a directory
  // with no node_modules above it. --no-install stops bun from fetching a
  // missing package, so any dependency the checker needs fails here.
  const root = mkdtempSync(join(tmpdir(), "bob-bun-version-bare-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  copyFileSync(
    join(REPO, "scripts", "check-bun-version.mjs"),
    join(root, "scripts", "check-bun-version.mjs"),
  );
  copyFileSync(join(REPO, "package.json"), join(root, "package.json"));
  for (const name of readdirSync(join(REPO, ".github", "workflows"))) {
    copyFileSync(
      join(REPO, ".github", "workflows", name),
      join(root, ".github", "workflows", name),
    );
  }
  const run = spawnSync(
    process.execPath,
    ["--no-install", join(root, "scripts", "check-bun-version.mjs")],
    { cwd: root, encoding: "utf8" },
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("setup-bun step(s) match package.json's bun");
});

test("run without bun's YAML parser, the check fails rather than passing", () => {
  const run = spawnSync("node", [join(REPO, "scripts", "check-bun-version.mjs")], {
    encoding: "utf8",
  });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("Bun.YAML is not available");
});

test("CI's build job runs the check before the frozen install", () => {
  // The check names a drifting step; a frozen install that fails first would
  // stop the job before it could.
  const ci = parseYaml(readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: { build: { steps: Array<{ run?: string }> } };
  };
  const steps = ci.jobs.build.steps.map((step) => step.run ?? "");
  const check = steps.findIndex((run) => run.includes("scripts/check-bun-version.mjs"));
  const install = steps.findIndex((run) => run.includes("bun install"));
  expect(check).toBeGreaterThanOrEqual(0);
  expect(install).toBeGreaterThanOrEqual(0);
  expect(check).toBeLessThan(install);
});

test("this repository's own setup-bun steps match its package.json", () => {
  // The real component: this repo's package.json and its actual workflows.
  expect(checkBunVersionPins().errors).toEqual([]);
});
