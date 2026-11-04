import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLockfileReleaseAge,
  parseBunLock,
  readBunfigPolicy,
} from "../scripts/check-lockfile-release-age.mjs";

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
  expect(result.checked).toBe(1);
  expect(result.skipped).toEqual([]);
  expect(calls).toContain("https://registry.npmjs.org/@scope%2fpkg");
}, 5000);

test.each([
  ["git-pkg", "git+ssh://git@host/repo.git#commit"],
  ["tarball-pkg", "https://host/tarball-pkg-1.2.3.tgz"],
  ["tarball-pkg", "http://host/tarball-pkg-1.2.3.tgz"],
])("skips %s resolved from %s", async (name, version) => {
  const root = fixture(lockText({ [name]: [`${name}@${version}`] }), undefined);
  const calls = [];
  const result = await checkLockfileReleaseAge({
    root,
    fetchImpl: stubFetch({}, calls),
    now: NOW,
  });

  expect(result.skipped).toEqual([{ key: name, name, version }]);
  expect(result.checked).toBe(0);
  expect(result.ok).toBe(true);
  expect(calls).toEqual([]);
});

function cliScript(root) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  const script = join(root, "scripts", "check-lockfile-release-age.mjs");
  copyFileSync(new URL("../scripts/check-lockfile-release-age.mjs", import.meta.url), script);
  return realpathSync(script);
}

function runCli(root, published = new Date(NOW - 30 * 86_400_000).toISOString()) {
  const preload = join(root, "fetch.mjs");
  writeFileSync(
    preload,
    'globalThis.fetch = async () => ({ok: true, status: 200, json: async () => ({time: {"1.2.3": process.env.BOB_TEST_PUBLISHED, "2.0.0": process.env.BOB_TEST_PUBLISHED}})});',
  );
  const cli = spawnSync(process.execPath, ["--no-install", "--preload", preload, cliScript(root)], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, BOB_TEST_PUBLISHED: published },
  });
  expect(cli.error).toBeUndefined();
  return cli;
}

