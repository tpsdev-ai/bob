import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBunLock,
  readBunfigPolicy,
  retryAfterMs,
  checkLockfileReleaseAge as runReleaseAgeCheck,
} from "../scripts/check-lockfile-release-age.mjs";

const NOW = Date.UTC(2026, 10, 2, 0, 0, 0);
const BAKE_SECONDS = 7 * 24 * 60 * 60;
const roots: string[] = [];

function fixtureEnv(root) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: root,
    NPM_CONFIG_USERCONFIG: join(root, "absent.npmrc"),
  };
  for (const key of ["BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry"])
    delete env[key];
  return env;
}

function checkLockfileReleaseAge(options) {
  return runReleaseAgeCheck({ env: fixtureEnv(options.root), ...options });
}

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
  ["git-pkg", "git+https://host/repo.git#commit"],
  ["git-pkg", "git://host/repo.git#commit"],
  ["git-pkg", "github:owner/repo#commit"],
  ["tarball-pkg", "https://host/tarball-pkg-1.2.3.tgz"],
  ["tarball-pkg", "http://host/tarball-pkg-1.2.3.tgz"],
  ["odd-pkg", "1.2"],
  ["odd-pkg", "^1.2.3"],
])("refuses %s resolved from %s before any lookup", async (name, version) => {
  const root = fixture(
    lockText({
      [name]: [`${name}@${version}`],
      "old-pkg": ["old-pkg@2.0.0", "", {}, "sha512-old"],
    }),
    undefined,
  );
  const calls = [];
  const error = await checkLockfileReleaseAge({
    root,
    fetchImpl: stubFetch(
      { "old-pkg": { "2.0.0": new Date(NOW - 30 * 86_400_000).toISOString() } },
      calls,
    ),
    now: NOW,
  }).catch((thrown) => thrown);
  expect(error.name).toBe("NonRegistryDependency");
  expect(error.message).toContain(`packages[${JSON.stringify(name)}] resolves to version`);
  expect(calls).toEqual([]);
  const cli = runCli(root);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("NonRegistryDependency");
  expect(cli.stderr).toContain(`bun.lock packages[${JSON.stringify(name)}]`);
  expect(cli.stderr).toContain(version);
});

test.each([
  ["workspace-pkg", "workspace:*"],
  ["file-pkg", "file:../local"],
  ["link-pkg", "link:../local"],
])("skips local-source %s resolved from %s and reports it", async (name, version) => {
  const root = fixture(
    lockText({ [name]: [`${name}@${version}`], "old-pkg": ["old-pkg@2.0.0"] }),
    undefined,
  );
  const calls = [];
  const result = await checkLockfileReleaseAge({
    root,
    fetchImpl: stubFetch(
      { "old-pkg": { "2.0.0": new Date(NOW - 30 * 86_400_000).toISOString() } },
      calls,
    ),
    now: NOW,
  });

  expect(result.skipped).toEqual([{ key: name, name, version }]);
  expect(result.checked).toBe(1);
  expect(result.ok).toBe(true);
  expect(calls).toEqual(["https://registry.npmjs.org/old-pkg"]);
  const cli = runCli(root);
  expect(cli.status).toBe(0);
  expect(cli.stdout).toContain("Skipped local-source lock entries (1)");
  expect(cli.stdout).toContain(`${name}@${version}`);
});

function cliScript(root) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  const script = join(root, "scripts", "check-lockfile-release-age.mjs");
  copyFileSync(new URL("../scripts/check-lockfile-release-age.mjs", import.meta.url), script);
  return realpathSync(script);
}

function runCli(
  root,
  published = new Date(NOW - 30 * 86_400_000).toISOString(),
  env = {},
  args = [],
) {
  const preload = join(root, "fetch.mjs");
  writeFileSync(
    preload,
    'globalThis.fetch = async () => ({ok: true, status: 200, json: async () => ({time: {"1.2.3": process.env.BOB_TEST_PUBLISHED, "2.0.0": process.env.BOB_TEST_PUBLISHED}})});',
  );
  const cli = spawnSync(
    process.execPath,
    ["--no-install", "--preload", preload, cliScript(root), ...args],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { ...fixtureEnv(root), BOB_TEST_PUBLISHED: published, ...env },
    },
  );
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

