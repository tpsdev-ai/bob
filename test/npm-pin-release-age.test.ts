// The release pipeline installs an exact npm version before it stages a
// release. That pin is not covered by bun.lock, so checkNpmPinReleaseAge reads
// it from release-publish.yml and looks its publish time up in the registry.
// The lookup is exercised offline against a loopback HTTP registry, including
// the CLI's exit codes and its refusal to accept a test registry under CI.
import { expect, setSystemTime, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNpmPinReleaseAge, readNpmPin } from "../scripts/check-npm-pin-release-age.mjs";

const REPO = join(import.meta.dir, "..");
const WORKFLOW = join(REPO, ".github", "workflows", "release-publish.yml");
const CLI = join(REPO, "scripts", "check-npm-pin-release-age.mjs");
const NOW = Date.parse("2026-11-05T16:23:34.927Z");
const OLD = "2020-01-01T00:00:00.000Z";
const YOUNG = new Date(NOW - 60 * 60 * 1000).toISOString();
const CUTOFF = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();

function cliTimes() {
  const now = Date.now();
  return {
    old: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
    young: new Date(now - 60 * 60 * 1000).toISOString(),
  };
}

type Registry = { url: string; requests: string[]; close: () => Promise<void> };

async function startRegistry(times: Record<string, string>): Promise<Registry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/npm") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: "npm", time: times }));
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

function fixtureEnv() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "CI" || key === "GITHUB_ACTIONS") continue;
    env[key] = value;
  }
  env.BOB_RELEASE_AGE_TEST_REGISTRY = "1";
  return env;
}

async function checkWith(times: Record<string, string>, workflowPath = WORKFLOW) {
  const registry = await startRegistry(times);
  try {
    const result = await checkNpmPinReleaseAge({
      workflowPath,
      now: NOW,
      registry: registry.url,
      env: fixtureEnv(),
      timeoutMs: 5_000,
    });
    return { result, requests: registry.requests };
  } finally {
    await registry.close();
  }
}

test("a pin published at the cutoff passes", async () => {
  const { result, requests } = await checkWith({ "11.21.1": CUTOFF, "11.99.0": YOUNG });
  expect(result.ok).toBe(true);
  expect(result.pin).toBe("11.21.1");
  expect(result.ageMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
  expect(requests).toEqual(["/npm"]);
}, 15_000);

test("a pin published inside the bake is refused by name", async () => {
  const { result } = await checkWith({ "11.21.1": YOUNG });
  expect(result.ok).toBe(false);
  expect(result.pin).toBe("11.21.1");
  expect(result.reason).toContain("npm@11.21.1");
  expect(result.reason).toContain("days ago; bake: 7 days");
}, 15_000);

test("a pin with no publish time is refused", async () => {
  const { result } = await checkWith({ "12.0.0": OLD });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("no publish time");
}, 15_000);

test.each([
  "2020",
  "2020-13-01T00:00:00Z",
  "2026-02-30T00:00:00.000Z",
  "",
  2020,
  "2020-01-01T00:00:00+00:00",
  "2020-01-01T01:00:00+01:00",
  "2020-01-01T24:00:00.000Z",
])(
  "noncanonical or invalid publish timestamp %j is refused by version and value",
  async (published) => {
    const result = await checkNpmPinReleaseAge({
      now: NOW,
      fetchImpl: async () => Response.json({ time: { "11.21.1": published } }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("npm@11.21.1");
    expect(result.reason).toContain(JSON.stringify(published));
  },
);

test.each(["2020-02-29T12:34:56.789Z", "2020-02-29T12:34:56Z"])(
  "valid UTC publish timestamp %s passes the bake",
  async (published) => {
    const result = await checkNpmPinReleaseAge({
      now: NOW,
      fetchImpl: async () => Response.json({ time: { "11.21.1": published } }),
    });
    expect(result.ok).toBe(true);
    expect(result.publishedAt).toBe(published);
  },
);

test("the pin is read from the workflow file, not hardcoded", async () => {
  const root = mkdtempSync(join(tmpdir(), "bob-npm-pin-workflow-"));
  try {
    const workflowPath = join(root, "release-publish.yml");
    writeFileSync(
      workflowPath,
      readFileSync(WORKFLOW, "utf8").replace(
        "npm install -g npm@11.21.1",
        "npm install -g npm@11.99.0",
      ),
    );
    const { result } = await checkWith({ "11.21.1": OLD, "11.99.0": YOUNG }, workflowPath);
    expect(result.ok).toBe(false);
    expect(result.pin).toBe("11.99.0");
    expect(result.reason).toContain("npm@11.99.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("a non-exact pin is refused", () => {
  expect(() =>
    readNpmPin(
      readFileSync(WORKFLOW, "utf8").replace(
        "npm install -g npm@11.21.1",
        "npm install -g npm@^11.21.1",
      ),
    ),
  ).toThrow(/must run exactly npm install -g npm@<x\.y\.z>/);
});

function runCli(args: string[], env: Record<string, string>, preload?: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        "bun",
        ["--no-install", ...(preload ? ["--preload", preload] : []), CLI, ...args],
        {
          cwd: REPO,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    },
  );
}

test("the CLI passes an old pin and fails a young one", async () => {
  const times = cliTimes();
  const oldRegistry = await startRegistry({ "11.21.1": times.old });
  try {
    const accepted = await runCli(["--registry", oldRegistry.url], fixtureEnv());
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("pinned npm@11.21.1 is at least 7 days old");
  } finally {
    await oldRegistry.close();
  }
  const youngRegistry = await startRegistry({ "11.21.1": times.young });
  try {
    const refused = await runCli(["--registry", youngRegistry.url], fixtureEnv());
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain("npm@11.21.1");
  } finally {
    await youngRegistry.close();
  }
}, 30_000);

test("the CLI refuses an invalid publish timestamp by version and value", async () => {
  const registry = await startRegistry({ "11.21.1": "2020" });
  try {
    const result = await runCli(["--registry", registry.url], fixtureEnv());
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain("npm@11.21.1");
    expect(result.stderr).toContain('"2020"');
  } finally {
    await registry.close();
  }
}, 15_000);

test("real-clock CLI fixtures retain their verdicts after the former fixture expires", async () => {
  const root = mkdtempSync(join(tmpdir(), "bob-npm-pin-clock-"));
  try {
    setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const times = cliTimes();
    for (const [published, status] of [
      [times.old, 0],
      [times.young, 1],
    ] as const) {
      const preload = join(root, "clock-and-registry.mjs");
      writeFileSync(
        preload,
        'import { readFileSync } from "node:fs";\nconst data = JSON.parse(readFileSync(process.env.BOB_TEST_CLOCK_FILE, "utf8"));\nDate.now = () => data.now;\nglobalThis.fetch = async () => Response.json(data.metadata);\n',
      );
      const clockFile = join(root, "clock.json");
      writeFileSync(
        clockFile,
        JSON.stringify({ now: Date.now(), metadata: { time: { "11.21.1": published } } }),
      );
      const result = await runCli([], { ...fixtureEnv(), BOB_TEST_CLOCK_FILE: clockFile }, preload);
      expect(result.status, result.stderr || result.stdout).toBe(status);
      expect(result.stdout || result.stderr).toContain("npm@11.21.1");
    }
  } finally {
    setSystemTime();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("the CLI refuses --registry under CI", async () => {
  const registry = await startRegistry({ "11.21.1": cliTimes().old });
  try {
    const result = await runCli(["--registry", registry.url], {
      ...fixtureEnv(),
      CI: "true",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("TestRegistryOverrideRefusedInCi");
  } finally {
    await registry.close();
  }
}, 15_000);
