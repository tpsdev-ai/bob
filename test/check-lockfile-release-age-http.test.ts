import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBunLock } from "../scripts/check-lockfile-release-age.mjs";

function fixtureEnv(root: string) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: root,
    NPM_CONFIG_USERCONFIG: join(root, "absent.npmrc"),
  };
  for (const key of ["BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry"])
    delete env[key];
  return env;
}

async function runBun(args: string[], cwd: string, env = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function checkCli(
  delay: number,
  timeout: number,
  status: number,
  statuses = [200],
  retryAfter: string | (() => string) = "0",
  minimumWaitMs = 0,
) {
  const root = mkdtempSync(join(tmpdir(), "bob-lockfile-age-http-"));
  const requests: string[] = [];
  const requestTimes: number[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    requestTimes.push(Date.now());
    const responseStatus = statuses[Math.min(requests.length - 1, statuses.length - 1)];
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.writeHead(responseStatus, {
        "content-type": "application/json",
        "retry-after": typeof retryAfter === "function" ? retryAfter() : retryAfter,
      });
      res.end(JSON.stringify({ time: { "1.0.0": "2000-01-01T00:00:00.000Z" } }));
    }, delay);
    timers.add(timer);
  });
  try {
    writeFileSync(join(root, "bun.lock"), '{"packages":{"old-pkg":["old-pkg@1.0.0"]}}');
    writeFileSync(join(root, "bunfig.toml"), "[install]\nminimumReleaseAge = 604800\n");
    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts", "check-lockfile-release-age.mjs");
    copyFileSync(new URL("../scripts/check-lockfile-release-age.mjs", import.meta.url), script);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server has no port");
    const cli = await runBun(
      [
        "--no-install",
        realpathSync(script),
        "--registry",
        `http://127.0.0.1:${address.port}`,
        "--timeout-ms",
        String(timeout),
      ],
      root,
      { ...fixtureEnv(root), BOB_RELEASE_AGE_TEST_REGISTRY: "1" },
    );
    expect(requests).toEqual(statuses.map(() => "/old-pkg"));
    if (minimumWaitMs > 0)
      expect(requestTimes[1] - requestTimes[0]).toBeGreaterThanOrEqual(minimumWaitMs);
    expect(cli.code).toBe(status);
    if (status === 2 && statuses.length > 1) {
      expect(cli.stderr).toContain(`registry returned HTTP ${statuses[1]} for old-pkg@1.0.0`);
    } else if (status === 2) {
      expect(cli.stderr).toContain("registry request failed for old-pkg@1.0.0:");
      expect(cli.stderr).toMatch(/timeout|timed out|aborted/i);
    } else {
      expect(cli.stderr).toBe("");
      expect(cli.stdout).toContain("All 1 checked package version(s) are at least 7-day old.");
    }
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  "Bun fetch: delayed publish-time lookup fails naming the package",
  () => checkCli(1500, 250, 2),
  15_000,
);

test("Bun fetch: in-time publish-time lookup passes", () => checkCli(0, 5000, 0), 15_000);

test.each([429, 503])("Bun fetch: HTTP %s then 200 passes after Retry-After seconds", (status) =>
  checkCli(0, 5000, 0, [status, 200], "1", 900),
);

test.each([429, 503])("Bun fetch: HTTP %s then 200 passes after Retry-After date", (status) =>
  checkCli(0, 5000, 0, [status, 200], () => new Date(Date.now() + 2000).toUTCString(), 900),
);

test.each([429, 503])("Bun fetch: HTTP %s twice fails naming the status", (status) =>
  checkCli(0, 5000, 2, [status, status]),
);

