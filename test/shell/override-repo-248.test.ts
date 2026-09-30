// bob#248: the override repository's Git calls start no background process, so
// initOverrideRepo — and hire, whose last step it is — returns only when no Git
// process it started is still working in the agent directory.
//
// `git commit` starts `git maintenance run --auto` after its own work, and that
// run can detach and keep working inside the new repository after the commit
// has returned. A caller that removed the agent directory next (a test's
// cleanup, hire's own rollback) raced it; under Bun, rmSync could return
// without an error and leave the tree behind.
//
// Git's own trace (GIT_TRACE2_EVENT, which every git process bob runs inherits)
// records each process's argv and each child process it starts, so this checks
// what ran, not how long it took.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POSITIONS_ROOT, hireAgent, initOverrideRepo } from "../../src/shell/index.js";

interface TraceEvent {
  event: string;
  argv?: string[];
}

function readTrace(path: string): TraceEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TraceEvent);
}

// Every argv Git traced, from a process start or a child it started.
function tracedCommands(events: TraceEvent[]): string[][] {
  return events
    .filter((e) => e.event === "start" || e.event === "child_start")
    .map((e) => e.argv ?? []);
}

function expectNoBackgroundHousekeeping(tracePath: string): void {
  const commands = tracedCommands(readTrace(tracePath));
  // Known-present: the trace saw bob's own Git calls, so an empty or unread
  // trace cannot pass.
  for (const sub of ["init", "add", "commit"]) {
    expect(commands.some((argv) => argv.includes(sub))).toBe(true);
  }
  // Known-absent: no Git process started maintenance or gc.
  const housekeeping = commands.filter((argv) =>
    argv.some((arg) => arg === "maintenance" || arg === "gc"),
  );
  expect(housekeeping).toEqual([]);
}

describe("the override repository starts no background Git process (bob#248)", () => {
  const scratch: string[] = [];
  const savedTrace = process.env.GIT_TRACE2_EVENT;

  const scratchDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "bob-ovr248-"));
    scratch.push(dir);
    return dir;
  };

  afterEach(() => {
    if (savedTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = savedTrace;
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("initOverrideRepo", () => {
    const base = scratchDir();
    const agentDir = join(base, "agent");
    mkdirSync(agentDir);
    const tracePath = join(base, "git-trace.json");
    process.env.GIT_TRACE2_EVENT = tracePath;
    initOverrideRepo(agentDir);
    expect(existsSync(join(agentDir, "overrides", ".git"))).toBe(true);
    expectNoBackgroundHousekeeping(tracePath);
  });

  it("hire", async () => {
    const base = scratchDir();
    const agentsRoot = join(base, "agents");
    mkdirSync(agentsRoot);
    const tracePath = join(base, "git-trace.json");
    process.env.GIT_TRACE2_EVENT = tracePath;
    const hired = await hireAgent({
      name: "ovr-hire",
      positionName: "builder",
      agentsRoot,
      hostRoot: join(base, "host"),
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextWindow: 200_000,
      skipFlair: true,
      interview: async () => 0,
    });
    expect(existsSync(join(hired.agentDir, "overrides", ".git"))).toBe(true);
    expectNoBackgroundHousekeeping(tracePath);
  });
});