test.each([
  ['"fresh-pkg"\nother = ["fresh-pkg"]', "install.minimumReleaseAgeExcludes"],
  ['["fresh-pkg", 1]', "install.minimumReleaseAgeExcludes"],
  ['["fresh-pkg", ""]', "install.minimumReleaseAgeExcludes"],
  ["false", "install.minimumReleaseAgeExcludes"],
  ["42", "install.minimumReleaseAgeExcludes"],
  ['{name = "fresh-pkg"}', "install.minimumReleaseAgeExcludes"],
  ['["fresh-pkg",\nother = ["fresh-pkg"]', "is not parsable"],
  ['\nother = ["fresh-pkg"]', "is not parsable"],
  ['["fresh-pkg" "other"]', "is not parsable"],
  ['["fresh-pkg",,]', "is not parsable"],
  ['["fresh-pkg"] false', "is not parsable"],
  ['["fresh-pkg",', "is not parsable"],
])("minimumReleaseAgeExcludes refuses %s", async (value, problem) => {
  const root = fixture(lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"] }), undefined);
  writeFileSync(
    join(root, "bunfig.toml"),
    `${bunfigText(undefined)}minimumReleaseAgeExcludes = ${value}\n`,
  );
  await expect(
    checkLockfileReleaseAge({ root, fetchImpl: stubFetch({}), now: NOW }),
  ).rejects.toThrow(`bunfig.toml ${problem}`);
  const cli = runCli(root);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain(`bunfig.toml ${problem}`);
});

test.each(['"604800"', "true", "-1", "1.5", "nan", "inf", "[]", "{}"])(
  "minimumReleaseAge refuses %s",
  (value) => {
    const root = fixture(lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"] }), undefined);
    writeFileSync(join(root, "bunfig.toml"), `[install]\nminimumReleaseAge = ${value}\n`);
    const cli = runCli(root);
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain("bunfig.toml install.minimumReleaseAge");
  },
);

test.each(["", "install = []\n", "install = false\n"])(
  "refuses an invalid install table: %s",
  (text) => {
    const root = fixture(lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"] }), undefined);
    writeFileSync(join(root, "bunfig.toml"), text);
    const cli = runCli(root);
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain("bunfig.toml install must be a table");
  },
);

test("refuses a missing minimumReleaseAge", () => {
  const root = fixture(lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"] }), undefined);
  writeFileSync(join(root, "bunfig.toml"), "[install]\n");
  const cli = runCli(root);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("bunfig.toml install.minimumReleaseAge");
});

test("Node CLI refuses to run without Bun.TOML.parse", () => {
  const root = fixture(lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"] }), undefined);
  rmSync(join(root, "bunfig.toml"));
  const cli = spawnSync("node", [cliScript(root)], { encoding: "utf8", timeout: 5000 });
  expect(cli.error).toBeUndefined();
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("BunTOMLUnavailable");
  expect(cli.stderr).toContain("bunfig.toml requires Bun.TOML.parse");
});

test.each(['"""', "'''"])("Bun TOML policy ignores decoys inside %s strings", (quote) => {
  const text = `[install]
notes = ${quote}
minimumReleaseAge = 0
minimumReleaseAgeExcludes = ["fresh-pkg"]
${quote}
minimumReleaseAge = ${BAKE_SECONDS}
minimumReleaseAgeExcludes = ["other-pkg"]
`;
  const parsed = Bun.TOML.parse(text).install;
  const root = fixture(
    lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"], "other-pkg": ["other-pkg@2.0.0"] }),
    undefined,
  );
  writeFileSync(join(root, "bunfig.toml"), text);
  const cli = runCli(root, new Date(Date.now() - 3_600_000).toISOString());
  expect(cli.status).toBe(1);
  expect(cli.stdout).toContain(`(${parsed.minimumReleaseAge}s)`);
  expect(cli.stdout).toContain(
    `Excluded by bunfig.toml minimumReleaseAgeExcludes (1): ${parsed.minimumReleaseAgeExcludes[0]}@2.0.0`,
  );
  expect(cli.stderr).toContain("fresh-pkg@1.2.3");
  expect(readBunfigPolicy(text)).toEqual({
    bakeSeconds: parsed.minimumReleaseAge,
    excludes: parsed.minimumReleaseAgeExcludes,
  });
});

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
  const cli = runCli(root);
  expect(cli.status).toBe(0);
  expect(cli.stdout).not.toContain("Excluded by");
});

test("minimumReleaseAgeExcludes accepts a multiline string array with a trailing comma", async () => {
  const root = fixture(lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"] }), undefined);
  writeFileSync(
    join(root, "bunfig.toml"),
    `${bunfigText(undefined)}minimumReleaseAgeExcludes = [\n  'fresh-pkg', # reason\n  """\nother-pkg""",\n]\nother = []\n`,
  );
  const result = await checkLockfileReleaseAge({ root, fetchImpl: stubFetch({}), now: NOW });
  expect(result.excludes).toEqual(["fresh-pkg", "other-pkg"]);
  expect(result.checked).toBe(0);
  expect(result.ok).toBe(true);
  const cli = runCli(root);
  expect(cli.status).toBe(0);
  expect(cli.stdout).toContain(
    "Excluded by bunfig.toml minimumReleaseAgeExcludes (1): fresh-pkg@1.2.3",
  );
});

test.each(["/*x*/", "/*x\ny*/", "//x\n", "//x\r", "//x\r\n"])(
  "lock comments keep tokens separate: %s",
  (comment) => {
    expect(() => parseBunLock(`{"packages":{"x":["x@1.0.0"]},"meta":1${comment}2}`)).toThrow(
      "bun.lock is not parsable",
    );
  },
);

test.each(["\n", "\r", "\r\n"])(
  "lock comments preserve strings and allow trailing commas: %s",
  (newline) => {
    expect(
      parseBunLock(
        `{"packages":{"x":["x@1.0.0",/* c */]},"meta":"/*not a comment*/",// c${newline}}`,
      ),
    ).toEqual({
      packages: { x: ["x@1.0.0"] },
      meta: "/*not a comment*/",
    });
  },
);