test("Bun frozen install reads the repo npmrc registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "bob-registry-install-"));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(404);
    res.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server has no port");
    const dependencies = { "bob-registry-fixture": "1.0.0" };
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "registry-fixture", dependencies }),
    );
    writeFileSync(
      join(root, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { "": { name: "registry-fixture", dependencies } },
        packages: {
          "bob-registry-fixture": [
            "bob-registry-fixture@1.0.0",
            "",
            {},
            `sha512-${Buffer.alloc(64).toString("base64")}`,
          ],
        },
      }),
    );
    writeFileSync(join(root, "bunfig.toml"), "[install]\nminimumReleaseAge = 604800\n");
    writeFileSync(join(root, ".npmrc"), `registry=http://127.0.0.1:${address.port}\n`);
    const env = {
      ...fixtureEnv(root),
      BUN_CONFIG_HTTP_RETRY_COUNT: "0",
      BUN_INSTALL_CACHE_DIR: join(root, "cache"),
    };
    const install = await runBun(["install", "--frozen-lockfile", "--ignore-scripts"], root, env);
    expect(install.code).toBe(1);
    expect(requests).toEqual(["/bob-registry-fixture/-/bob-registry-fixture-1.0.0.tgz"]);
    const script = join(root, "scripts", "check-lockfile-release-age.mjs");
    mkdirSync(join(root, "scripts"));
    copyFileSync(new URL("../scripts/check-lockfile-release-age.mjs", import.meta.url), script);
    const cli = await runBun(["--no-install", realpathSync(script)], root, env);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain("UnsupportedRegistry");
    expect(cli.stderr).toContain(".npmrc registry");
    expect(requests).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

type RegistryContext = { root: string; home: string; xdg: string; registry: string };

type RecordingServer = { url: string; requests: string[]; close: () => Promise<void> };

async function startRecordingServer(
  respond: (request: IncomingMessage, response: ServerResponse) => boolean = () => false,
): Promise<RecordingServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (respond(request, response)) return;
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

// A dead loopback proxy keeps any request that escapes the local registry from
// leaving the host. NO_PROXY lets the loopback registry itself through.
function isolatedEnv(root: string, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    "BUN_CONFIG_REGISTRY",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
    "BUN_ENV",
    "NODE_ENV",
  ]) {
    delete env[key];
  }
  return Object.assign(env, {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    BUN_INSTALL_CACHE_DIR: join(root, "cache"),
    BUN_CONFIG_HTTP_RETRY_COUNT: "0",
    HTTPS_PROXY: "http://127.0.0.1:1",
    HTTP_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
    https_proxy: "http://127.0.0.1:1",
    http_proxy: "http://127.0.0.1:1",
    no_proxy: "127.0.0.1,localhost",
    ...extra,
  });
}

function writeInstallFixture(root: string, pkg: string) {
  const dependencies = { [pkg]: "1.0.0" };
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "registry-fixture", dependencies }),
  );
  writeFileSync(
    join(root, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { name: "registry-fixture", dependencies } },
      packages: {
        [pkg]: [`${pkg}@1.0.0`, "", {}, `sha512-${Buffer.alloc(64).toString("base64")}`],
      },
    }),
  );
  writeFileSync(join(root, "bunfig.toml"), "[install]\nminimumReleaseAge = 604800\n");
}

function copyChecker(root: string) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  const script = join(root, "scripts", "check-lockfile-release-age.mjs");
  copyFileSync(new URL("../scripts/check-lockfile-release-age.mjs", import.meta.url), script);
  return realpathSync(script);
}

type RegistrySource = {
  name: string;
  source: string;
  pkg?: string;
  setup?: (context: RegistryContext) => void;
  env?: (context: RegistryContext) => Record<string, string>;
  unsetXdg?: boolean;
};

