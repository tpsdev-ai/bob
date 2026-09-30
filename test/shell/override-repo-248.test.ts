// bob#248: the Git calls that initialize the override repository (run only when
// it has no `.git` yet) start no automatic maintenance or gc, so initOverrideRepo
// — and hire, whose last step it is — does not return while automatic
// maintenance or gc started by those calls is still working in the agent
// directory.
//
// Before bob passed `maintenance.auto=false` and `gc.auto=0`, the observed
// `git commit` started `git maintenance run --auto` after its own work, and
// that run can detach and keep working inside the new repository after the
// commit has returned. A test's cleanup that removed the agent directory next
// raced it; under Bun, its rmSync returned without an error and left the tree
// behind in some of the observed runs.
//
// Git's own trace (GIT_TRACE2_EVENT, which the initializer's Git subprocesses
// inherit from bob's environment) records each Git process's command line and
// how it exited, and the command line of each child command it runs, so this
// checks what ran, not how long it took.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POSITIONS_ROOT, hireAgent, initOverrideRepo } from "../../src/shell/index.js";

interface TraceEvent {
  event: string;
  sid?: string;
  argv?: string[];
  code?: number;
}

function traceLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

const parseTrace = (lines: string[]): TraceEvent[] =>
  lines.map((line) => JSON.parse(line) as TraceEvent);

// Every argv Git traced, from a process start or a child it started.
function tracedCommands(events: TraceEvent[]): string[][] {
  return events
    .filter((e) => e.event === "start" || e.event === "child_start")
    .map((e) => e.argv ?? []);
}

// The problems this check finds in a trace of the initializer's Git calls;
// empty when it finds none.
// Known-present: each of bob's `init`, `add` and `commit` must have a `start`
// record AND an `exit` record with code 0 from the same process (paired by the
// Trace2 session id), so an empty trace, or one cut before a call finished,
// cannot pass. Known-absent: no traced process started maintenance or gc.
function traceProblems(events: TraceEvent[]): string[] {
  const problems: string[] = [];
  const exitCode = new Map<string, number>();
  for (const e of events) {
    if (e.event === "exit" && e.sid !== undefined && e.code !== undefined) {
      exitCode.set(e.sid, e.code);
    }
  }
  for (const sub of ["init", "add", "commit"]) {
    const starts = events.filter((e) => e.event === "start" && (e.argv ?? []).includes(sub));
    if (starts.length === 0) problems.push(`no start record for git ${sub}`);
    else if (!starts.some((e) => e.sid !== undefined && exitCode.get(e.sid) === 0)) {
      problems.push(`git ${sub} has no exit record with code 0`);
    }
  }
  for (const argv of tracedCommands(events)) {
    if (argv.some((arg) => arg === "maintenance" || arg === "gc")) {
      problems.push(`housekeeping started: ${argv.join(" ")}`);
    }
  }
  return problems;
}

describe("the override repository's initializing Git calls start no automatic maintenance or gc (bob#248)", () => {
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
    expect(traceProblems(parseTrace(traceLines(tracePath)))).toEqual([]);
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
    expect(traceProblems(parseTrace(traceLines(tracePath)))).toEqual([]);
  });

  // The check rejects a trace cut before the commit's successful exit. This
  // test cuts the real trace of initOverrideRepo right after the `commit`
  // process's start record.
  it("a trace cut right after the commit's start record fails the check", () => {
    const base = scratchDir();
    const agentDir = join(base, "agent");
    mkdirSync(agentDir);
    const tracePath = join(base, "git-trace.json");
    process.env.GIT_TRACE2_EVENT = tracePath;
    initOverrideRepo(agentDir);
    const lines = traceLines(tracePath);
    expect(traceProblems(parseTrace(lines))).toEqual([]);
    const commitStart = parseTrace(lines).findIndex(
      (e) => e.event === "start" && (e.argv ?? []).includes("commit"),
    );
    expect(commitStart).toBeGreaterThanOrEqual(0);
    const cut = parseTrace(lines.slice(0, commitStart + 1));
    expect(traceProblems(cut)).toEqual(["git commit has no exit record with code 0"]);
  });
});
