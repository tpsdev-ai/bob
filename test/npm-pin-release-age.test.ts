// The release pipeline installs an exact npm version before it stages a
// release. That pin is not covered by bun.lock, so checkNpmPinReleaseAge reads
// it from release-publish.yml and looks its publish time up in the registry.
// The lookup is exercised offline against a loopback HTTP registry, including
// the CLI's exit codes and its refusal to accept a test registry under CI.
import { expect, test } from "bun:test";
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

test("the published pin passes at 7 days old", async () => {
  const { result, requests } = await checkWith({ "11.21.1": OLD, "11.99.0": YOUNG });
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

function runCli(args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn("bun", ["--no-install", CLI, ...args], {
        cwd: REPO,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
  const oldRegistry = await startRegistry({ "11.21.1": OLD });
  try {
    const accepted = await runCli(["--registry", oldRegistry.url], fixtureEnv());
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("pinned npm@11.21.1 is at least 7 days old");
  } finally {
    await oldRegistry.close();
  }
  const youngRegistry = await startRegistry({ "11.21.1": YOUNG });
  try {
    const refused = await runCli(["--registry", youngRegistry.url], fixtureEnv());
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain("npm@11.21.1");
  } finally {
    await youngRegistry.close();
  }
}, 30_000);

test("the CLI refuses --registry under CI", async () => {
  const registry = await startRegistry({ "11.21.1": OLD });
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
