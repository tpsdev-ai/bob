import { afterEach, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkActionPins,
  createGithubResolver,
  refuseDuplicateKeys,
} from "../scripts/check-action-pins.mjs";

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
  test(`${form} is refused outside the YAML subset`, async () => {
    const root = fixtureLines([line, `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]);
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.errors.join("\n")).toContain(
      `.github/workflows/ci.yml: line 7: ${form === "flow-mapping step" ? "flow mapping" : "quoted key"} is outside the YAML subset; write`,
    );
  });
}

for (const [form, source] of [
  [
    "an aliased workflow step",
    workflow(["- &action", `  uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`, "- *action"]),
    "*action",
  ],
  [
    "an aliased uses value",
    workflow([`- uses: &action oven-sh/setup-bun@${RIGHT} # v2.2.0`, "- uses: *action"]),
    "*action",
  ],
  [
    "an aliased workflow job",
    `jobs:\n  check: &job\n    uses: owner/repo/.github/workflows/build.yml@${RIGHT} # v2.2.0\n  copy: *job\n`,
    "*job",
  ],
  [
    "a merge-key job inheriting uses",
    `jobs:\n  check: &job\n    uses: owner/repo/.github/workflows/build.yml@${RIGHT} # v2.2.0\n  copy:\n    <<: *job\n`,
    "*job",
  ],
  [
    "a flow merge-key step inheriting uses",
    workflow([`- &action { uses: oven-sh/setup-bun@${RIGHT} }`, "- { <<: *action }"]),
    "*action",
  ],
  [
    "an alias of the jobs mapping",
    `definitions: &jobs\n  check:\n    uses: owner/repo/.github/workflows/build.yml@${RIGHT} # v2.2.0\njobs: *jobs\n`,
    "*jobs",
  ],
]) {
  test(`${form} is refused with the file and full-step remedy`, async () => {
    const root = fixtureLines([]);
    writeFileSync(join(root, ".github/workflows/ci.yml"), source);
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.errors.join("\n")).toContain("anchor or alias is outside the YAML subset");
    expect(result.errors.join("\n")).toMatch(/\.github\/workflows\/ci.yml: line \d+:/);
    expect(result.errors.join("\n")).toContain("write the step out in full");
  });
}