const registrySources: RegistrySource[] = [
  {
    name: "repository .npmrc registry",
    source: ".npmrc registry",
    setup: ({ root, registry }) => writeFileSync(join(root, ".npmrc"), `registry=${registry}\n`),
  },
  {
    name: "repository .npmrc scoped registry",
    source: ".npmrc @probe:registry",
    pkg: "@probe/pkg",
    setup: ({ root, registry }) =>
      writeFileSync(join(root, ".npmrc"), `@probe:registry=${registry}\n`),
  },
  {
    name: "repository bunfig install.registry",
    source: "bunfig.toml install.registry",
    setup: ({ root, registry }) =>
      writeFileSync(
        join(root, "bunfig.toml"),
        `[install]\nminimumReleaseAge = 604800\nregistry = "${registry}"\n`,
      ),
  },
  {
    name: "repository bunfig install.scopes",
    source: "bunfig.toml install.scopes.@probe",
    pkg: "@probe/pkg",
    setup: ({ root, registry }) =>
      writeFileSync(
        join(root, "bunfig.toml"),
        `[install]\nminimumReleaseAge = 604800\n[install.scopes]\n"@probe" = "${registry}"\n`,
      ),
  },
  {
    name: "environment BUN_CONFIG_REGISTRY",
    source: "BUN_CONFIG_REGISTRY",
    env: ({ registry }) => ({ BUN_CONFIG_REGISTRY: registry }),
  },
  {
    name: "environment NPM_CONFIG_REGISTRY",
    source: "NPM_CONFIG_REGISTRY",
    env: ({ registry }) => ({ NPM_CONFIG_REGISTRY: registry }),
  },
  {
    name: "environment npm_config_registry",
    source: "npm_config_registry",
    env: ({ registry }) => ({ npm_config_registry: registry }),
  },
  ...([".env", ".env.local", ".env.production", ".env.production.local"] as const).map(
    (file): RegistrySource => ({
      name: `install environment file ${file}`,
      source: `${file} BUN_CONFIG_REGISTRY`,
      setup: ({ root, registry }) =>
        writeFileSync(join(root, file), `BUN_CONFIG_REGISTRY=${registry}\n`),
      env: () => ({ BUN_ENV: "production" }),
    }),
  ),
  {
    name: "install environment file .env.development",
    source: ".env.development BUN_CONFIG_REGISTRY",
    setup: ({ root, registry }) =>
      writeFileSync(join(root, ".env.development"), `BUN_CONFIG_REGISTRY=${registry}\n`),
    env: () => ({ NODE_ENV: "development" }),
  },
  {
    name: "user .npmrc in HOME",
    source: "home/.npmrc registry",
    setup: ({ home, registry }) => writeFileSync(join(home, ".npmrc"), `registry=${registry}\n`),
  },
  {
    name: "user .npmrc selected by NPM_CONFIG_USERCONFIG",
    source: "selected.npmrc registry",
    setup: ({ root, registry }) =>
      writeFileSync(join(root, "selected.npmrc"), `registry=${registry}\n`),
    env: ({ root }) => ({ NPM_CONFIG_USERCONFIG: join(root, "selected.npmrc") }),
  },
  {
    name: "user .npmrc in XDG_CONFIG_HOME",
    source: "xdg/.npmrc registry",
    setup: ({ xdg, registry }) => writeFileSync(join(xdg, ".npmrc"), `registry=${registry}\n`),
  },
  {
    name: "global bunfig in XDG_CONFIG_HOME",
    source: "xdg/.bunfig.toml",
    setup: ({ xdg, registry }) =>
      writeFileSync(join(xdg, ".bunfig.toml"), `[install]\nregistry = "${registry}"\n`),
  },
  {
    name: "global bunfig in HOME when XDG_CONFIG_HOME is unset",
    source: "home/.bunfig.toml",
    unsetXdg: true,
    setup: ({ home, registry }) =>
      writeFileSync(join(home, ".bunfig.toml"), `[install]\nregistry = "${registry}"\n`),
  },
  {
    name: "lowercase npm_config_userconfig",
    source: "low.npmrc registry",
    setup: ({ root, registry }) => writeFileSync(join(root, "low.npmrc"), `registry=${registry}\n`),
    env: ({ root }) => ({ npm_config_userconfig: join(root, "low.npmrc") }),
  },
];

