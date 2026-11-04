import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function checkCli(delay: number, timeout: number, status: number) {
  const root = mkdtempSync(join(tmpdir(), "bob-lockfile-age-http-"));
  const requests: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.writeHead(200, { "content-type": "application/json" });
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
    const cli = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          "node",
          [
            realpathSync(script),
            "--registry",
            `http://127.0.0.1:${address.port}`,
            "--timeout-ms",
            String(timeout),
          ],
          { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
        );
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
      },
    );
    expect(requests).toEqual(["/old-pkg"]);
    expect(cli.code).toBe(status);
    if (status === 2) {
      expect(cli.stderr).toContain("registry request failed for old-pkg@1.0.0:");
      expect(cli.stderr).toMatch(/timeout|aborted/i);
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
  "Node fetch: delayed publish-time lookup fails naming the package",
  () => checkCli(1500, 250, 2),
  15_000,
);

test("Node fetch: in-time publish-time lookup passes", () => checkCli(0, 5000, 0), 15_000);