test("an aliased composite-action step is refused", async () => {
  const root = fixtureLines(["- uses: ./tools/local"]);
  writeAction(root, "tools/local", [
    "- &action",
    `  uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
    "- *action",
  ]);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\n")).toContain(
    "tools/local/action.yml: line 6: anchor or alias is outside the YAML subset",
  );
  expect(result.errors.join("\n")).toContain("write the step out in full");
});

test("alias-like text in run blocks, quotes and comments is ignored", async () => {
  const root = fixtureLines([
    "- run: |",
    "    echo *action &action",
    '- run: "echo *action"',
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
    "# *action &action",
  ]);
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

for (const [form, line] of [
  [
    "a job-level flow mapping",
    "jobs: { check: { uses: owner/repo/.github/workflows/build.yml@main } }\n",
    "`uses: owner/repo/.github/workflows/<file>.yml@<40-hex> # vX.Y.Z` at the job key",
  ],
  [
    "a job-level local flow mapping",
    "jobs: { check: { uses: ./.github/workflows/build.yml } }\n",
    "`uses: ./.github/workflows/<file>.yml` at the job key",
  ],
  [
    "a quoted local uses key",
    workflow(['- "uses": "./tools/local"']),
    "`- uses: ./path` (local actions are followed, not pinned)",
  ],
  [
    "a quoted Docker uses key",
    workflow(['- "uses": "docker://alpine:3.20"']),
    "`- uses: docker://image@sha256:<64-hex>`",
  ],
]) {
  test(`${form} is refused by the YAML subset check`, async () => {
    const root = fixtureLines([]);
    writeFileSync(join(root, ".github/workflows/ci.yml"), line);
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.errors.join("\n")).toContain(".github/workflows/ci.yml:");
    expect(result.errors.join("\n")).toContain(
      `${form.includes("flow") ? "flow mapping" : "quoted key"} is outside the YAML subset; write`,
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

for (const extension of ["yml", "yaml"]) {
  test(`an existing local reusable .${extension} workflow is scanned as a workflow`, async () => {
    const root = fixtureLines([]);
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      `jobs:\n  check:\n    uses: ./.github/workflows/build.${extension}\n`,
    );
    writeFileSync(
      join(root, `.github/workflows/build.${extension}`),
      workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]),
    );
    expect(await checkActionPins({ root, resolver: resolver() })).toEqual({
      checked: 1,
      errors: [],
    });
    writeFileSync(
      join(root, `.github/workflows/build.${extension}`),
      workflow(["- uses: evil/repo@main"]),
    );
    expect((await checkActionPins({ root, resolver: resolver() })).errors.join("\n")).toContain(
      `.github/workflows/build.${extension}:7: evil/repo@main: not pinned`,
    );
  });
}

for (const [form, value] of [
  ["missing file", "./.github/workflows/missing.yml"],
  ["outside workflows", "./tools/build.yml"],
  ["parent traversal", "./.github/workflows/../build.yml"],
  ["wrong extension", "./.github/workflows/build.txt"],
  ["directory", "./.github/workflows/directory.yml"],
  ["symlink outside workflows", "./.github/workflows/link.yml"],
]) {
  test(`a job-level local reusable workflow reports its ${form}`, async () => {
    const root = fixtureLines([]);
    writeFileSync(join(root, ".github/workflows/ci.yml"), `jobs:\n  check:\n    uses: ${value}\n`);
    mkdirSync(join(root, ".github/workflows/directory.yml"));
    mkdirSync(join(root, "tools"));
    writeFileSync(join(root, "tools/build.yml"), workflow(["- run: echo fixture"]));
    symlinkSync(join(root, "tools/build.yml"), join(root, ".github/workflows/link.yml"));
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`.github/workflows/ci.yml:3: ${value}:`);
    expect(result.errors[0]).not.toContain(root);
  });
}

for (const pinnedFirst of [false, true]) {
  for (const kind of ["step", "job", "composite", "flow step", "quoted step", "escaped step"]) {
    test(`repeated uses source is refused in a ${kind} with the pin ${pinnedFirst ? "first" : "last"}`, async () => {
      const values = [`oven-sh/setup-bun@${RIGHT} # v2.2.0`, "evil/repo@main"];
      if (!pinnedFirst) values.reverse();
      const root = fixtureLines([]);
      let source: string;
      if (kind === "job")
        source = `jobs:\n  check:\n    uses: ${values[0]}\n    uses: ${values[1]}\n`;
      else if (kind === "flow step")
        source = workflow([
          `- { uses: ${values[0].split(" #")[0]}, uses: ${values[1].split(" #")[0]} }`,
        ]);
      else {
        const key =
          kind === "quoted step" ? '"uses"' : kind === "escaped step" ? '"\\u0075ses"' : "uses";
        const lines = [`- ${key}: ${values[0]}`, `  uses: ${values[1]}`];
        source = kind === "composite" ? composite(lines) : workflow(lines);
      }
      const file =
        kind === "composite" ? ".github/actions/local/action.yml" : ".github/workflows/ci.yml";
      mkdirSync(join(root, ".github/actions/local"), { recursive: true });
      writeFileSync(join(root, file), source);
      const result = await checkActionPins({ root, resolver: resolver() });
      if (["flow step", "quoted step", "escaped step"].includes(kind)) {
        expect(result.errors.join("\n")).toContain(
          `${kind === "flow step" ? "flow mapping" : "quoted key"} is outside the YAML subset`,
        );
      } else {
        expect(result.errors.join("\n")).toContain(`${file}: duplicate uses keys are refused`);
        expect(result.errors.join("\n")).toContain("one `uses` per step");
      }
    });
  }
}

