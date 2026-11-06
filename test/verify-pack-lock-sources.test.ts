// verify-pack installs the packed tarball's dependencies with npm. The lock npm
// writes may name sources other than the registry: a git dependency, a link, a
// local file: tarball, or a tarball from another origin. lockRegistryVersions
// refuses each one before npm ci can run, naming the lock entry.
//
// The four npm cases let the npm on PATH write the lock: the install
// directory's package.json declares the dependency, npm resolves it offline
// (a local bare Git repository, a local directory, a local tarball, a loopback
// HTTP server), and the refusal runs against npm's own lock entry. A recording
// shim logs each npm invocation and then execs the real npm, so "no ci" is the
// log. The non-exact version is hand-built because npm does not write a range
// as a resolved version. The control case uses a recording npm stub: an exact
// registry entry needs a registry, and this file makes no external requests.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { releaseAgeInstallEnv } from "../scripts/release-age-env.mjs";
import { installVerifiedTarball } from "../scripts/verify-pack-install.mjs";

const NOW = Date.parse("2026-11-05T16:23:34.927Z");
const OLD = "2020-01-01T00:00:00.000Z";

type Registry = { url: string; requests: string[]; close: () => Promise<void> };
type LockEntry = {
  version?: string;
  resolved?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
};
type Lock = { packages?: Record<string, LockEntry> };
type Prepared = {
  name: string;
  spec: string;
  close?: () => Promise<void>;
};

function makePackage(root: string, dir: string, name: string) {
  const packageDir = join(root, dir);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0" }, null, 2)}\n`,
  );
  writeFileSync(join(packageDir, "index.js"), "module.exports = 1;\n");
  return packageDir;
}

function makeTarball(root: string) {
  const work = join(root, "app");
  makePackage(root, "app/package", "app-fixture");
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

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server has no port");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  const url = await listen(server);
  return {
    url,
    requests,
    close: () => closeServer(server),
  };
}

async function startTarballServer(bytes: Buffer): Promise<Registry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(bytes);
  });
  const url = await listen(server);
  return {
    url,
    requests,
    close: () => closeServer(server),
  };
}

