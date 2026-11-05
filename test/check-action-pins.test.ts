import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkActionPins, createGithubResolver } from "../scripts/check-action-pins.mjs";

const WRONG = "de0fac2e4500dabe0009e67214ff5f5447ce83dd";
const RIGHT = "0c5077e51419868618aeaa5fe8019c62421857d6";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workflow(lines: string[]): string {
  return [
    "name: Fixture",
    "on: push",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...lines.map((line) => `      ${line}`),
    "",
  ].join("\n");
}

function composite(lines: string[]): string {
  return [
    "name: Fixture",
    "description: Fixture action",
    "runs:",
    "  using: composite",
    "  steps:",
    ...lines.map((line) => `    ${line}`),
    "",
  ].join("\n");
}

function fixture(line: string, action = false): string {
  const root = fixtureLines(action ? ["- run: echo fixture", "  shell: bash"] : [line]);
  if (action) writeAction(root, ".github/actions/local", [line]);
  return root;
}

function fixtureLines(lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "bob-action-pins-"));
  roots.push(root);
  const dir = join(root, ".github/workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ci.yml"), workflow(lines));
  return root;
}

function writeAction(root: string, path: string, lines: string[]) {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "action.yml"), composite(lines));
}

function runChecker(root: string, token: string | undefined = "fixture-token") {
  const scripts = join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  const checker = join(scripts, "check-action-pins.mjs");
  copyFileSync(
    fileURLToPath(new URL("../scripts/check-action-pins.mjs", import.meta.url)),
    checker,
  );
  const env = { ...process.env };
  if (token) env.GITHUB_TOKEN = token;
  else delete env.GITHUB_TOKEN;
  return Bun.spawnSync([process.execPath, checker], { env });
}

function resolver(commit = RIGHT, tag = "v2.2.0") {
  return {
    resolveTag: async () => commit,
    findTagForSha: async () => tag,
  };
}

test("the issue's checkout pin with # v4 fails", async () => {
  const root = fixture(`- uses: actions/checkout@${WRONG} # v4`);
  const result = await checkActionPins({ root, resolver: resolver(RIGHT, "v4.2.2") });
  expect(result.checked).toBe(1);
  expect(result.errors.join("\n")).toContain("write # v4.2.2");
});

test("a wrong SHA with a full tag fails the peeled-commit comparison", async () => {
  const root = fixture(`- uses: actions/checkout@${WRONG} # v4.2.2`);
  const result = await checkActionPins({ root, resolver: resolver(RIGHT) });
  expect(result.errors.join("\n")).toContain(`resolves to ${RIGHT}, not the pinned SHA`);
});

test("a correct full-tag pin passes", async () => {
  const root = fixture(`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`, true);
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

test("sub-path action refs with several segments are checked", async () => {
  const root = fixture(`- uses: github/codeql-action/upload/sarif@${WRONG} # v2.2.0`);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.checked).toBe(1);
  expect(result.errors.join("\n")).toContain("github/codeql-action/upload/sarif@");
});

test("a malformed version comment is reported as missing or malformed", async () => {
  const root = fixture(`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0 extra`);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\\n")).toContain(
    "missing or malformed version comment; write # v2.2.0",
  );
});

test(".yaml workflows and action.yaml metadata are scanned", async () => {
  for (const composite of [false, true]) {
    const root = fixture(`- uses: oven-sh/setup-bun@${WRONG} # v2.2.0`, composite);
    const dir = join(root, composite ? ".github/actions/local" : ".github/workflows");
    const from = join(dir, composite ? "action.yml" : "ci.yml");
    renameSync(from, join(dir, composite ? "action.yaml" : "ci.yaml"));
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.checked).toBe(1);
    expect(result.errors.join("\\n")).toContain("not the pinned SHA");
  }
});

test("quoted action refs are checked", async () => {
  const root = fixture(`- uses: "oven-sh/setup-bun@${WRONG}" # v2.2.0`);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\n")).toContain("not the pinned SHA");
});

test("an annotated tag is peeled through the GitHub resolver", async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string) => {
    calls.push(url);
    const object = url.includes("/git/ref/tags/")
      ? { type: "tag", sha: "a".repeat(40) }
      : { type: "commit", sha: RIGHT };
    return { ok: true, json: async () => ({ object }) } as Response;
  };
  const root = fixture(`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`);
  expect(
    await checkActionPins({ root, resolver: createGithubResolver("fake", fakeFetch) }),
  ).toEqual({
    checked: 1,
    errors: [],
  });
  expect(calls).toEqual([
    "https://api.github.com/repos/oven-sh/setup-bun/git/ref/tags/v2.2.0",
    `https://api.github.com/repos/oven-sh/setup-bun/git/tags/${"a".repeat(40)}`,
  ]);
});