test("repeated uses text in run strings and comments is ignored", async () => {
  const root = fixtureLines([
    "- run: |",
    "    uses: evil/repo@main",
    "    uses: other/repo@main",
    '- run: "uses: uses: literal"',
    "# uses: uses:",
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

test("multiple YAML documents report the unsupported-document error", async () => {
  const root = fixtureLines([]);
  writeFileSync(join(root, ".github/workflows/ci.yml"), "name: Fixture\n---\nname: Other\n");
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    ".github/workflows/ci.yml: line 2: document marker is outside the YAML subset; write a single YAML document",
  ]);
});

test("uses text in a run block is ignored", async () => {
  const root = fixtureLines([
    "- run: |",
    "    uses: actions/checkout@main",
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

test("a flow step is refused despite matching uses text in a run block", async () => {
  const root = fixtureLines([
    `- { uses: oven-sh/setup-bun@${RIGHT} }`,
    "- run: |",
    `    uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
  ]);
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\n")).toContain("flow mapping is outside the YAML subset");
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

for (const [name, source, key, lines] of [
  [
    "a duplicated top-level jobs key",
    "name: Fixture\non: push\njobs:\n  one:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo one\njobs:\n  two:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo two\n",
    "jobs",
    "3 and 8",
  ],
  [
    "a duplicated steps key in one job",
    "name: Fixture\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo one\n    steps:\n      - run: echo two\n",
    "steps",
    "6 and 8",
  ],
  [
    "a duplicated arbitrary key",
    "name: Fixture\nname: Fixture again\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo one\n",
    "name",
    "1 and 2",
  ],
] as const) {
  test(`${name} is refused with its key and both lines`, async () => {
    const root = fixtureLines([]);
    writeFileSync(join(root, ".github/workflows/ci.yml"), source);
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.errors.join("\n")).toContain(
      `.github/workflows/ci.yml: duplicate mapping key "${key}" is refused at lines ${lines}`,
    );
  });
}

test("a duplicate key in a flow mapping is refused", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    "jobs: { check: { runs-on: ubuntu-latest, runs-on: ubuntu-latest, steps: [{ run: echo }] } }\n",
  );
  const result = await checkActionPins({ root, resolver: resolver() });
  expect(result.errors.join("\n")).toContain(
    ".github/workflows/ci.yml: line 1: flow mapping is outside the YAML subset; write a block mapping",
  );
});

test("sibling mappings may share the same child keys", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    [
      "name: Fixture",
      "on: push",
      "jobs:",
      "  one:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      "  two:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo two",
      "",
    ].join("\n"),
  );
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

test("keys in a run block scalar are not mapping keys", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    [
      "name: Fixture",
      "on: push",
      "jobs:",
      "  check:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          jobs:",
      "            steps:",
      "          uses: evil/repo@main",
      `      - uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      "",
    ].join("\n"),
  );
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

function repositoryResolver(root: string) {
  const pins = new Map<string, string>();
  const stack = [join(root, ".github/workflows"), join(root, ".github/actions")];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!/\.ya?ml$/.test(entry.name)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const match = line.match(
          /^\s*(?:-\s+)?uses:\s*["']?([\w.-]+\/[\w.-]+)(?:\/[^\s@#"']+)?@([a-f\d]{40})["']?\s+#\s*(\S+)\s*$/i,
        );
        if (match) pins.set(`${match[1]}\u0000${match[3]}`, match[2]);
      }
    }
  }
  return {
    resolveTag: async (owner: string, repo: string, tag: string) => {
      const sha = pins.get(`${owner}/${repo}\u0000${tag}`);
      if (!sha) throw new Error(`no fixture pin for ${owner}/${repo}@${tag}`);
      return sha;
    },
    findTagForSha: async (owner: string, repo: string, sha: string) => {
      for (const [key, value] of pins) {
        if (key.startsWith(`${owner}/${repo}\u0000`) && value.toLowerCase() === sha.toLowerCase())
          return key.split("\u0000")[1];
      }
      return null;
    },
  };
}

test("the real workflow and action tree passes with a source-derived tag resolver", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = await checkActionPins({ root, resolver: repositoryResolver(root) });
  expect(result.errors).toEqual([]);
  expect(result.checked).toBeGreaterThan(0);
});

test("indentless workflow steps retain pin checking", async () => {
  const root = fixtureLines([]);
  const file = join(root, ".github/workflows/ci.yml");
  for (const ref of [`oven-sh/setup-bun@${RIGHT} # v2.2.0`, "oven-sh/setup-bun@main"]) {
    const text = workflow([`- uses: ${ref}`])
      .replace("  check:", "  build:")
      .replace("      - uses:", "    - uses:");
    writeFileSync(file, text);
    const parsed = Bun.YAML.parse(text) as { jobs: { build: { steps: unknown } } };
    expect(Array.isArray(parsed.jobs.build.steps)).toBe(true);
    const result = await checkActionPins({ root, resolver: resolver() });
    if (ref.endsWith("@main")) {
      expect(result.checked).toBe(1);
      expect(result.errors).toEqual([
        ".github/workflows/ci.yml:7: oven-sh/setup-bun@main: not pinned to a full 40-character commit SHA",
      ]);
    } else expect(result).toEqual({ checked: 1, errors: [] });
  }
});

test("a duplicate sibling after indentless steps retains both key lines", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`])
      .replace("      - uses:", "    - uses:")
      .concat("    runs-on: windows-latest\n"),
  );
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    '.github/workflows/ci.yml: duplicate mapping key "runs-on" is refused at lines 5 and 8; write one "runs-on" per mapping',
  ]);
});

test("duplicate uses inside indentless steps are refused across child blocks", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    workflow([
      `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      "  with:",
      "    child: value",
      "  uses: evil/repo@main",
    ]).replace(/^      /gm, "    "),
  );
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    ".github/workflows/ci.yml: duplicate uses keys are refused at lines 7 and 10; write one `uses` per step (or job)",
  ]);
});

