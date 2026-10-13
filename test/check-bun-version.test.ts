// bob#355: the version pin check. package.json's packageManager is the source
// of truth for the bun version bob's lockfile is written with; every workflow's
// setup-bun pin must match it. The check fails on a drifted pin, on a
// packageManager that is not a pinned bun, and when there is no pin to check.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBunVersionPins } from "../scripts/check-bun-version.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A fixture repo with a package.json (packageManager optional) and the given
// workflow files, as [name, contents].
function fixture(
  packageManager: string | undefined,
  workflows: Array<[string, string]> = [
    ["ci.yml", '      - with:\n          bun-version: "1.3.10"\n'],
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

test("a pin that matches package.json passes", () => {
  expect(checkBunVersionPins({ root: fixture("bun@1.3.10") })).toEqual({
    declared: "1.3.10",
    pins: 1,
    errors: [],
  });
});

test("a drifted pin is reported with its file, line and remedy", () => {
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [
      [
        "ci.yml",
        "jobs:\n  build:\n    steps:\n      - uses: x\n      - with:\n          bun-version: 1.4.2\n",
      ],
    ]),
  });
  expect(result.errors).toEqual([
    ".github/workflows/ci.yml:6: setup-bun pin 1.4.2 does not match package.json's bun 1.3.10",
  ]);
});

test("every pin in every workflow is checked", () => {
  const pin = '          bun-version: "1.4.2"\n';
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [
      ["ci.yml", pin],
      ["release.yml", pin],
    ]),
  });
  expect(result.pins).toBe(2);
  expect(result.errors).toHaveLength(2);
  expect(result.errors[0]).toContain(".github/workflows/ci.yml:1:");
  expect(result.errors[1]).toContain(".github/workflows/release.yml:1:");
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

test("no pin to check is a finding, not a vacuous pass", () => {
  const result = checkBunVersionPins({ root: fixture("bun@1.3.10", [["ci.yml", "jobs: {}\n"]]) });
  expect(result.pins).toBe(0);
  expect(result.errors.join("\n")).toContain("no bun-version pin found");
});

test("quoted and unquoted pins, and trailing comments, are read", () => {
  const result = checkBunVersionPins({
    root: fixture("bun@1.3.10", [
      ["ci.yml", "          bun-version: 1.3.10 # pinned to the lockfile\n"],
    ]),
  });
  expect(result.errors).toEqual([]);
});

test("this repository's own pins match its package.json", () => {
  // The real component: this repo's package.json and its actual workflows.
  expect(checkBunVersionPins().errors).toEqual([]);
});
