// The `web_fetch` tool over a REAL loopback HTTP peer, through the R1b fetch
// core (bob#152, spec v3, slice R1c). Under Node (see the harness), no external
// network: the peer is a server on 127.0.0.1 with an OS-assigned port.

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL("../../fixtures/web/tool-harness.mjs", import.meta.url));
const DIST_CORE = fileURLToPath(
  new URL("../../../dist/capabilities/web/index.js", import.meta.url),
);
const TIMEOUT_MS = 60_000;

function runHarness(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [HARNESS], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

interface Case {
  ok: boolean;
  text?: string;
  details?: { status: number; contentType: string; finalUrl: string; truncated: boolean };
  code?: string;
  detail?: string | null;
  requests?: string[];
  connections?: number;
}

test(
  "the web_fetch tool fetches a recorded URL and follows a page link, over real loopback peers",
  async () => {
    if (!existsSync(DIST_CORE)) {
      throw new Error(
        `the harness runs the built capability; ${DIST_CORE} is missing — run the build`,
      );
    }
    const { code, stdout, stderr } = await runHarness();
    if (code !== 0) throw new Error(`harness exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
    const lines = stdout.trim().split("\n");
    const report = JSON.parse(lines[lines.length - 1]) as { cases: Record<string, Case> };

    const fetch = report.cases.fetch;
    expect(fetch.ok).toBe(true);
    expect(fetch.details?.status).toBe(200);
    expect(fetch.details?.contentType).toBe("text/html");
    expect(fetch.details?.truncated).toBe(false);
    expect(String(fetch.details?.finalUrl)).toMatch(/^http:\/\/peer\.test:\d+\/start$/);
    expect(fetch.text).toContain("Title");
    // The extractor rendered the relative link resolved against the page.
    expect(fetch.text).toMatch(/next \(http:\/\/peer\.test:\d+\/next\)/);
    expect(fetch.requests).toEqual(["GET /start"]);
    expect(fetch.connections).toBe(1);

    // The page's resolved link was recorded, so the tool follows it without a
    // second seed.
    const follow = report.cases.follow;
    expect(follow.ok).toBe(true);
    expect(follow.text).toContain("linked page");

    // A URL on the same host that was never recorded is refused.
    const unrecorded = report.cases.unrecorded;
    expect(unrecorded.ok).toBe(false);
    expect(unrecorded.code).toBe("url-unrecorded");

    // A redirect to an unrecorded destination is refused before dispatch: the
    // peer sent the redirect response and received no request for the destination.
    const redirect = report.cases.redirect;
    expect(redirect.ok).toBe(false);
    expect(redirect.code).toBe("url-unrecorded");
    expect(redirect.requests).toEqual(["GET /start", "GET /next", "GET /redirect"]);
  },
  TIMEOUT_MS,
);