test("a comment line between indentless steps does not end the sequence", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    workflow([
      `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      "# between steps",
      `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
    ]).replace(/^      /gm, "    "),
  );
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 2, errors: [] });
});

test("a blank line between indentless steps does not end the sequence", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    workflow([
      `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      "",
      `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
    ]).replace(/^      /gm, "    "),
  );
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 2, errors: [] });
});

test("an unpinned uses after a comment or blank line between indentless steps is still refused", async () => {
  for (const separator of ["# between steps", ""]) {
    const root = fixtureLines([]);
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      workflow([
        `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
        separator,
        "- uses: oven-sh/setup-bun@main",
      ]).replace(/^      /gm, "    "),
    );
    expect(await checkActionPins({ root, resolver: resolver() })).toEqual({
      checked: 2,
      errors: [
        ".github/workflows/ci.yml:9: oven-sh/setup-bun@main: not pinned to a full 40-character commit SHA",
      ],
    });
  }
});

test("a duplicate key after a comment or blank line following indentless steps keeps both lines", async () => {
  for (const separator of ["# between the sequence and the key", ""]) {
    const root = fixtureLines([]);
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`])
        .replace("      - uses:", "    - uses:")
        .concat(`    ${separator}\n`, "    runs-on: windows-latest\n"),
    );
    expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
      '.github/workflows/ci.yml: duplicate mapping key "runs-on" is refused at lines 5 and 9; write one "runs-on" per mapping',
    ]);
  }
});