test("a missing release tag fails with the action and HTTP status", async () => {
  const fakeFetch = async () => ({ ok: false, status: 404 }) as Response;
  const root = fixture(`- uses: oven-sh/setup-bun@${RIGHT} # v9.9.9`);
  const result = await checkActionPins({ root, resolver: createGithubResolver("fake", fakeFetch) });
  expect(result.errors.join("\n")).toMatch(/oven-sh\/setup-bun@.*HTTP 404/);
});

test("a floating branch ref is reported with file and line", async () => {
  const root = fixture("- uses: actions/checkout@main");
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.checked).toBe(1);
  expect(result.errors.join("\n")).toContain(
    ".github/workflows/ci.yml:7: actions/checkout@main: not pinned to a full 40-character commit SHA",
  );
});

test("a floating major-version ref is reported with file and line", async () => {
  const root = fixture("- uses: actions/checkout@v4");
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.checked).toBe(1);
  expect(result.errors.join("\n")).toContain(
    ".github/workflows/ci.yml:7: actions/checkout@v4: not pinned to a full 40-character commit SHA",
  );
});

test("a short SHA is reported with file and line", async () => {
  const short = RIGHT.slice(0, 7);
  const root = fixture(`- uses: actions/checkout@${short}`);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.checked).toBe(1);
  expect(result.errors.join("\n")).toContain(
    `.github/workflows/ci.yml:7: actions/checkout@${short}: not pinned to a full 40-character commit SHA`,
  );
});

test("an empty ref is reported with file and line", async () => {
  const root = fixture("- uses: actions/checkout@");
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.checked).toBe(1);
  expect(result.errors.join("\n")).toContain(
    ".github/workflows/ci.yml:7: actions/checkout (empty ref): not pinned to a full 40-character commit SHA",
  );
});

test("a missing local action and a Docker tag are reported", async () => {
  const root = fixtureLines([
    "- uses: ./local",
    "- uses: docker://alpine:3.20",
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.checked).toBe(1);
  expect(result.errors.join("\n")).toContain("./local:");
  expect(result.errors.join("\n")).toContain("docker://alpine:3.20: Docker reference requires");
});

test("a major-only comment names the full-tag remedy", async () => {
  const root = fixture(`- uses: oven-sh/setup-bun@${RIGHT} # v2`);
  expect((await checkActionPins({ root, resolver: resolver() })).errors.join("\n")).toContain(
    "write # v2.2.0",
  );
});

test("a missing comment names the full-tag remedy", async () => {
  const root = fixture(`- uses: oven-sh/setup-bun@${RIGHT}`);
  expect((await checkActionPins({ root, resolver: resolver() })).errors.join("\n")).toContain(
    "write # v2.2.0",
  );
});

test("the GitHub resolver discovers and verifies the full tag for a missing comment", async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string) => {
    calls.push(url);
    const body = url.includes("/tags?")
      ? [{ name: "v2.2.0", commit: { sha: RIGHT } }]
      : { object: { type: "commit", sha: RIGHT } };
    return { ok: true, json: async () => body } as Response;
  };
  const root = fixture(`- uses: oven-sh/setup-bun@${RIGHT}`);
  const result = await checkActionPins({ root, resolver: createGithubResolver("fake", fakeFetch) });
  expect(result.errors.join("\n")).toContain("write # v2.2.0");
  expect(calls).toEqual([
    "https://api.github.com/repos/oven-sh/setup-bun/tags?per_page=100&page=1",
    "https://api.github.com/repos/oven-sh/setup-bun/git/ref/tags/v2.2.0",
  ]);
});

test("an API error never passes", async () => {
  const fakeFetch = async () => ({ ok: false, status: 503 }) as Response;
  const root = fixture(`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`);
  const result = await checkActionPins({ root, resolver: createGithubResolver("fake", fakeFetch) });
  expect(result.errors.join("\n")).toMatch(/oven-sh\/setup-bun@.*HTTP 503/);
});

