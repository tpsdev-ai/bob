import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLockfileReleaseAge, parseBunLock } from "../scripts/check-lockfile-release-age.mjs";

const NOW = Date.UTC(2026, 10, 2, 0, 0, 0);
const BAKE_SECONDS = 7 * 24 * 60 * 60;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lockText(packages) {
  const body = Object.entries(packages)
    .map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n");
  return `{\n  "lockfileVersion": 1,\n  "packages": {\n${body}\n  },\n}\n`;
}

function bunfigText(excludes) {
  const lines = ["[install]", `minimumReleaseAge = ${BAKE_SECONDS}`];
  if (excludes !== undefined) {
    lines.push(`minimumReleaseAgeExcludes = ${JSON.stringify(excludes)}`);
  }
  return `${lines.join("\n")}\n`;
}

function fixture(lock, excludes) {
  const root = mkdtempSync(join(tmpdir(), "bob-lockfile-age-"));
  roots.push(root);
  writeFileSync(join(root, "bunfig.toml"), bunfigText(excludes));
  writeFileSync(join(root, "bun.lock"), lock);
  return root;
}

function stubFetch(timesByName, calls = []) {
  return async (url) => {
    calls.push(url);
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    return {
      ok: true,
      status: 200,
      async json() {
        return { time: timesByName[name] ?? {} };
      },
    };
  };
}

test("a too-young checked registry version fails naming it", async () => {
  const root = fixture(
    lockText({ "fresh-pkg": ["fresh-pkg@1.2.3", "", {}, "sha512-fresh"] }),
    undefined,
  );
  const fetchImpl = stubFetch({
    "fresh-pkg": { "1.2.3": new Date(NOW - 3_600_000).toISOString() },
  });

  const result = await checkLockfileReleaseAge({ root, fetchImpl, now: NOW });

  expect(result.ok).toBe(false);
  expect(result.checked).toBe(1);
  expect(result.tooYoung).toHaveLength(1);
  expect(result.tooYoung[0].name).toBe("fresh-pkg");
  expect(result.tooYoung[0].version).toBe("1.2.3");
  expect(result.lookupFailures).toHaveLength(0);
}, 5000);

test("a package listed in minimumReleaseAgeExcludes passes", async () => {
  const root = fixture(
    lockText({
      "fresh-pkg": ["fresh-pkg@1.2.3", "", {}, "sha512-fresh"],
      "old-pkg": ["old-pkg@2.0.0", "", {}, "sha512-old"],
    }),
    ["fresh-pkg"],
  );
  const fetchImpl = stubFetch({
    "fresh-pkg": { "1.2.3": new Date(NOW - 3_600_000).toISOString() },
    "old-pkg": { "2.0.0": new Date(NOW - 30 * 86_400_000).toISOString() },
  });

  const result = await checkLockfileReleaseAge({ root, fetchImpl, now: NOW });

  expect(result.ok).toBe(true);
  expect(result.checked).toBe(1);
  expect(result.excluded.map((entry) => entry.name)).toEqual(["fresh-pkg"]);
  expect(result.tooYoung).toHaveLength(0);
}, 5000);

test("an unreachable registry fails", async () => {
  const root = fixture(
    lockText({ "fresh-pkg": ["fresh-pkg@1.2.3", "", {}, "sha512-fresh"] }),
    undefined,
  );
  const fetchImpl = async () => {
    throw new Error("connect ECONNREFUSED");
  };

  const result = await checkLockfileReleaseAge({ root, fetchImpl, now: NOW });

  expect(result.ok).toBe(false);
  expect(result.lookupFailures).toHaveLength(1);
  expect(result.lookupFailures[0].name).toBe("fresh-pkg");
  expect(result.lookupFailures[0].version).toBe("1.2.3");
  expect(result.lookupFailures[0].error).toContain("ECONNREFUSED");
}, 5000);

test("a version missing from the registry time map fails", async () => {
  const root = fixture(
    lockText({ "fresh-pkg": ["fresh-pkg@1.2.3", "", {}, "sha512-fresh"] }),
    undefined,
  );
  const fetchImpl = stubFetch({});

  const result = await checkLockfileReleaseAge({ root, fetchImpl, now: NOW });

  expect(result.ok).toBe(false);
  expect(result.lookupFailures).toHaveLength(1);
  expect(result.lookupFailures[0].error).toContain("no publish time for fresh-pkg@1.2.3");
}, 5000);

test("an empty lockfile fails", async () => {
  const root = fixture(lockText({}), undefined);

  await expect(
    checkLockfileReleaseAge({ root, fetchImpl: stubFetch({}), now: NOW }),
  ).rejects.toThrow(/no packages/);
}, 5000);