for (const [label, separator] of [
  ["comment", "# before the document start marker"],
  ["blank", ""],
] as const) {
  test(`a ${label} line before a document start marker is admitted`, async () => {
    const root = fixtureLines([]);
    const file = join(root, ".github/workflows/ci.yml");
    writeFileSync(
      file,
      `${separator}\n---\n${workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`])}`,
    );
    const text = readFileSync(file, "utf8");
    const parsed = Bun.YAML.parse(text) as { jobs: { check: { steps: unknown } } };
    expect(Array.isArray(parsed.jobs.check.steps)).toBe(true);
    expect(await checkActionPins({ root, resolver: resolver() })).toEqual({
      checked: 1,
      errors: [],
    });
  });
}

for (const [label, separator] of [
  ["comment", "# after the document end marker"],
  ["blank", ""],
] as const) {
  test(`a ${label} line after a document end marker is admitted`, async () => {
    const root = fixtureLines([]);
    const file = join(root, ".github/workflows/ci.yml");
    writeFileSync(
      file,
      `${workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`])}...\n${separator}\n`,
    );
    const text = readFileSync(file, "utf8");
    const parsed = Bun.YAML.parse(text) as { jobs: { check: { steps: unknown } } };
    expect(Array.isArray(parsed.jobs.check.steps)).toBe(true);
    expect(await checkActionPins({ root, resolver: resolver() })).toEqual({
      checked: 1,
      errors: [],
    });
  });
}

test("content after a document end marker is refused at its line", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    `${workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`])}...\nname: Other\n`,
  );
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    ".github/workflows/ci.yml: line 9: content after document end is outside the YAML subset; write a single YAML document",
  ]);
});

test("a comment after a document end marker does not hide the following content", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    `${workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`])}...\n# between documents\nname: Other\n`,
  );
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    ".github/workflows/ci.yml: line 10: content after document end is outside the YAML subset; write a single YAML document",
  ]);
});

test("content after a document end marker that the first document lacks is refused at its line", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    `${workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`])}...\nother: value\n`,
  );
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    ".github/workflows/ci.yml: line 9: content after document end is outside the YAML subset; write a single YAML document",
  ]);
});

test("a root sequence is refused by the parsed-document check", async () => {
  const root = fixtureLines([]);
  writeFileSync(join(root, ".github/workflows/ci.yml"), "- a\n- b\n");
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    ".github/workflows/ci.yml: multiple YAML documents are not supported",
  ]);
});

// Bun.YAML parses a dash followed by a comment, with no indented content, as a
// null sequence item, so the scanner refuses that null at the shape check.
test("a dash followed by a comment between indentless steps is a null step", async () => {
  const root = fixtureLines([]);
  const file = join(root, ".github/workflows/ci.yml");
  writeFileSync(
    file,
    workflow([
      `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      "- # placeholder",
      `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
    ]).replace(/^      /gm, "    "),
  );
  const text = readFileSync(file, "utf8");
  const parsed = Bun.YAML.parse(text) as { jobs: { check: { steps: unknown[] } } };
  expect(parsed.jobs.check.steps).toHaveLength(3);
  expect(parsed.jobs.check.steps[1]).toBeNull();
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({
    checked: 0,
    errors: [".github/workflows/ci.yml: jobs.check.steps.1 must be a mapping"],
  });
});

test("a dash followed by a comment above an indented step mapping is admitted", async () => {
  const root = fixtureLines([]);
  const file = join(root, ".github/workflows/ci.yml");
  const step = `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`;
  writeFileSync(
    file,
    workflow([
      step,
      "- # placeholder",
      `  uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      step,
    ]).replace(/^      /gm, "    "),
  );
  const text = readFileSync(file, "utf8");
  const parsed = Bun.YAML.parse(text) as { jobs: { check: { steps: unknown[] } } };
  expect(parsed.jobs.check.steps).toHaveLength(3);
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({
    checked: 3,
    errors: [],
  });
});

