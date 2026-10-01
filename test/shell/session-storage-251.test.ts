import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./session-storage-251-runner.ts", import.meta.url));

describe("pi transcripts use the agent's session store", () => {
  let root: string;
  let agentsRoot: string;
  let home: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-session-storage-"));
    agentsRoot = join(root, "agents");
    home = join(root, "home");
    mkdirSync(home);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runCase(name: "persistent" | "interactive"): void {
    const env = { ...process.env, HOME: home };
    delete env.PI_CODING_AGENT_DIR;
    const child = spawnSync(process.execPath, [runner, name, agentsRoot], {
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const { file, sessionDir } = JSON.parse(child.stdout) as {
      file: string;
      sessionDir: string;
    };
    expect(file.startsWith(`${sessionDir}/`)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain(`${name} transcript`);
    expect(existsSync(join(home, ".pi", "agent", "sessions"))).toBe(false);
  }

  it("persists a warm session under the agent and continues its transcript", () => {
    runCase("persistent");
  }, 20_000);

  it("finds and resumes an interactive transcript from the agent's store", () => {
    runCase("interactive");
  }, 20_000);
});
