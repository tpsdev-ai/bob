import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
