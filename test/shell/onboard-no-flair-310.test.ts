import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnNode, spawnNodeAsync } from "../cli-spawn.js";

// bob#310: `bob onboard ... --no-flair` must not scaffold the flair capability.
// Keeping it could reconnect when a valid key already existed.

const CLI = join(import.meta.dir, "../../dist/cli.js");
const RUN_TIMEOUT_MS = 60_000;
const REPLY = "reply-310";

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// An HTTP loopback on an EPHEMERAL port (never a fixed one). `requests` records
// each request path, so "receives nothing" is observable.
async function loopback(
  respond: (path: string) => { contentType: string; body: string },
): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = String(req.url);
      requests.push(path);
      const r = respond(path);
      res.writeHead(200, { "content-type": r.contentType });
      res.end(r.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
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

describe("bob#310 — onboard --no-flair scaffolds no flair capability", () => {
  it(
    "the scaffold omits flair and the first run makes no Flair connection",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "bob-310-"));
      homes.push(home);
      const model = await loopback(() => ({
        contentType: "text/event-stream",
        body: `data: {"id":"1","choices":[{"index":0,"delta":{"content":"${REPLY}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      }));
      // The Flair URL: an ephemeral loopback that must receive nothing.
      const flair = await loopback(() => ({ contentType: "application/json", body: "{}" }));

      // A key IS present in the agent's HOME — as it is for an agent re-onboarded
      // with --no-flair, whose Flair key predates the opt-out. So a session that
      // still bootstrapped Flair would authenticate and this loopback WOULD see a
      // request; that is what makes "receives nothing" a real check rather than a
      // request that merely fails earlier at the missing key.
      mkdirSync(join(home, ".flair", "keys"), { recursive: true });
      writeFileSync(join(home, ".flair", "keys", "agent-a.key"), randomBytes(32));

      spawnNode(
        [
          CLI,
          "onboard",
          "agent-a",
          "--provider",
          "ollama",
          "--model",
          "m",
          "--context-window",
          "262144",
          "--base-url",
          `${model.url}/v1`,
          "--no-flair",
          "--flair-url",
          flair.url,
          "--no-interactive",
        ],
        { env: childEnv(home) },
      );

      const agentDir = join(home, "agents", "agent-a");
      const yaml = readFileSync(join(agentDir, "bob.yaml"), "utf8");
      expect(yaml).not.toMatch(/^ {2}- flair$/m); // no flair in capabilities:
      expect(yaml).not.toMatch(/^flair:$/m); // no flair: config block
      expect(yaml).not.toMatch(/^ {4}- flair_(?:search|write|get)$/m); // no flair tools

      const result = await spawnNodeAsync([CLI, "run", "agent-a", "hello"], {
        env: childEnv(home),
        timeoutMs: RUN_TIMEOUT_MS,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(REPLY);
      // The model was reached once; the Flair URL was never contacted.
      expect(model.requests).toEqual(["/v1/chat/completions"]);
      expect(flair.requests).toEqual([]);
    },
    RUN_TIMEOUT_MS + 30_000,
  );
});