test("indentless steps scan nested mappings and block scalars before sibling keys", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    workflow([
      "- run: |",
      "    uses: literal",
      "    uses: literal",
      `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      "  with:",
      "    child:",
      "    - one",
      "    - two",
      "    sibling: value",
      "- run: echo done",
    ])
      .replace(/^      /gm, "    ")
      .concat("    timeout-minutes: 10\n"),
  );
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

test("a document sequence after a scalar is refused", async () => {
  const root = fixtureLines([]);
  const text = "scalar\n- item\n";
  writeFileSync(join(root, ".github/workflows/ci.yml"), text);
  expect(() => refuseDuplicateKeys(text)).toThrow("line 2: block indentation");
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    ".github/workflows/ci.yml: line 2: block indentation is outside the YAML subset; indent child collections beneath their parent key",
  ]);
});

test("the real workflow and action tree passes with indentless mapping-value sequences", async () => {
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = fixtureLines([]);
  const stack = [".github/workflows", ".github/actions"];
  while (stack.length) {
    const directory = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(sourceRoot, directory), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    mkdirSync(join(root, directory), { recursive: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else {
        const text = readFileSync(join(sourceRoot, path), "utf8");
        let stepsIndent: number | undefined;
        const indentless = text.split("\n").map((line) => {
          const indent = line.match(/^ */)?.[0].length ?? 0;
          if (line.trim() && stepsIndent !== undefined && indent <= stepsIndent)
            stepsIndent = undefined;
          if (/^ +steps:\s*$/.test(line)) stepsIndent = indent;
          else if (stepsIndent !== undefined && indent > stepsIndent) return line.slice(2);
          return line;
        });
        writeFileSync(join(root, path), indentless.join("\n"));
      }
    }
  }
  const original = await checkActionPins({
    root: sourceRoot,
    resolver: repositoryResolver(sourceRoot),
  });
  expect(original.errors).toEqual([]);
  expect(original.checked).toBeGreaterThan(0);
  expect(await checkActionPins({ root, resolver: repositoryResolver(root) })).toEqual(original);
});

for (const [name, character] of [
  ["CR", "\r"],
  ["LS", "\u2028"],
  ["PS", "\u2029"],
  ["NEL", "\u0085"],
  ["VT", "\u000b"],
  ["FF", "\u000c"],
]) {
  test(`scanner break refusal matches Bun.YAML for ${name}`, () => {
    const text = `# c${character}hidden:${character}  x: 1\nvisible: 2\n`;
    const parsed = Bun.YAML.parse(text) as Record<string, unknown>;
    let refused = false;
    try {
      refuseDuplicateKeys(text);
    } catch {
      refused = true;
    }
    expect(refused).toBe(Object.hasOwn(parsed, "hidden"));
  });
}

for (const [name, source, line, construct, remedy] of [
  ["quoted flow key", 'env: {"A": one, A: two}', 1, "flow mapping", "write a block mapping"],
  ["empty flow mapping", "env: {}", 1, "flow mapping", "write a block mapping"],
  ["quoted block key", '"jobs": ignored', 1, "quoted key", "write an unquoted key"],
  ["hex escaped key", '"\\x6aobs": ignored', 1, "quoted key", "write an unquoted key"],
  [
    "long unicode escaped key",
    '"\\U0000006aobs": ignored',
    1,
    "quoted key",
    "write an unquoted key",
  ],
  ["explicit key", "? jobs\n: ignored", 1, "explicit ? key", "write an unquoted key"],
  [
    "multiline double quote",
    'name: "first\n  jobs: hidden"',
    1,
    "multiline quoted scalar",
    "use a | or > block scalar",
  ],
  [
    "multiline single quote",
    "name: 'first\n  jobs: hidden'",
    1,
    "multiline quoted scalar",
    "use a | or > block scalar",
  ],
  ["multiline flow", "on: [push,\n  pull_request]", 1, "multiline flow sequence", "in block style"],
  ["nested flow", "on: [[push]]", 1, "nested flow collection", "in block style"],
  [
    "implicit flow mapping",
    "on: [push: pull_request]",
    1,
    "mapping or nested collection",
    "write a block mapping",
  ],
  ["tag", "name: !!str value", 1, "tag", "remove the tag"],
  ["anchor without alias", "name: &name value", 1, "anchor or alias", "without anchors or aliases"],
  ["alias without anchor", "name: *name", 1, "anchor or alias", "without anchors or aliases"],
  ["merge key", "env:\n  <<: value", 2, "merge key", "write the mapping out in full"],
  ["tab indentation", "env:\n\tA: value", 2, "tab indentation", "indent with spaces"],
  ["directive", "%YAML 1.2", 1, "scalar indicator", "one-line scalar"],
  [
    "numeric key coercion",
    "env:\n  01: first\n  1: second",
    2,
    "key whose spelling Bun.YAML changes",
    "rename the key",
  ],
  [
    "boolean key coercion",
    "env:\n  True: first\n  true: second",
    2,
    "key whose spelling Bun.YAML changes",
    "rename the key",
  ],
  [
    "plain continuation",
    "name: first\n  second",
    2,
    "multiline scalar",
    "use a | or > block scalar",
  ],
] as const) {
  test(`${name} is refused with its source line and rewrite hint`, async () => {
    const root = fixtureLines([]);
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      `${source}\n${workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`])}`,
    );
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`.github/workflows/ci.yml: line ${line}: ${construct}`);
    expect(result.errors[0]).toContain("outside the YAML subset");
    expect(result.errors[0]).toContain(remedy);
  });
}

for (const flow of ["[push]", "[push, pull_request]", "[]"]) {
  test(`a flow trigger ${flow} does not hide duplicate jobs behind a visible pin`, async () => {
    const root = fixtureLines([]);
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      [
        `on: ${flow}`,
        "jobs:",
        "  hidden:",
        "    steps:",
        "      - uses: evil/repo@main",
        "jobs:",
        "  visible:",
        "    steps:",
        `      - uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      ].join("\n"),
    );
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.errors).toEqual([
      '.github/workflows/ci.yml: duplicate mapping key "jobs" is refused at lines 2 and 6; write one "jobs" per mapping',
    ]);
  });
}