for (const source of registrySources) {
  test(`real frozen install honours ${source.name}; checker exits 2 naming it`, async () => {
    const root = mkdtempSync(join(tmpdir(), "bob-registry-source-"));
    const pkg = source.pkg ?? "bob-registry-fixture";
    let install: RecordingServer | undefined;
    let lookup: RecordingServer | undefined;
    try {
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "xdg"));
      writeInstallFixture(root, pkg);
      install = await startRecordingServer();
      const context = {
        root,
        home: join(root, "home"),
        xdg: join(root, "xdg"),
        registry: install.url,
      };
      source.setup?.(context);
      const env = isolatedEnv(root, source.env?.(context) ?? {});
      if (source.unsetXdg) delete env.XDG_CONFIG_HOME;

      const result = await runBun(
        [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--no-cache",
          "--cache-dir",
          join(root, "cache"),
        ],
        root,
        env,
      );
      const installRequests = [...install.requests];
      expect(result.code).not.toBe(0);
      const name = pkg.slice(pkg.lastIndexOf("/") + 1);
      expect(installRequests).toEqual([`/${pkg}/-/${name}-1.0.0.tgz`]);

      lookup = await startRecordingServer();
      const cli = await runBun(
        ["--no-install", copyChecker(root), "--registry", lookup.url, "--timeout-ms", "1000"],
        root,
        { ...env, BOB_RELEASE_AGE_TEST_REGISTRY: "1" },
      );
      expect(cli.code).toBe(2);
      expect(cli.stderr).toContain("UnsupportedRegistry");
      expect(cli.stderr).toContain(source.source);
      expect(lookup.requests).toEqual([]);
    } finally {
      await install?.close();
      await lookup?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
}

test("Bun ignores ~/.bunfig.toml when XDG_CONFIG_HOME is set", async () => {
  const root = mkdtempSync(join(tmpdir(), "bob-registry-home-bunfig-"));
  let install: RecordingServer | undefined;
  try {
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "xdg"));
    writeInstallFixture(root, "bob-registry-fixture");
    install = await startRecordingServer();
    writeFileSync(join(root, "home", ".bunfig.toml"), `[install]\nregistry = "${install.url}"\n`);
    const result = await runBun(
      [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--no-cache",
        "--cache-dir",
        join(root, "cache"),
      ],
      root,
      isolatedEnv(root),
    );
    expect(result.code).not.toBe(0);
    expect(install.requests).toEqual([]);
  } finally {
    await install?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("checker exits 2 on a Bun-written lock whose recorded resolution is a non-default registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "bob-bun-lock-"));
  let registry: RecordingServer | undefined;
  let lookup: RecordingServer | undefined;
  try {
    const packageRoot = join(root, "tarball", "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "tiny-pkg", version: "1.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), "module.exports = 1;\n");
    const tarball = join(root, "tiny-pkg-1.0.0.tgz");
    const tar = spawnSync("tar", ["czf", tarball, "-C", join(root, "tarball"), "package"], {
      encoding: "utf8",
    });
    expect(tar.status).toBe(0);
    const bytes = readFileSync(tarball);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const shasum = createHash("sha1").update(bytes).digest("hex");

    let registryUrl = "";
    registry = await startRecordingServer((request, response) => {
      if (request.url === "/tiny-pkg") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            name: "tiny-pkg",
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                name: "tiny-pkg",
                version: "1.0.0",
                dist: {
                  tarball: `${registryUrl}/tiny-pkg/-/tiny-pkg-1.0.0.tgz`,
                  integrity,
                  shasum,
                },
              },
            },
          }),
        );
        return true;
      }
      if (request.url === "/tiny-pkg/-/tiny-pkg-1.0.0.tgz") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(bytes);
        return true;
      }
      return false;
    });
    registryUrl = registry.url;

    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { "tiny-pkg": "1.0.0" } }),
    );
    writeFileSync(join(project, ".npmrc"), `registry=${registryUrl}\n`);
    const env = isolatedEnv(root);
    const install = await runBun(
      ["install", "--ignore-scripts", "--no-cache", "--cache-dir", join(root, "cache")],
      project,
      env,
    );
    expect(install.code).toBe(0);

    const lock = parseBunLock(readFileSync(join(project, "bun.lock"), "utf8"));
    const resolution = lock.packages["tiny-pkg"][1];
    expect(resolution).toBe(`${registryUrl}/tiny-pkg/-/tiny-pkg-1.0.0.tgz`);

    rmSync(join(project, ".npmrc"));
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    registry.requests.length = 0;
    const frozen = await runBun(
      [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--no-cache",
        "--cache-dir",
        join(root, "cache2"),
      ],
      project,
      env,
    );
    expect(frozen.code).toBe(0);
    expect(registry.requests).toEqual(["/tiny-pkg/-/tiny-pkg-1.0.0.tgz"]);

    writeFileSync(join(project, "bunfig.toml"), "[install]\nminimumReleaseAge = 604800\n");
    lookup = await startRecordingServer((request, response) => {
      if (request.url !== "/tiny-pkg") return false;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ time: { "1.0.0": "2000-01-01T00:00:00.000Z" } }));
      return true;
    });
    const cli = await runBun(
      ["--no-install", copyChecker(project), "--registry", lookup.url, "--timeout-ms", "1000"],
      project,
      { ...env, BOB_RELEASE_AGE_TEST_REGISTRY: "1" },
    );
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain("UnsupportedRegistry");
    expect(cli.stderr).toContain('bun.lock packages["tiny-pkg"] resolution');
    expect(lookup.requests).toEqual([]);
  } finally {
    await registry?.close();
    await lookup?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