function lockfile(packages: Record<string, unknown>, dependencies: Record<string, string>) {
  return {
    name: "pack-probe",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "pack-probe", version: "0.0.0", dependencies },
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

function realNpmPath(): string {
  const found = spawnSync("which", ["npm"], { encoding: "utf8" });
  const path = found.stdout.trim();
  if (found.status !== 0 || path === "") throw new Error("npm is not on PATH");
  return path;
}

/** Log every npm invocation, then run the real npm with the same arguments. */
function recordingShim(root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "npm.log");
  writeFileSync(
    join(bin, "npm"),
    ["#!/bin/sh", 'printf "%s\\n" "$*" >> "$BOB_NPM_LOG"', 'exec "$BOB_REAL_NPM" "$@"', ""].join(
      "\n",
    ),
    { mode: 0o755 },
  );
  return { bin, log };
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
  rootDependencies: Record<string, string>,
  makePackages: (registryUrl: string) => Record<string, unknown>,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bob-pack-lock-source-")));
  const registry = await startRegistry(times);
  const tarball = makeTarball(root);
  const npm = fakeNpm(root);
  writeFileSync(
    npm.lockPath,
    JSON.stringify(lockfile(makePackages(registry.url), rootDependencies), null, 2),
  );
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

async function runRealNpmLock(
  prepare: (root: string) => Prepared | Promise<Prepared>,
  times: Record<string, Record<string, string>> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bob-pack-lock-source-")));
  const realNpm = realNpmPath();
  const registry = await startRegistry(times);
  const tarball = makeTarball(root);
  let prepared: Prepared | undefined;
  try {
    prepared = await prepare(root);
    const shim = recordingShim(root);
    const installDir = join(root, "install");
    mkdirSync(installDir);
    writeFileSync(
      join(installDir, "package.json"),
      `${JSON.stringify(
        {
          name: "pack-probe",
          version: "0.0.0",
          private: true,
          dependencies: { [prepared.name]: prepared.spec },
        },
        null,
        2,
      )}\n`,
    );
    const env = releaseAgeInstallEnv(baseEnv(root), NOW, {
      npm_config_cache: join(root, "cache"),
    });
    env.PATH = `${shim.bin}:${env.PATH ?? ""}`;
    env.BOB_NPM_LOG = shim.log;
    env.BOB_REAL_NPM = realNpm;
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
        commandTimeoutMs: 60_000,
      });
    } catch (caught) {
      error = caught as Error;
    }
    const log = existsSync(shim.log) ? readFileSync(shim.log, "utf8") : "";
    const lockPath = join(installDir, "package-lock.json");
    const lock = existsSync(lockPath)
      ? (JSON.parse(readFileSync(lockPath, "utf8")) as Lock)
      : undefined;
    return { result, error, log, lock, requests: registry.requests, root, installDir };
  } finally {
    await prepared?.close?.();
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The `file:` path npm writes for `target` when installing in `fromDir`. */
function fileSourceFrom(fromDir: string, target: string) {
  return `file:${relative(fromDir, target).split(sep).join("/")}`;
}

function expectRefusedBeforeCi(outcome: { error?: Error; log: string }, problem: string) {
  expect(outcome.error?.name).toBe("UnsupportedResolution");
  expect(outcome.error?.message).toContain(problem);
  expect(outcome.log).toContain("install ");
  expect(outcome.log).not.toMatch(/^ci /m);
}

function expectRealRefusal(outcome: Awaited<ReturnType<typeof runRealNpmLock>>, problem: string) {
  expectRefusedBeforeCi(outcome, problem);
  expect(outcome.result).toBeUndefined();
}

function gitDependency(root: string): Prepared {
  const source = join(root, "host-b-git-src");
  makePackage(root, "host-b-git-src", "host-b-git");
  const runGit = (...args: string[]) => spawnSync("git", args, { cwd: source, encoding: "utf8" });
  const identity = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test"];
  for (const args of [
    ["init", "-q"],
    [...identity, "add", "-A"],
    [...identity, "commit", "-qm", "fixture"],
  ]) {
    const result = runGit(...args);
    expect(result.status).toBe(0);
  }
  const head = runGit("rev-parse", "HEAD");
  const sha = head.stdout.trim();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const bare = join(root, "host-b-git.git");
  const clone = spawnSync("git", ["clone", "-q", "--bare", source, bare], { encoding: "utf8" });
  expect(clone.status).toBe(0);
  return { name: "host-b-git", spec: `git+file://${bare}#${sha}` };
}

function linkDependency(root: string): Prepared {
  makePackage(root, "host-c-link", "host-c-link");
  return { name: "host-c-link", spec: "file:../host-c-link" };
}

function fileTarballDependency(root: string): Prepared {
  makePackage(root, "host-d-file", "host-d-file");
  const tarball = join(root, "host-d-file-1.0.0.tgz");
  const tar = spawnSync("tar", ["czf", tarball, "-C", root, "host-d-file"], { encoding: "utf8" });
  expect(tar.status).toBe(0);
  return { name: "host-d-file", spec: "file:../host-d-file-1.0.0.tgz" };
}

async function foreignTarballDependency(root: string): Promise<Prepared> {
  makePackage(root, "host-e-tarball", "host-e-tarball");
  const tarball = join(root, "host-e-tarball-1.0.0.tgz");
  const tar = spawnSync("tar", ["czf", tarball, "-C", root, "host-e-tarball"], {
    encoding: "utf8",
  });
  expect(tar.status).toBe(0);
  const server = await startTarballServer(readFileSync(tarball));
  return {
    name: "host-e-tarball",
    spec: `${server.url}/host-e-tarball-1.0.0.tgz`,
    close: server.close,
  };
}

test("a git dependency npm writes is refused before ci, even with an old registry entry", async () => {
  const outcome = await runRealNpmLock(gitDependency, {
    "host-b-git": { "1.0.0": OLD },
  });
  expect(outcome.lock?.packages?.[""]?.dependencies?.["host-b-git"]).toMatch(/^git\+file:\/\//);
  const spec = outcome.lock?.packages?.["node_modules/host-b-git"]?.resolved ?? "";
  expect(spec).toMatch(/^git\+file:\/\//);
  expectRealRefusal(outcome, `host-b-git@1.0.0: resolved from ${spec}, not `);
  expect(outcome.requests).toEqual([]);
}, 60_000);

test("a link entry npm writes is refused before ci", async () => {
  const outcome = await runRealNpmLock(linkDependency);
  expect(outcome.lock?.packages?.["node_modules/host-c-link"]?.link).toBe(true);
  expectRealRefusal(outcome, "node_modules/host-c-link: links a local path");
}, 60_000);

test("another local file: tarball npm writes is refused before ci", async () => {
  const outcome = await runRealNpmLock(fileTarballDependency);
  const appSource = fileSourceFrom(outcome.installDir, join(outcome.root, "app.tgz"));
  const hostDSource = fileSourceFrom(
    outcome.installDir,
    join(outcome.root, "host-d-file-1.0.0.tgz"),
  );
  expect(outcome.lock?.packages?.["node_modules/app-fixture"]?.resolved).toBe(appSource);
  expect(outcome.lock?.packages?.["node_modules/host-d-file"]?.resolved).toBe(hostDSource);
  expectRealRefusal(outcome, `host-d-file@1.0.0: local source ${hostDSource}`);
}, 60_000);

test("a tarball npm writes from a foreign origin is refused before ci", async () => {
  let spec = "";
  const outcome = await runRealNpmLock(async (root) => {
    const prepared = await foreignTarballDependency(root);
    spec = prepared.spec;
    return prepared;
  });
  expect(outcome.lock?.packages?.["node_modules/host-e-tarball"]?.resolved).toBe(spec);
  expectRealRefusal(outcome, `host-e-tarball@1.0.0: resolved from ${spec}, not `);
  expect(outcome.requests).toEqual([]);
}, 60_000);

test("a hand-built non-exact version is refused", async () => {
  const outcome = await runLock({}, { "host-f-range": "^1.0.0" }, (registryUrl) => ({
    "node_modules/host-f-range": {
      version: "^1.0.0",
      resolved: `${registryUrl}/host-f-range/-/host-f-range-1.0.0.tgz`,
      integrity: "sha512-fixture",
    },
  }));
  expectRefusedBeforeCi(outcome, "host-f-range@^1.0.0: not an exact version");
}, 30_000);

test("an exact registry entry from the install registry passes the source check and runs npm ci", async () => {
  const outcome = await runLock(
    { "host-g-lib": { "1.0.0": OLD } },
    { "host-g-lib": "1.0.0" },
    (registryUrl) => ({
      "node_modules/host-g-lib": {
        version: "1.0.0",
        resolved: `${registryUrl}/host-g-lib/-/host-g-lib-1.0.0.tgz`,
        integrity: "sha512-fixture",
      },
    }),
  );
  expect(outcome.error).toBeUndefined();
  expect(outcome.result?.checked).toBe(1);
  expect(outcome.requests).toEqual(["/host-g-lib"]);
  expect(outcome.log).toMatch(/^ci /m);
}, 30_000);