for (const indicator of ["|", "|-", "|+", "|2", "|2-", "|-2", ">", ">+2"]) {
  test(`a ${indicator} run block after a flow trigger accepts shell braces and key text`, async () => {
    const root = fixtureLines([]);
    writeFileSync(
      join(root, ".github/workflows/ci.yml"),
      workflow([
        `- run: ${indicator}`,
        "    echo {a: b}",
        "    jobs: steps:",
        `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
      ]).replace("on: push", "on: [push]"),
    );
    expect(await checkActionPins({ root, resolver: resolver() })).toEqual({
      checked: 1,
      errors: [],
    });
  });
}

test("one-line quoted scalar values and flat scalar sequences pass through Bun.YAML", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    [
      "---",
      "env:",
      '  A: "\\x41\\U00000042\\n\\""',
      "  B: 'it''s # {literal}'",
      "on: [push, \"pull_request\", 'workflow_dispatch'] # triggers",
      workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]).replace("on: push\n", ""),
      "...",
    ].join("\n"),
  );
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

test("duplicate keys inside a sequence-item mapping are refused across child blocks", async () => {
  const root = fixtureLines([
    `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
    "  with:",
    "    child: value",
    "  name: first",
    "  name: second",
  ]);
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    '.github/workflows/ci.yml: duplicate mapping key "name" is refused at lines 10 and 11; write one "name" per mapping',
  ]);
});

test("a duplicate jobs block appended to the real CI workflow is refused", async () => {
  const root = fixtureLines([]);
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const lines = ci.split("\n");
  const first = lines.indexOf("jobs:") + 1;
  const second = lines.length + 1;
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    `${ci}\njobs:\n  hidden:\n    steps:\n      - uses: evil/repo@main\n`,
  );
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    `.github/workflows/ci.yml: duplicate mapping key "jobs" is refused at lines ${first} and ${second}; write one "jobs" per mapping`,
  ]);
});

