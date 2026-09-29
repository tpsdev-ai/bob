// The boot sweep (bob#211, "on-disk registry + boot-time reap"): jobs recorded by
// a bob run whose supervisor DIED are found in the registry when the next
// session loads the capability, cancelled by their recorded process group when
// the group's leader still matches the record, and reported. The sweep runs
// inside pi's extension load (helpers.ts loads the capability through the real
// loader), so this is the path a restarted agent takes.
//
// The "dead run" is seeded on disk; the processes in it are real groups THIS
// test starts (detached `sleep`s), and the test ends whatever it started.

import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLeaderStart } from "../../../src/capabilities/work/run.js";
import { groupAlive, type LiveWork, waitFor, workSession } from "./helpers.js";
import { call, program } from "./program.js";

const started: ChildProcess[] = [];
let live: LiveWork | undefined;
let root: string | undefined;

afterEach(async () => {
  await live?.cleanup();
  live = undefined;
  for (const c of started.splice(0)) {
    if (c.pid === undefined) continue;
    try {
      process.kill(-c.pid, "SIGKILL"); // a group this test started
    } catch {
      // gone
    }
  }
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

// A real detached group (pgid = pid) that the test owns.
function startGroup(seconds = 30): ChildProcess {
  const c = spawn("sleep", [String(seconds)], { detached: true, stdio: "ignore" });
  started.push(c);
  return c;
}

// A pid that is certainly gone: a process that already ran to completion.
function deadPid(): number {
  const r = spawnSync("true");
  return r.pid as number;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function entry(runId: string, pgid: number, supervisor: number, leaderStart: string | null) {
  return {
    v: 1,
    run_id: runId,
    pgid,
    supervisor_pid: supervisor,
    started_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 600_000).toISOString(),
    timeout_s: 600,
    command_sha256: "0".repeat(64),
    cwd: "/nowhere",
    background: true,
    output_ref: "/nowhere/out.log",
    leader_start: leaderStart,
    state: "running",
  };
}

function seedRun(stateRoot: string, name: string, supervisor: number): string {
  const dir = join(stateRoot, name);
  mkdirSync(join(dir, "jobs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "out"), { recursive: true, mode: 0o700 });
  writeJson(join(dir, "run.json"), { v: 1, supervisor_pid: supervisor, started_at: "x" });
  writeFileSync(join(dir, "out", "run-1.log"), "captured output of a dead run\n");
  return dir;
}

describe("boot sweep — jobs left by a dead supervisor", () => {
  it("cancels a verified orphan by its group, reports every record, leaves live runs alone", async () => {
    root = mkdtempSync(join(tmpdir(), "bob-work-boot-"));
    const stateRoot = join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });

    const dead = deadPid();
    const orphan = startGroup();
    const unmatched = startGroup();
    const gone = spawn("true", [], { detached: true, stdio: "ignore" });
    await new Promise((r) => gone.once("exit", r));
    const liveRunGroup = startGroup();
    const orphanPid = orphan.pid as number;
    const unmatchedPid = unmatched.pid as number;
    const livePid = liveRunGroup.pid as number;
    // Wait until ps can see the orphan's leader, then record its start time.
    let leader: string | null = null;
    for (let i = 0; i < 50 && leader === null; i++) leader = await readLeaderStart(orphanPid);
    expect(leader).not.toBeNull();

    // A dead run with three running records: a verified orphan, a group whose
    // leader does not match the record, and a group that is already gone.
    const deadRun = seedRun(stateRoot, `run-${dead}-1000-aaaaaa`, dead);
    writeJson(
      join(deadRun, "jobs", `pg-${orphanPid}.run-1.json`),
      entry("run-1", orphanPid, dead, leader),
    );
    writeJson(
      join(deadRun, "jobs", `pg-${unmatchedPid}.run-2.json`),
      entry("run-2", unmatchedPid, dead, "Thu Jan  1 00:00:00 1970"),
    );
    writeJson(
      join(deadRun, "jobs", `pg-${gone.pid}.run-3.json`),
      entry("run-3", gone.pid as number, dead, null),
    );
    // A run whose supervisor is ALIVE (this process): never touched.
    const liveRun = seedRun(stateRoot, `run-${process.pid}-2000-bbbbbb`, process.pid);
    writeJson(
      join(liveRun, "jobs", `pg-${livePid}.run-1.json`),
      entry("run-1", livePid, process.pid, null),
    );
    // An old ended run past the retention bound: deleted.
    const oldRun = seedRun(stateRoot, `run-${dead}-3000-cccccc`, dead);
    writeJson(join(oldRun, "ended.json"), {
      v: 1,
      ended_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // The next session loads the capability: the sweep runs at load.
    live = await workSession({ stateRoot, script: program(call("run", { command: "true" })) });

    const reaps = await live.work.bootSweep;
    expect(reaps.map((r) => r.run_id).sort()).toEqual(["run-1", "run-2", "run-3"]);

    // (1) The verified orphan: cancelled by its group.
    expect(await waitFor(() => !groupAlive(orphanPid), 3000)).toBe(true);
    const e1 = JSON.parse(
      readFileSync(join(deadRun, "jobs", `pg-${orphanPid}.run-1.json`), "utf8"),
    );
    expect(e1).toMatchObject({
      state: "finished",
      outcome: "cancelled",
      cancel_reason: "boot_reap",
      cleanup_state: "group_killed",
      output_complete: false,
    });
    expect(e1.reaped_by).toMatchObject({ pid: process.pid, signalled: true });

    // (2) A group whose leader does not match: NOT signalled, reported unverified.
    expect(groupAlive(unmatchedPid)).toBe(true);
    const e2 = JSON.parse(
      readFileSync(join(deadRun, "jobs", `pg-${unmatchedPid}.run-2.json`), "utf8"),
    );
    expect(e2).toMatchObject({
      state: "finished",
      outcome: "no_exit_status",
      cleanup_state: "escaped_or_unverified",
    });
    expect(e2.reaped_by.signalled).toBe(false);

    // (3) A group already gone: no exit status was ever observed.
    const e3 = JSON.parse(readFileSync(join(deadRun, "jobs", `pg-${gone.pid}.run-3.json`), "utf8"));
    expect(e3).toMatchObject({ outcome: "no_exit_status", cleanup_state: "group_empty" });

    // The dead run's captures are gone; its records stay (inside retention).
    expect(existsSync(join(deadRun, "out"))).toBe(false);
    expect(existsSync(join(deadRun, "ended.json"))).toBe(true);

    // The live run is untouched: its group runs, its record still says running.
    expect(groupAlive(livePid)).toBe(true);
    const e4 = JSON.parse(readFileSync(join(liveRun, "jobs", `pg-${livePid}.run-1.json`), "utf8"));
    expect(e4.state).toBe("running");
    expect(existsSync(join(liveRun, "out", "run-1.log"))).toBe(true);

    // The old ended run is past retention: deleted.
    expect(existsSync(oldRun)).toBe(false);

    // Every reap is reported in the log.
    const lines = live.logs.filter((l) => l.startsWith("work: boot sweep:"));
    expect(lines.length).toBe(3);
    expect(lines.join("\n")).toContain(`left by bob pid ${dead}, which is gone`);

    // The new session works normally after the sweep.
    await live.prompt();
    expect(live.results[0].details.outcome).toBe("exited");
  }, 30_000);

  it("refuses to act on a state directory other users can read", async () => {
    root = mkdtempSync(join(tmpdir(), "bob-work-boot-"));
    const stateRoot = join(root, "state");
    mkdirSync(stateRoot, { mode: 0o700 });
    spawnSync("chmod", ["755", stateRoot]);
    live = await workSession({ stateRoot, script: program(call("run", { command: "true" })) });
    expect(await live.work.bootSweep).toEqual([]);
    expect(live.logs.join("\n")).toContain("boot sweep skipped");
    await live.prompt();
    const r = live.results[0];
    expect(r.isError).toBe(true);
    expect(r.text).toContain("has mode 755, readable by other users. Run chmod 700");
  }, 20_000);
});
