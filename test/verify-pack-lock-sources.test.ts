// verify-pack installs the packed tarball's dependencies with npm. The lock npm
// writes may name sources other than the registry: a git dependency, a link, a
// second local file:, a tarball from another origin, or a non-exact version.
// lockRegistryVersions refuses each one before npm ci can run, naming the lock
// entry. The locks below are hand-built (npm's lockfileVersion 3 shape) and the
// npm commands are a recording stub, so the test sees whether ci ran.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseAgeInstallEnv } from "../scripts/release-age-env.mjs";
import { installVerifiedTarball } from "../scripts/verify-pack-install.mjs";

const NOW = Date.parse("2026-11-05T16:23:34.927Z");
const OLD = "2020-01-01T00:00:00.000Z";

type Registry = { url: string; requests: string[]; close: () => Promise<void> };

function makeTarball(root: string) {
  const work = join(root, "app");
  const packageDir = join(work, "package");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "app-fixture", version: "1.0.0" }, null, 2)}\n`,
  );
  writeFileSync(join(packageDir, "index.js"), "module.exports = 1;\n");
  const tarball = join(root, "app.tgz");
  const tar = spawnSync("tar", ["czf", tarball, "-C", work, "package"], { encoding: "utf8" });
  expect(tar.status).toBe(0);
  const bytes = readFileSync(tarball);
  return {
    tarball,
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

async function startRegistry(times: Record<string, Record<string, string>>): Promise<Registry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    requests.push(url);
    const name = decodeURIComponent(url.slice(1));
    const versionTimes = times[name];
    if (versionTimes) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name, time: versionTimes }));
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
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function lockfile(packages: Record<string, unknown>) {
  return {
    name: "pack-probe",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "pack-probe", version: "0.0.0", dependencies: {} },
      ...packages,
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

function fakeNpm(root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "npm.log");
  const lockPath = join(root, "lock-fixture.json");
  writeFileSync(
    join(bin, "npm"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$BOB_NPM_LOG"',
      'if [ "$1" = "install" ]; then',
      '  cp "$BOB_LOCK_FIXTURE" package-lock.json',
      "  exit 0",
      "fi",
      'if [ "$1" = "ci" ]; then',
      "  exit 0",
      "fi",
      "exit 2",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { bin, log, lockPath };
}

async function runLock(
  times: Record<string, Record<string, string>>,
  makePackages: (registryUrl: string) => Record<string, unknown>,
) {
  const root = mkdtempSync(join(tmpdir(), "bob-pack-lock-source-"));
  const registry = await startRegistry(times);
  const tarball = makeTarball(root);
  const npm = fakeNpm(root);
  writeFileSync(npm.lockPath, JSON.stringify(lockfile(makePackages(registry.url)), null, 2));
  const installDir = join(root, "install");
  mkdirSync(installDir);
  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify({ name: "pack-probe", version: "0.0.0", private: true })}\n`,
  );
  const env = releaseAgeInstallEnv(baseEnv(root), NOW, { npm_config_cache: join(root, "cache") });
  env.PATH = `${npm.bin}:${env.PATH ?? ""}`;
  env.BOB_NPM_LOG = npm.log;
  env.BOB_LOCK_FIXTURE = npm.lockPath;
  try {
    let result: Awaited<ReturnType<typeof installVerifiedTarball>> | undefined;
    let error: Error | undefined;
    try {
      result = await installVerifiedTarball({
        tarball: tarball.tarball,
        installDir,
        env,
        now: NOW,
        registry: registry.url,
        timeoutMs: 5_000,
      });
    } catch (caught) {
      error = caught as Error;
    }
    const log = existsSync(npm.log) ? readFileSync(npm.log, "utf8") : "";
    return { result, error, log, requests: registry.requests };
  } finally {
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function expectRefusedBeforeCi(outcome: Awaited<ReturnType<typeof runLock>>, problem: string) {
  expect(outcome.error?.name).toBe("UnsupportedResolution");
  expect(outcome.error?.message).toContain(problem);
  expect(outcome.log).toContain("install ");
  expect(outcome.log).not.toMatch(/^ci /m);
}

test("a git dependency is refused, even when its name and version match an old registry entry", async () => {
  const outcome = await runLock({ "host-b-lib": { "2.3.4": OLD } }, () => ({
    "node_modules/host-b-lib": {
      version: "2.3.4",
      resolved:
        "git+https://github.com/example/host-b-lib.git#0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
    },
  }));
  expectRefusedBeforeCi(
    outcome,
    "host-b-lib@2.3.4: resolved from git+https://github.com/example/host-b-lib.git",
  );
  expect(outcome.requests).toEqual([]);
}, 30_000);

test("a git dependency without a matching registry entry is refused", async () => {
  const outcome = await runLock({}, () => ({
    "node_modules/host-b-git": {
      version: "1.0.0",
      resolved:
        "git+ssh://git@github.com/example/host-b-git.git#89abcdef0123456789abcdef0123456789abcdef",
    },
  }));
  expectRefusedBeforeCi(
    outcome,
    "host-b-git@1.0.0: resolved from git+ssh://git@github.com/example/host-b-git.git",
  );
}, 30_000);

test("a link entry is refused", async () => {
  const outcome = await runLock({}, () => ({
    "node_modules/host-c-link": { resolved: "packages/host-c-link", link: true },
  }));
  expectRefusedBeforeCi(outcome, "node_modules/host-c-link: links a local path");
}, 30_000);

test("a second local file: source is refused", async () => {
  const outcome = await runLock({}, () => ({
    "node_modules/host-d-file": { version: "1.0.0", resolved: "file:../host-d-file" },
  }));
  expectRefusedBeforeCi(outcome, "host-d-file@1.0.0: local source file:../host-d-file");
}, 30_000);

test("a tarball from another origin is refused", async () => {
  const outcome = await runLock({}, () => ({
    "node_modules/host-e-tarball": {
      version: "1.0.0",
      resolved: "https://registry.example.test/host-e-tarball/-/host-e-tarball-1.0.0.tgz",
      integrity: "sha512-fixture",
    },
  }));
  expectRefusedBeforeCi(
    outcome,
    "host-e-tarball@1.0.0: resolved from https://registry.example.test/host-e-tarball/-/host-e-tarball-1.0.0.tgz",
  );
}, 30_000);

test("a non-exact version is refused", async () => {
  const outcome = await runLock({}, (registryUrl) => ({
    "node_modules/host-f-range": {
      version: "^1.0.0",
      resolved: `${registryUrl}/host-f-range/-/host-f-range-1.0.0.tgz`,
      integrity: "sha512-fixture",
    },
  }));
  expectRefusedBeforeCi(outcome, "host-f-range@^1.0.0: not an exact version");
}, 30_000);

test("an exact registry entry from the install registry still installs", async () => {
  const outcome = await runLock({ "host-g-lib": { "1.0.0": OLD } }, (registryUrl) => ({
    "node_modules/host-g-lib": {
      version: "1.0.0",
      resolved: `${registryUrl}/host-g-lib/-/host-g-lib-1.0.0.tgz`,
      integrity: "sha512-fixture",
    },
  }));
  expect(outcome.error).toBeUndefined();
  expect(outcome.result?.checked).toBe(1);
  expect(outcome.requests).toEqual(["/host-g-lib"]);
  expect(outcome.log).toMatch(/^ci /m);
}, 30_000);
