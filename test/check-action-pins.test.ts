import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkActionPins, createGithubResolver } from "../scripts/check-action-pins.mjs";

const WRONG = "de0fac2e4500dabe0009e67214ff5f5447ce83dd";
const RIGHT = "0c5077e51419868618aeaa5fe8019c62421857d6";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(line: string, composite = false): string {
  const root = mkdtempSync(join(tmpdir(), "bob-action-pins-"));
  roots.push(root);
  const dir = join(root, composite ? ".github/actions/local" : ".github/workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, composite ? "action.yml" : "ci.yml"), `${line}\n`);
  if (composite) mkdirSync(join(root, ".github/workflows"), { recursive: true });
  return root;
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