test.each([0, 604799, 604801, 1209600])("refuses an unpinned minimumReleaseAge of %s", (value) => {
  const root = fixture(lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"] }), undefined);
  writeFileSync(join(root, "bunfig.toml"), `[install]\nminimumReleaseAge = ${value}\n`);
  const cli = runCli(root);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("UnpinnedReleaseAge");
  expect(cli.stderr).toContain(`must be 604800, found ${value}`);
});

test("accepts the pinned minimumReleaseAge of 604800", async () => {
  const root = fixture(lockText({ "old-pkg": ["old-pkg@2.0.0"] }), undefined);
  const result = await checkLockfileReleaseAge({
    root,
    fetchImpl: stubFetch({ "old-pkg": { "2.0.0": new Date(NOW - 30 * 86_400_000).toISOString() } }),
    now: NOW,
  });
  expect(result.bakeSeconds).toBe(604800);
  const cli = runCli(root);
  expect(cli.status).toBe(0);
  expect(cli.stdout).toContain(`(${604800}s)`);
});

test("an unreadable repo .npmrc refuses by name, with code and remedy", async () => {
  const root = fixture(lockText({ "old-pkg": ["old-pkg@2.0.0"] }), undefined);
  mkdirSync(join(root, ".npmrc"));
  const npmrc = join(root, ".npmrc");
  const error = await checkLockfileReleaseAge({
    root,
    fetchImpl: stubFetch({}),
    now: NOW,
  }).catch((thrown) => thrown);
  expect(error.name).toBe("UnreadableConfiguration");
  expect(error.message).toContain(npmrc);
  expect(error.message).toContain("EISDIR");
  const cli = runCli(root);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("UnreadableConfiguration");
  expect(cli.stderr).toContain(npmrc);
  expect(cli.stderr).toContain("EISDIR");
  expect(cli.stderr).toContain(
    "make it readable, or remove it if it holds no settings for this install",
  );
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
  const root = fixture(
    lockText({ "fresh-pkg": ["fresh-pkg@1.2.3"], "old-pkg": ["old-pkg@2.0.0"] }),
    undefined,
  );
  writeFileSync(
    join(root, "bunfig.toml"),
    `${bunfigText(undefined)}minimumReleaseAgeExcludes = [\n  'fresh-pkg', # reason\n  """\nother-pkg""",\n]\nother = []\n`,
  );
  const result = await checkLockfileReleaseAge({
    root,
    fetchImpl: stubFetch({ "old-pkg": { "2.0.0": new Date(NOW - 30 * 86_400_000).toISOString() } }),
    now: NOW,
  });
  expect(result.excludes).toEqual(["fresh-pkg", "other-pkg"]);
  expect(result.checked).toBe(1);
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

test.each([
  [{ "fresh-pkg": ["fresh-pkg@1.2.3"] }, ["fresh-pkg"]],
  [{ local: ["local@file:../local"] }, []],
  [{ "fresh-pkg": ["fresh-pkg@1.2.3"], local: ["local@workspace:*"] }, ["fresh-pkg"]],
])("an empty checked set exits 2: %j", async (packages, excludes) => {
  const root = fixture(lockText(packages), excludes);
  const cli = runCli(root);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("EmptyCheckedSet");
  const calls = [];
  await expect(checkLockfileReleaseAge({ root, fetchImpl: stubFetch({}, calls) })).rejects.toThrow(
    "no registry versions to check after exclusions",
  );
  expect(calls).toEqual([]);
});

const OTHER_REGISTRY = "https://packages.example.test/";
const NPM_REGISTRY = "https://registry.npmjs.org/";

function oldFixture() {
  return fixture(lockText({ "old-pkg": ["old-pkg@2.0.0"] }), undefined);
}

test.each([
  ["registry", "registry"],
  ["@scope:registry", "@scope:registry"],
])("repo .npmrc registry source %s exits 2", async (key, source) => {
  const root = oldFixture();
  writeFileSync(join(root, ".npmrc"), `save-exact=true\r${key}=${OTHER_REGISTRY}\r`);
  const calls = [];
  await expect(checkLockfileReleaseAge({ root, fetchImpl: stubFetch({}, calls) })).rejects.toThrow(
    `.npmrc ${source}`,
  );
  expect(calls).toEqual([]);
  const cli = runCli(root);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("UnsupportedRegistry");
  expect(cli.stderr).toContain(`.npmrc ${source}`);
});

test.each([
  [`registry = "${OTHER_REGISTRY}"`, "install.registry"],
  [`registry = { url = "${OTHER_REGISTRY}", token = "$TOKEN" }`, "install.registry"],
  [`[install.scopes]\nscope = "${OTHER_REGISTRY}"`, "install.scopes.scope"],
  [
    `[install.scopes]\nscope = { url = "${OTHER_REGISTRY}", token = "$TOKEN" }`,
    "install.scopes.scope",
  ],
])("bunfig registry source exits 2: %s", (setting, source) => {
  const root = oldFixture();
  writeFileSync(join(root, "bunfig.toml"), `${bunfigText(undefined)}${setting}\n`);
  const cli = runCli(root);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("UnsupportedRegistry");
  expect(cli.stderr).toContain(`bunfig.toml ${source}`);
});

test.each(["BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry"])(
  "environment registry source %s exits 2",
  (key) => {
    const root = oldFixture();
    const cli = runCli(root, undefined, { [key]: OTHER_REGISTRY });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain(`UnsupportedRegistry: ${key}`);
  },
);

test.each([".env.production.local", ".env.local", ".env.production", ".env"])(
  "install environment registry source %s exits 2",
  (file) => {
    const root = oldFixture();
    writeFileSync(join(root, file), `BUN_CONFIG_REGISTRY=${OTHER_REGISTRY}\n`);
    const cli = runCli(root, undefined, { BUN_ENV: "production" });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain(`UnsupportedRegistry: ${file} BUN_CONFIG_REGISTRY`);
  },
);

test.each([
  ["NPM_CONFIG_USERCONFIG", "selected.npmrc", `registry=${OTHER_REGISTRY}`],
  ["XDG_CONFIG_HOME", ".npmrc", `@scope:registry=${OTHER_REGISTRY}`],
  ["XDG_CONFIG_HOME", ".bunfig.toml", `[install]\nregistry = "${OTHER_REGISTRY}"`],
])("user registry source %s / %s exits 2", (key, file, text) => {
  const root = oldFixture();
  const configRoot = join(root, "user-config");
  mkdirSync(configRoot);
  const path = join(configRoot, file);
  writeFileSync(path, text);
  const env =
    key === "XDG_CONFIG_HOME"
      ? { XDG_CONFIG_HOME: configRoot, NPM_CONFIG_USERCONFIG: undefined }
      : { NPM_CONFIG_USERCONFIG: path };
  const cli = runCli(root, undefined, env);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("UnsupportedRegistry");
  expect(cli.stderr).toContain(path);
});

test("default registries in config files and environment proceed", () => {
  const root = oldFixture();
  writeFileSync(
    join(root, ".npmrc"),
    `registry="${NPM_REGISTRY}"\n@scope:registry=\${NPM_TEST_REGISTRY} # registry\n@empty:registry=\n`,
  );
  writeFileSync(
    join(root, "bunfig.toml"),
    `${bunfigText(undefined)}registry = { url = "${NPM_REGISTRY}" }\n[install.scopes]\nscope = "${NPM_REGISTRY}"\nauth = { token = "$TOKEN" }\nempty = ""\n`,
  );
  const cli = runCli(root, undefined, {
    BUN_CONFIG_REGISTRY: NPM_REGISTRY,
    NPM_CONFIG_REGISTRY: NPM_REGISTRY,
    npm_config_registry: NPM_REGISTRY,
    NPM_TEST_REGISTRY: NPM_REGISTRY,
  });
  expect(cli.status).toBe(0);
  expect(cli.stdout).toContain("All 1 checked");
});

test.each([OTHER_REGISTRY, `${OTHER_REGISTRY}old-pkg/-/old-pkg-2.0.0.tgz`])(
  "lock registry resolution exits 2: %s",
  async (resolution) => {
    const root = fixture(lockText({ "old-pkg": ["old-pkg@2.0.0", resolution] }), ["old-pkg"]);
    const cli = runCli(root);
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain('UnsupportedRegistry: bun.lock packages["old-pkg"] resolution');
  },
);

test.each(["", NPM_REGISTRY, `${NPM_REGISTRY}old-pkg/-/old-pkg-2.0.0.tgz`])(
  "default lock registry resolution proceeds: %s",
  (resolution) => {
    const root = fixture(lockText({ "old-pkg": ["old-pkg@2.0.0", resolution] }), undefined);
    expect(runCli(root).status).toBe(0);
  },
);

test.each([
  ["http://127.0.0.1:4873", ""],
  [OTHER_REGISTRY, "1"],
  [NPM_REGISTRY, "1"],
])("registry override is refused: %s / %s", (registry, enabled) => {
  const root = oldFixture();
  const cli = runCli(root, undefined, { BOB_RELEASE_AGE_TEST_REGISTRY: enabled }, [
    "--registry",
    registry,
  ]);
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("TestRegistryOverrideRefused");
});

test.each(["http://127.0.0.1:4873", "http://[::1]:4873"])(
  "enabled loopback test registry proceeds: %s",
  (registry) => {
    const root = oldFixture();
    const cli = runCli(root, undefined, { BOB_RELEASE_AGE_TEST_REGISTRY: "1" }, [
      "--registry",
      registry,
    ]);
    expect(cli.status).toBe(0);
  },
);

test("youngest offender is listed first", async () => {
  const root = fixture(lockText({ older: ["older@1.0.0"], younger: ["younger@1.0.0"] }), undefined);
  const result = await checkLockfileReleaseAge({
    root,
    now: NOW,
    fetchImpl: stubFetch({
      older: { "1.0.0": new Date(NOW - 2 * 86_400_000).toISOString() },
      younger: { "1.0.0": new Date(NOW - 3_600_000).toISOString() },
    }),
  });
  expect(result.tooYoung.map((entry) => entry.name)).toEqual(["younger", "older"]);
});

test.each([
  ["2", 2000],
  [new Date(NOW + 5000).toUTCString(), 5000],
  ["9999999999", 30_000],
  [new Date(NOW + 60_000).toUTCString(), 30_000],
  [new Date(NOW - 1000).toUTCString(), 0],
  [null, 1000],
  ["invalid", 1000],
])("Retry-After %s waits %s ms", (value, delay) => {
  expect(retryAfterMs(value, NOW)).toBe(delay);
});

test.each([
  [429, 200, true],
  [503, 200, true],
  [429, 429, false],
  [503, 503, false],
])("registry response sequence %s / %s returns ok=%s", async (first, second, ok) => {
  const root = oldFixture();
  const statuses = [first, second];
  const calls = [];
  const result = await checkLockfileReleaseAge({
    root,
    now: NOW,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ time: { "2.0.0": "2000-01-01T00:00:00Z" } }), {
        status: statuses.shift(),
        headers: { "retry-after": "0" },
      });
    },
  });
  expect(calls).toHaveLength(2);
  expect(result.ok).toBe(ok);
  if (!ok) expect(result.lookupFailures[0].error).toContain(`HTTP ${second}`);
});