for (const [form, line] of [
  ["flow-mapping step", "- { uses: oven-sh/setup-bun@v2 }"],
  ["quoted uses key", '- "uses": oven-sh/setup-bun@v2'],
]) {
  test(`${form} is refused with the canonical-line remedy`, async () => {
    const root = fixtureLines([line, `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]);
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.errors.join("\n")).toContain(
      ".github/workflows/ci.yml: oven-sh/setup-bun@v2 is written in a form the pin check cannot locate; " +
        "write it as `- uses: owner/repo@<40-hex> # vX.Y.Z`",
    );
  });
}

test("a reusable-workflow job reference is checked", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    "name: Fixture\non: push\njobs:\n  check:\n    uses: owner/repo/.github/workflows/build.yml@main\n",
  );
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.checked).toBe(1);
  expect(result.errors.join("\n")).toContain(
    ".github/workflows/ci.yml:5: owner/repo/.github/workflows/build.yml@main: not pinned",
  );
});

test("uses text in a run block is ignored", async () => {
  const root = fixtureLines([
    "- run: |",
    "    uses: actions/checkout@main",
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

test("run text cannot locate a noncanonical reference with the same value", async () => {
  const root = fixtureLines([
    `- { uses: oven-sh/setup-bun@${RIGHT} }`,
    "- run: |",
    `    uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\n")).toContain("is written in a form the pin check cannot locate");
});

test("a followed local action reports its floating reference", async () => {
  const root = fixtureLines([
    "- uses: ./tools/local",
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  writeAction(root, "tools/local", ["- uses: actions/checkout@main"]);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\n")).toContain(
    "tools/local/action.yml:6: actions/checkout@main: not pinned",
  );
});

test("missing local action metadata is reported", async () => {
  const root = fixtureLines([
    "- uses: ./tools/local",
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  mkdirSync(join(root, "tools/local"), { recursive: true });
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\n")).toContain("./tools/local: missing local action.yml/action.yaml");
});

test("an oversized workflow file is reported", async () => {
  const root = fixtureLines([]);
  writeFileSync(join(root, ".github/workflows/ci.yml"), " ".repeat(1_048_577));
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors).toEqual([".github/workflows/ci.yml: action file exceeds scan limit"]);
});

test("a directory named action.yml is reported", async () => {
  const root = fixtureLines(["- uses: ./tools/local"]);
  mkdirSync(join(root, "tools/local/action.yml"), { recursive: true });
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors).toEqual(["tools/local/action.yml: action file is not a regular file"]);
});

test("local action.yaml references and cycles are followed once", async () => {
  const root = fixtureLines(["- uses: ./tools/local"]);
  writeAction(root, "tools/local", [
    "- uses: ./tools/local",
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  renameSync(join(root, "tools/local/action.yml"), join(root, "tools/local/action.yaml"));
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

test("a tag-only Docker reference is reported", async () => {
  const root = fixtureLines([
    "- uses: docker://alpine:3.20",
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\n")).toContain("Docker reference requires @sha256:<64-hex>");
});

test("a Docker reference with a full digest is accepted", async () => {
  const root = fixtureLines([`- uses: docker://alpine@sha256:${"a".repeat(64)}`]);
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 0, errors: [] });
});

test("unparseable YAML reports the file and exits non-zero", async () => {
  const root = fixtureLines([]);
  writeFileSync(join(root, ".github/workflows/ci.yml"), "jobs: [\n");
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\n")).toContain(".github/workflows/ci.yml:");
  const cli = runChecker(root);
  expect(cli.exitCode).toBe(1);
  expect(cli.stderr.toString()).toContain(".github/workflows/ci.yml:");
});

test("the CLI refuses a missing token before scanning YAML", () => {
  const root = fixtureLines([]);
  writeFileSync(join(root, ".github/workflows/ci.yml"), "jobs: [\n");
  const cli = runChecker(root, "");
  expect(cli.exitCode).toBe(1);
  expect(cli.stderr.toString()).toContain("GITHUB_TOKEN is required");
  expect(cli.stderr.toString()).not.toContain(".github/workflows/ci.yml:");
});

for (const source of [
  "jobs: []\n",
  "jobs: { check: null }\n",
  "jobs: { check: { steps: {} } }\n",
  "jobs: { check: { steps: [null] } }\n",
  "jobs: { check: { steps: [{ uses: 42 }] } }\n",
]) {
  test(`an unwalkable workflow is reported: ${source.trim()}`, async () => {
    const root = fixtureLines([]);
    writeFileSync(join(root, ".github/workflows/ci.yml"), source);
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.errors.join("\n")).toContain(".github/workflows/ci.yml:");
    expect(result.errors.length).toBeGreaterThan(0);
  });
}