test("a followed action refuses duplicate metadata keys", async () => {
  const root = fixtureLines(["- uses: ./tools/local"]);
  writeAction(root, "tools/local", [`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]);
  const file = join(root, "tools/local/action.yml");
  writeFileSync(file, `description: first\n${readFileSync(file, "utf8")}`);
  expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
    'tools/local/action.yml: duplicate mapping key "description" is refused at lines 1 and 3; write one "description" per mapping',
  ]);
});

test("a block scalar sequence item ends before the next item", async () => {
  const root = fixtureLines([]);
  writeFileSync(
    join(root, ".github/workflows/ci.yml"),
    `env:\n  list:\n    - |\n      jobs: literal\n    - >-\n      steps: literal\n${workflow([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`])}`,
  );
  expect(await checkActionPins({ root, resolver: resolver() })).toEqual({ checked: 1, errors: [] });
});

for (const metadata of [false, true]) {
  test(`bare CR hiding a mapping in ${metadata ? "followed action metadata" : "a workflow"} is refused`, async () => {
    const root = fixtureLines([
      metadata ? "- uses: ./tools/local" : `- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`,
    ]);
    if (metadata) {
      writeAction(root, "tools/local", [`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]);
    }
    const path = metadata ? "tools/local/action.yml" : ".github/workflows/ci.yml";
    const file = join(root, path);
    const prefix = metadata
      ? "# comment\rruns:\r  using: composite\r  steps:\r    - uses: evil/repo@main\r\n"
      : "# comment\rjobs:\r  hidden:\r    steps:\r      - uses: evil/repo@main\r\n";
    const text = prefix + readFileSync(file, "utf8");
    writeFileSync(file, text);
    const parsed = Bun.YAML.parse(text) as { jobs?: unknown; runs?: unknown };
    expect(metadata ? parsed.runs : parsed.jobs).toBeDefined();
    expect(JSON.stringify(parsed)).not.toContain("evil/repo@main");
    expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
      `${path}: line 1: bare CR is outside the YAML subset; convert to LF`,
    ]);
  });
}

for (const prefix of ["# comment\r\n# second\rhidden", "name: |2\n  text\rhidden"]) {
  test(`bare CR on a skipped line ${JSON.stringify(prefix)} is refused`, async () => {
    const root = fixtureLines([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]);
    const file = join(root, ".github/workflows/ci.yml");
    writeFileSync(file, `${prefix}\n${readFileSync(file, "utf8")}`);
    expect((await checkActionPins({ root, resolver: resolver() })).errors).toEqual([
      ".github/workflows/ci.yml: line 2: bare CR is outside the YAML subset; convert to LF",
    ]);
  });
}

test("CRLF workflow and action metadata pass subset admission", () => {
  const root = fixtureLines(["- uses: ./tools/local"]);
  writeAction(root, "tools/local", [`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]);
  for (const path of [".github/workflows/ci.yml", "tools/local/action.yml"]) {
    const file = join(root, path);
    const text = readFileSync(file, "utf8").replaceAll("\n", "\r\n");
    writeFileSync(file, text);
    expect(() => refuseDuplicateKeys(readFileSync(file, "utf8"))).not.toThrow();
  }
});

for (const indicator of ["|", "|2", ">", ">2"]) {
  test(`a content tab after ${indicator} block indentation passes`, async () => {
    const root = fixtureLines([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]);
    const file = join(root, ".github/workflows/ci.yml");
    const text = readFileSync(file, "utf8").replace(
      "name: Fixture\n",
      `name: ${indicator}\n  \techo hello\n`,
    );
    writeFileSync(file, text);
    expect((Bun.YAML.parse(text) as { name: string }).name).toBe("\techo hello\n");
    expect(await checkActionPins({ root, resolver: resolver() })).toEqual({
      checked: 1,
      errors: [],
    });
  });
}

for (const source of ["name: |2\n\techo hello", "name: |2\n \techo hello"]) {
  test(`a tab inside required block indentation ${JSON.stringify(source)} is refused`, async () => {
    const root = fixtureLines([`- uses: oven-sh/setup-bun@${RIGHT} # v2.2.0`]);
    const file = join(root, ".github/workflows/ci.yml");
    const text = readFileSync(file, "utf8").replace("name: Fixture", source);
    writeFileSync(file, text);
    expect(() => Bun.YAML.parse(text)).toThrow();
    const result = await checkActionPins({ root, resolver: resolver() });
    expect(result.checked).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(".github/workflows/ci.yml:");
  });
}