test("a garbled lockfile fails", async () => {
  const root = fixture("this is not a lockfile\n", undefined);

  await expect(
    checkLockfileReleaseAge({ root, fetchImpl: stubFetch({}), now: NOW }),
  ).rejects.toThrow(/not parsable/);
}, 5000);

test.each([
  ['{"packages":{"x":["x@1.0.0"]}}/*', "unterminated block comment"],
  ['{"packages":{"x":["x@1.0.0"],/*', "unterminated block comment"],
  ['{"packages":{"x":["x@1.0.0"]}}"', "unterminated string"],
  ['{"packages":{"x":["x@1.0.0', "unterminated string"],
  ['{"packages":{"x":["x@1.0.0\\"', "unterminated string"],
])("parseBunLock rejects %s (%s)", (text, reason) => {
  expect(() => parseBunLock(text)).toThrow(`bun.lock is not parsable: ${reason}`);
});

test("scoped package names are URL-encoded with a literal @ and %2f", async () => {
  const root = fixture(
    lockText({ "@scope/pkg": ["@scope/pkg@1.2.3", "", {}, "sha512-scoped"] }),
    undefined,
  );
  const calls = [];
  const fetchImpl = stubFetch(
    { "@scope/pkg": { "1.2.3": new Date(NOW - 30 * 86_400_000).toISOString() } },
    calls,
  );

  const result = await checkLockfileReleaseAge({ root, fetchImpl, now: NOW });

  expect(result.ok).toBe(true);
  expect(calls).toContain("https://registry.npmjs.org/@scope%2fpkg");
}, 5000);

const malformedExcludes = [
  [
    "a non-array value before a later array",
    '"fresh-pkg"\nother = ["fresh-pkg"]',
    "must be an array of strings",
  ],
  ["an array with a non-string", '["fresh-pkg", 1]', "must be an array of strings"],
  [
    "an unterminated array before a later array",
    '["fresh-pkg",\nother = ["fresh-pkg"]',
    "must be an array of strings",
  ],
  [
    "an omitted value before a later array",
    '\nother = ["fresh-pkg"]',
    "must be an array of strings",
  ],
  ["a missing comma", '["fresh-pkg" "other"]', "expected , or ]"],
  ["a repeated comma", '["fresh-pkg",,]', "must be an array of strings"],
  ["text after the array", '["fresh-pkg"] false', "has unexpected text after ]"],
  ["an unclosed array", '["fresh-pkg",', "has no closing ]"],
];

test.each(malformedExcludes)(
  "minimumReleaseAgeExcludes refuses %s",
  async (_label, value, problem) => {
    const root = fixture(lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"] }), undefined);
    writeFileSync(
      join(root, "bunfig.toml"),
      `${bunfigText(undefined)}minimumReleaseAgeExcludes = ${value}\n`,
    );
    await expect(
      checkLockfileReleaseAge({ root, fetchImpl: stubFetch({}), now: NOW }),
    ).rejects.toThrow(`bunfig.toml minimumReleaseAgeExcludes ${problem}`);

    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts", "check-lockfile-release-age.mjs");
    copyFileSync(new URL("../scripts/check-lockfile-release-age.mjs", import.meta.url), script);
    const cli = spawnSync("node", [realpathSync(script)], { encoding: "utf8" });
    expect(cli.error).toBeUndefined();
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain(`bunfig.toml minimumReleaseAgeExcludes ${problem}`);
  },
);

test("omitted minimumReleaseAgeExcludes is an empty list", async () => {
  const root = fixture(lockText({ "old-pkg": ["old-pkg@2.0.0"] }), undefined);
  const result = await checkLockfileReleaseAge({
    root,
    fetchImpl: stubFetch({ "old-pkg": { "2.0.0": new Date(NOW - 30 * 86_400_000).toISOString() } }),
    now: NOW,
  });
  expect(result.excludes).toEqual([]);
  expect(result.excluded).toEqual([]);
  expect(result.checked).toBe(1);
  expect(result.ok).toBe(true);
});

test("minimumReleaseAgeExcludes accepts a multiline string array with a trailing comma", async () => {
  const root = fixture(lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"] }), undefined);
  writeFileSync(
    join(root, "bunfig.toml"),
    `${bunfigText(undefined)}minimumReleaseAgeExcludes = [\n  'fresh-pkg', # reason\n]\nother = []\n`,
  );
  const result = await checkLockfileReleaseAge({ root, fetchImpl: stubFetch({}), now: NOW });
  expect(result.excludes).toEqual(["fresh-pkg"]);
  expect(result.checked).toBe(0);
  expect(result.ok).toBe(true);
});
