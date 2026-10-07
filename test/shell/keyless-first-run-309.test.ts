import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnNode, spawnNodeAsync } from "../cli-spawn.js";

// bob#309: a freshly onboarded keyless agent runs its first prompt through the
// real onboard + `bob run` path (pi's real prompt() and its configured-auth
// check), against a loopback server.

const CLI = join(import.meta.dir, "../../dist/cli.js");
const RUN_TIMEOUT_MS = 60_000;
const REPLY = "reply-309";

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function loopback(): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(String(req.url));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: {"id":"1","choices":[{"index":0,"delta":{"content":"${REPLY}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

// No ambient provider key reaches the child: only these names are passed.
function childEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    BOB_STATE_DIR: process.env.BOB_STATE_DIR,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

function onboard(home: string, provider: string, baseUrl?: string): string {
  spawnNode(
    [
      CLI,
      "onboard",
      "agent-a",
      "--provider",
      provider,
      "--model",
      "m",
      "--context-window",
      "262144",
      ...(baseUrl ? ["--base-url", baseUrl] : []),
      "--no-flair",
      "--no-interactive",
    ],
    { env: childEnv(home) },
  );
  const agentDir = join(home, "agents", "agent-a");
  // bob#310: --no-flair omits the flair capability (its config block and its
  // tools with it), so this run makes no Flair connection and needs no fixture
  // surgery.
  const yaml = readFileSync(join(agentDir, "bob.yaml"), "utf8");
  expect(yaml).not.toMatch(/^ {2}- flair$/m);
  return agentDir;
}

function run(home: string) {
  return spawnNodeAsync([CLI, "run", "agent-a", "hello"], {
    env: childEnv(home),
    timeoutMs: RUN_TIMEOUT_MS,
  });
}

function authJson(agentDir: string): string {
  return readFileSync(join(agentDir, ".pi-agent", "auth.json"), "utf8");
}

describe("bob#309 — a freshly onboarded keyless agent runs its first prompt", () => {
  for (const provider of ["ollama", "omlx"]) {
    it(
      `${provider}: onboard writes no credential and the first run sends one request`,
      async () => {
        const home = mkdtempSync(join(tmpdir(), "bob-309-"));
        homes.push(home);
        const server = await loopback();
        const agentDir = onboard(home, provider, server.url);
        expect(JSON.parse(authJson(agentDir))).toEqual({});

        const result = await run(home);

        expect(result.stderr).not.toContain("No API key found");
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(REPLY);
        expect(server.requests).toEqual(["/v1/chat/completions"]);
        expect(JSON.parse(authJson(agentDir))).toEqual({});
      },
      RUN_TIMEOUT_MS + 30_000,
    );
  }

  it(
    "a keyed row with no key still refuses with its existing message",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "bob-309-"));
      homes.push(home);
      const server = await loopback();
      const agentDir = onboard(home, "ollama-cloud");
      // No key: drop the scaffold entry, and point the row at the loopback so
      // a request, if one were sent, stays on this host and is counted.
      writeFileSync(join(agentDir, ".pi-agent", "auth.json"), "{}\n");
      const modelsPath = join(agentDir, ".pi-agent", "models.json");
      const models = JSON.parse(readFileSync(modelsPath, "utf8"));
      models.providers["ollama-cloud"].baseUrl = server.url;
      writeFileSync(modelsPath, JSON.stringify(models, null, 2));

      const result = await run(home);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("run failed — No API key found for ollama-cloud.");
      expect(server.requests).toEqual([]);
    },
    RUN_TIMEOUT_MS + 30_000,
  );
});
