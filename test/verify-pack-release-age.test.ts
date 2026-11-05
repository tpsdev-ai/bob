// verify-pack installs a packed tarball with npm, which resolves the tarball's
// dependency ranges from the registry and does not read bunfig.toml. npm's
// `before` config is not fail-closed: it accepts a version with no publish
// time. `installVerifiedTarball` therefore verifies every resolved registry
// version in the lock against its publish time before it runs `npm ci`, and
// refuses inherited npm config that could relax the cutoff. A refused version
// is named in that error. A version npm rejects during resolution, before a
// lock exists, gets the cutoff guidance instead, and a registry metadata lookup
// failure is reported as its own error.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inheritedNpmSettings,
  isResolutionFailure,
  RELEASE_AGE_MS,
  releaseAgeCutoff,
  releaseAgeInstallEnv,
} from "../scripts/release-age-env.mjs";
import { installVerifiedTarball } from "../scripts/verify-pack-install.mjs";

const VERIFY_PACK = join(import.meta.dir, "..", "scripts", "verify-pack.mjs");
const NOW = Date.parse("2026-11-05T16:23:34.927Z");
const CUTOFF = "2026-10-29T16:23:34.927Z";

type Fixture = { name: string; version: string; published?: string };
type Registry = { url: string; requests: string[]; close: () => Promise<void> };

function makeTarball(
  root: string,
  dir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const work = join(root, dir);
  const packageDir = join(work, "package");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(packageDir, "index.js"), "module.exports = 1;\n");
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(packageDir, name), content);
  }
  const tarball = join(root, `${dir}.tgz`);
  const tar = spawnSync("tar", ["czf", tarball, "-C", work, "package"], { encoding: "utf8" });
  expect(tar.status).toBe(0);
  const bytes = readFileSync(tarball);
  return {
    tarball,
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

async function startRegistry(
  fixtures: Fixture[],
  tarballs: Map<string, { bytes: Buffer; integrity: string }>,
): Promise<Registry> {
  const requests: string[] = [];
  let base = "";
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    requests.push(url);
    const fixture = fixtures.find((candidate) => url === `/${candidate.name}`);
    if (fixture) {
      const tarball = tarballs.get(fixture.name);
      if (!tarball) throw new Error(`no tarball fixture for ${fixture.name}`);
      const body = {
        name: fixture.name,
        "dist-tags": { latest: fixture.version },
        versions: {
          [fixture.version]: {
            name: fixture.name,
            version: fixture.version,
            dist: {
              tarball: `${base}/${fixture.name}/-/${fixture.name}-${fixture.version}.tgz`,
              integrity: tarball.integrity,
            },
          },
        },
        time: fixture.published === undefined ? {} : { [fixture.version]: fixture.published },
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    const tarballFixture = fixtures.find(
      (candidate) => url === `/${candidate.name}/-/${candidate.name}-${candidate.version}.tgz`,
    );
    if (tarballFixture) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarballs.get(tarballFixture.name)?.bytes);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server has no port");
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function baseEnv(root: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^npm_config_/i.test(key)) continue;
    env[key] = value;
  }
  env.HOME = join(root, "home");
  mkdirSync(env.HOME, { recursive: true });
  return env;
}

function configPaths(root: string) {
  const userconfig = join(root, "user.npmrc");
  const globalconfig = join(root, "global.npmrc");
  writeFileSync(userconfig, "");
  writeFileSync(globalconfig, "");
  return { userconfig, globalconfig };
}

function installEnv(root: string) {
  const { userconfig, globalconfig } = configPaths(root);
  return releaseAgeInstallEnv(baseEnv(root), NOW, {
    npm_config_cache: join(root, "cache"),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
  });
}

function appFixture(root: string, dependency: string) {
  return makeTarball(
    root,
    "app",
    {
      name: "app-fixture",
      version: "1.0.0",
      dependencies: { [dependency]: "1.0.0" },
      scripts: { install: "node install.cjs" },
    },
    {
      "install.cjs":
        'require("node:fs").writeFileSync(process.env.BOB_AGE_MARKER, "install script ran");\n',
    },
  );
}

function newInstallDir(root: string) {
  const installDir = join(root, "install");
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify({ name: "pack-probe", version: "0.0.0", private: true })}\n`,
  );
  return installDir;
}

async function runInstall(
  root: string,
  fixture: Fixture,
  options: { env?: Record<string, string>; tarball?: ReturnType<typeof makeTarball> } = {},
) {
  const tarball = options.tarball ?? appFixture(root, fixture.name);
  const tarballs = new Map([
    [fixture.name, { bytes: tarball.bytes, integrity: tarball.integrity }],
  ]);
  const registry = await startRegistry([fixture], tarballs);
  const installDir = newInstallDir(root);
  const marker = join(root, "install-script.marker");
  const env = options.env ?? installEnv(root);
  env.BOB_AGE_MARKER = marker;
  try {
    const result = await installVerifiedTarball({
      tarball: tarball.tarball,
      installDir,
      env,
      now: NOW,
      registry: registry.url,
      timeoutMs: 5_000,
    });
    return { result, installDir, marker, registry, error: undefined };
  } catch (error) {
    return { result: undefined, installDir, marker, registry, error };
  } finally {
    await registry.close();
  }
}

test("the cutoff is exactly 7 days before the supplied NOW", () => {
  expect(RELEASE_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  expect(releaseAgeCutoff(NOW)).toBe(CUTOFF);
});

test("the install environment sets npm_config_before and keeps only controlled npm config", () => {
  const base = { HOME: "/tmp/host-a-home", npm_config_cache: "/tmp/inherited-cache" };
  const env = releaseAgeInstallEnv(base, NOW, { npm_config_cache: "/tmp/scratch-cache" });
  expect(env.npm_config_before).toBe(CUTOFF);
  expect(env.HOME).toBe(base.HOME);
  expect(env.npm_config_cache).toBe("/tmp/scratch-cache");
  expect(base).not.toHaveProperty("npm_config_before");
});

test.each([
  [{ npm_config_min_release_age_exclude: "lib" }, ["npm_config_min_release_age_exclude"]],
  [{ NPM_CONFIG_BEFORE: "2030-01-01T00:00:00.000Z" }, ["NPM_CONFIG_BEFORE"]],
  [{ npm_config_registry: "https://registry.example.test" }, ["npm_config_registry"]],
  [{ npm_config_cache: "/tmp/cache" }, []],
  [{ HOME: "/tmp/home" }, []],
])("inherited npm config is classified: %j", (env, expected) => {
  expect(inheritedNpmSettings(env)).toEqual(expected);
});

test("an inherited exclusion is refused before npm runs", () => {
  expect(() =>
    releaseAgeInstallEnv({ HOME: "/tmp/host-a-home", npm_config_min_release_age_exclude: "lib" }),
  ).toThrow(/npm_config_min_release_age_exclude/);
});

test("verify-pack builds its install environment and installs through the verified helper", () => {
  const source = readFileSync(VERIFY_PACK, "utf8");
  expect(source).toContain("releaseAgeInstallEnv(");
  expect(source).toContain("installVerifiedTarball(");
  expect(source).toContain("release-age cutoff:");
});

test.each([
  ["npm error code ETARGET", true],
  ["npm error notarget No matching version found for host-a-lib@^2.0.0", true],
  ["npm error code ENOVERSIONS No versions available for host-a-lib", true],
  ["npm error code E404", false],
  ["", false],
])("only a resolution failure is classified as one: %s", (output, expected) => {
  expect(isResolutionFailure(output)).toBe(expected);
});

test("an old version installs, and its install script runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "bob-pack-age-old-"));
  try {
    const { result, installDir, marker, error } = await runInstall(root, {
      name: "fixture-old-lib",
      version: "1.0.0",
      published: "2020-01-01T00:00:00.000Z",
    });
    expect(error).toBeUndefined();
    expect(result?.checked).toBe(1);
    expect(existsSync(join(installDir, "node_modules", "fixture-old-lib", "package.json"))).toBe(
      true,
    );
    expect(existsSync(marker)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("a young version is refused and no install script runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "bob-pack-age-young-"));
  try {
    const { installDir, marker, error } = await runInstall(root, {
      name: "fixture-young-lib",
      version: "1.0.0",
      published: new Date(NOW - 60 * 60 * 1000).toISOString(),
    });
    expect(error).toBeDefined();
    expect(String((error as Error).message)).toMatch(/release-age cutoff|fixture-young-lib/);
    expect(existsSync(join(installDir, "node_modules", "fixture-young-lib"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("a version with no publish time is refused and no install script runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "bob-pack-age-notime-"));
  try {
    const { installDir, marker, error } = await runInstall(root, {
      name: "fixture-notime-lib",
      version: "1.0.0",
    });
    expect((error as Error)?.name).toBe("ReleaseAgeRefused");
    expect(String((error as Error).message)).toContain("fixture-notime-lib@1.0.0");
    expect(String((error as Error).message)).toContain("no publish time");
    expect(existsSync(join(installDir, "node_modules", "fixture-notime-lib"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("an inherited exclusion is refused before resolving against the registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "bob-pack-age-exclude-"));
  const tarball = appFixture(root, "fixture-excluded-lib");
  const registry = await startRegistry(
    [{ name: "fixture-excluded-lib", version: "1.0.0", published: "2020-01-01T00:00:00.000Z" }],
    new Map([["fixture-excluded-lib", { bytes: tarball.bytes, integrity: tarball.integrity }]]),
  );
  try {
    const installDir = newInstallDir(root);
    const { userconfig, globalconfig } = configPaths(root);
    const env = {
      ...baseEnv(root),
      npm_config_cache: join(root, "cache"),
      npm_config_userconfig: userconfig,
      npm_config_globalconfig: globalconfig,
      npm_config_min_release_age_exclude: "fixture-excluded-lib",
    };
    let error: Error | undefined;
    try {
      await installVerifiedTarball({
        tarball: tarball.tarball,
        installDir,
        env,
        now: NOW,
        registry: registry.url,
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.name).toBe("InheritedNpmConfigRefused");
    expect(error?.message).toContain("npm_config_min_release_age_exclude");
    expect(registry.requests).toEqual([]);
    expect(existsSync(join(installDir, "package-lock.json"))).toBe(false);
  } finally {
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

async function npmrcRefusal(where: "install" | "home") {
  const root = mkdtempSync(join(tmpdir(), `bob-pack-npmrc-${where}-`));
  const tarball = appFixture(root, "fixture-npmrc-lib");
  const installDir = newInstallDir(root);
  const env = installEnv(root);
  const npmrc = where === "install" ? join(installDir, ".npmrc") : join(env.HOME, ".npmrc");
  writeFileSync(npmrc, "before=2030-01-01T00:00:00.000Z\n");
  let error: Error | undefined;
  try {
    await installVerifiedTarball({ tarball: tarball.tarball, installDir, env, now: NOW });
  } catch (caught) {
    error = caught as Error;
  }
  return { root, error, npmrc, installDir };
}

test.each(["install", "home"] as const)(
  "a .npmrc in the %s scratch directory is refused",
  async (where) => {
    const { root, error, npmrc, installDir } = await npmrcRefusal(where);
    try {
      expect(error?.name).toBe("InheritedNpmConfigRefused");
      expect(error?.message).toContain(npmrc);
      expect(existsSync(join(installDir, "package-lock.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);

test("an install refusal removes scratch without --keep", () => {
  const root = mkdtempSync(join(tmpdir(), "bob-pack-refusal-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const realNpm = spawnSync("which", ["npm"], { encoding: "utf8" }).stdout.trim();
    expect(realNpm).toMatch(/npm$/);
    writeFileSync(
      join(bin, "npm"),
      [
        "#!/bin/sh",
        'if [ "$1" = "pack" ]; then',
        `  exec ${JSON.stringify(realNpm)} "$@"`,
        "fi",
        'echo "npm error code ETARGET" >&2',
        'echo "npm error notarget No matching version found for fixture-lib@^1.0.0." >&2',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = baseEnv(root);
    env.TMPDIR = root;
    env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    const result = spawnSync("node", [VERIFY_PACK], {
      cwd: join(import.meta.dir, ".."),
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "No version the tarball's dependency ranges allow was published before the release-age cutoff",
    );
    expect(readdirSync(root).filter((name) => name.startsWith("bob-verify-pack-"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
