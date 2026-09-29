// The boot sweep (bob#211, "on-disk registry + boot-time reap"): jobs recorded by
// a bob run whose supervisor DIED (or whose pid now belongs to another process)
// are found in the registry when the next session loads the capability. A job's
// group is signalled only while its leader still has the sub-second identity
// pinned at spawn — checked again before every signal — and every record is
// reported. The sweep runs inside pi's extension load (helpers.ts loads the
// capability through the real loader), so this is the path a restarted agent
// takes.
//
// The "dead runs" are seeded on disk; the processes in them are real groups THIS
// test starts (detached), and the test ends whatever it started. The identity
// reader is injected where a test needs a controlled answer (a same-second pid
// reuse, an identity lost mid-escalation); the real Linux reader is exercised
// on Linux.

import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type IdentityReader,
  identityFromProc,
  type ProcIdentity,
  processInstanceId,
  readProcIdentity,
} from "../../../src/capabilities/work/run.js";
import { type GroupOps, NODE_GROUP_OPS } from "../../../src/shell/process-group.js";
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
function startGroup(command = "sleep 30"): ChildProcess {
  const c = spawn("/bin/sh", ["-c", command], { detached: true, stdio: "ignore" });
  started.push(c);
  return c;
}

// A real detached group that IGNORES SIGTERM, returned only once its shell has
// installed the trap (it says "ready" first) — a SIGTERM that arrived before
// the trap would end it, which is not the case under test.
async function startTermIgnoringGroup(): Promise<number> {
  const c = spawn("/bin/sh", ["-c", "trap '' TERM; echo ready; exec sleep 30"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  started.push(c);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the test group never said ready")), 5000);
    c.stdout?.once("data", () => {
      clearTimeout(t);
      resolve();
    });
  });
  c.stdout?.destroy();
  return c.pid as number;
}

// A pid that is certainly gone: a process that already ran to completion.
function deadPid(): number {
  const r = spawnSync("true");
  return r.pid as number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function readEntry(dir: string, file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "jobs", file), "utf8"));
}

function ident(pid: number, start: string): ProcIdentity {
  return { boot: "test-boot", start, pgid: pid, sid: pid };
}

function entry(runId: string, pgid: number, supervisor: number, leader: ProcIdentity | null) {
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
    leader_identity: leader,
    state: "running",
  };
}

function seedRun(
  stateRoot: string,
  name: string,
  supervisor: number,
  extra: Record<string, unknown> = {},
): string {
  const dir = join(stateRoot, name);
  mkdirSync(join(dir, "jobs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "out"), { recursive: true, mode: 0o700 });
  writeJson(join(dir, "run.json"), { v: 1, supervisor_pid: supervisor, started_at: "x", ...extra });
  writeFileSync(join(dir, "out", "run-1.log"), "captured output of an earlier run\n");
  return dir;
}

// A reader that answers from a table (a live pid gets its table entry, a dead
// one null) and says "unsupported" for every pid not in it.
function tableReader(table: Map<number, ProcIdentity>): IdentityReader {
  return (pid) => {
    const id = table.get(pid);
    if (id === undefined) return "unsupported";
    return pidAlive(pid) ? id : null;
  };
}

// Group ops that record every signal and then deliver it.
function recordingOps(signals: Array<[number, string]>): GroupOps {
  return {
    exists: NODE_GROUP_OPS.exists,
    signal(pgid, sig) {
      signals.push([pgid, sig]);
      NODE_GROUP_OPS.signal(pgid, sig);
    },
  };
}

function scratchState(): string {
  root = mkdtempSync(join(tmpdir(), "bob-work-boot-"));
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  return stateRoot;
}

describe("boot sweep — jobs left by a dead supervisor", () => {
  it("cancels a pinned orphan by its group, reports every record, leaves live runs alone", async () => {
    const stateRoot = scratchState();
    const dead = deadPid();
    const orphan = startGroup().pid as number;
    const reused = startGroup().pid as number;
    const unpinned = startGroup().pid as number;
    // A group that is already gone: the pid of a process that ran to completion.
    const gone = deadPid();
    const liveRunGroup = startGroup().pid as number;

    // The identities "the platform" reports now. The orphan's matches its record;
    // the reused pid's does not; the unpinned job had no identity recorded.
    const table = new Map<number, ProcIdentity>([
      [orphan, ident(orphan, "5000")],
      [reused, ident(reused, "7001")],
      [unpinned, ident(unpinned, "8000")],
    ]);
    const signals: Array<[number, string]> = [];

    const deadRun = seedRun(stateRoot, "run-dead01", dead);
    writeJson(
      join(deadRun, "jobs", `pg-${orphan}.run-1.json`),
      entry("run-1", orphan, dead, ident(orphan, "5000")),
    );
    writeJson(
      join(deadRun, "jobs", `pg-${reused}.run-2.json`),
      entry("run-2", reused, dead, ident(reused, "7000")),
    );
    writeJson(join(deadRun, "jobs", `pg-${gone}.run-3.json`), entry("run-3", gone, dead, null));
    writeJson(
      join(deadRun, "jobs", `pg-${unpinned}.run-4.json`),
      entry("run-4", unpinned, dead, null),
    );
    // A run whose supervisor is ALIVE — this very process, with its instance id:
    // never touched.
    const liveRun = seedRun(stateRoot, "run-live01", process.pid, {
      supervisor_instance: processInstanceId(),
    });
    writeJson(
      join(liveRun, "jobs", `pg-${liveRunGroup}.run-1.json`),
      entry("run-1", liveRunGroup, process.pid, null),
    );
    // An old ended run past the retention bound: deleted.
    const oldRun = seedRun(stateRoot, "run-old001", dead);
    writeJson(join(oldRun, "ended.json"), {
      v: 1,
      ended_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    live = await workSession({
      stateRoot,
      wire: { readIdentity: tableReader(table), groupOps: recordingOps(signals) },
      script: program(call("run", { command: "true" })),
    });

    const reaps = await live.work.bootSweep;
    expect(reaps.map((r) => r.run_id).sort()).toEqual(["run-1", "run-2", "run-3", "run-4"]);

    // (1) The pinned orphan: cancelled by its group, and only it was signalled.
    expect(await waitFor(() => !groupAlive(orphan), 3000)).toBe(true);
    expect(signals).toEqual([[orphan, "SIGTERM"]]);
    expect(readEntry(deadRun, `pg-${orphan}.run-1.json`)).toMatchObject({
      state: "finished",
      outcome: "cancelled",
      cancel_reason: "boot_reap",
      cleanup_state: "group_killed",
      output_complete: false,
      reaped_by: { pid: process.pid, signalled: true },
    });

    // (2) A leader whose identity no longer matches: NOT signalled.
    expect(groupAlive(reused)).toBe(true);
    const e2 = readEntry(deadRun, `pg-${reused}.run-2.json`);
    expect(e2).toMatchObject({ outcome: "no_exit_status", cleanup_state: "escaped_or_unverified" });
    expect((e2.reaped_by as { signalled: boolean; note: string }).signalled).toBe(false);

    // (3) A group already gone: no exit status was ever observed.
    expect(readEntry(deadRun, `pg-${gone}.run-3.json`)).toMatchObject({
      outcome: "no_exit_status",
      cleanup_state: "group_empty",
    });

    // (4) A job with no pinned identity (a platform without one): NOT signalled.
    expect(groupAlive(unpinned)).toBe(true);
    const e4 = readEntry(deadRun, `pg-${unpinned}.run-4.json`);
    expect(e4.cleanup_state).toBe("escaped_or_unverified");
    expect((e4.reaped_by as { note: string }).note).toContain("no sub-second identity");

    // The dead run's captures are gone; its records stay (inside retention).
    expect(existsSync(join(deadRun, "out"))).toBe(false);
    expect(existsSync(join(deadRun, "ended.json"))).toBe(true);

    // The live run is untouched.
    expect(groupAlive(liveRunGroup)).toBe(true);
    expect(readEntry(liveRun, `pg-${liveRunGroup}.run-1.json`).state).toBe("running");
    expect(existsSync(join(liveRun, "out", "run-1.log"))).toBe(true);

    // The old ended run is past retention: deleted.
    expect(existsSync(oldRun)).toBe(false);

    const lines = live.logs.filter((l) => l.startsWith("work: boot sweep:"));
    expect(lines.length).toBe(4);
    expect(lines.join("\n")).toContain(`left by bob pid ${dead}`);

    await live.prompt();
    expect(live.results[0].details.outcome).toBe("exited");
  }, 30_000);

  it("a same-second pid reuse (a start differing by one clock tick) is NOT signalled", async () => {
    const stateRoot = scratchState();
    const dead = deadPid();
    const group = startGroup().pid as number;
    // Recorded at spawn: start tick 123456. Now: 123457 — the same wall-clock
    // second, which a 1 s `ps` start time could not tell apart.
    const table = new Map([[group, ident(group, "123457")]]);
    const signals: Array<[number, string]> = [];
    const run = seedRun(stateRoot, "run-reuse1", dead);
    writeJson(
      join(run, "jobs", `pg-${group}.run-1.json`),
      entry("run-1", group, dead, ident(group, "123456")),
    );
    live = await workSession({
      stateRoot,
      wire: { readIdentity: tableReader(table), groupOps: recordingOps(signals) },
      script: program(),
    });
    const [reap] = await live.work.bootSweep;
    expect(signals).toEqual([]);
    expect(groupAlive(group)).toBe(true);
    expect(reap).toMatchObject({ signalled: false, cleanup_state: "escaped_or_unverified" });
    expect(reap.note).toContain("no longer has the identity pinned at spawn");
  }, 20_000);

  it("an identity lost before escalation gets SIGTERM only — no SIGKILL", async () => {
    const stateRoot = scratchState();
    const dead = deadPid();
    // A group that ignores SIGTERM, so only SIGKILL could end it.
    const group = await startTermIgnoringGroup();
    const pinnedId = ident(group, "424242");
    let reads = 0;
    // Matches for the first check and the check before SIGTERM; lost after.
    const reader: IdentityReader = (pid) => {
      if (pid !== group) return "unsupported";
      reads += 1;
      return reads <= 2 ? pinnedId : null;
    };
    const signals: Array<[number, string]> = [];
    const run = seedRun(stateRoot, "run-lost01", dead);
    writeJson(join(run, "jobs", `pg-${group}.run-1.json`), entry("run-1", group, dead, pinnedId));
    live = await workSession({
      stateRoot,
      wire: { readIdentity: reader, groupOps: recordingOps(signals) },
      script: program(),
    });
    const [reap] = await live.work.bootSweep;
    expect(signals).toEqual([[group, "SIGTERM"]]);
    expect(groupAlive(group)).toBe(true);
    expect(reap).toMatchObject({ signalled: true, cleanup_state: "escaped_or_unverified" });
    expect(reap.note).toContain("SIGKILL was NOT sent");
    expect(readEntry(run, `pg-${group}.run-1.json`)).toMatchObject({ escalated: false });
  }, 20_000);

  it("refuses to act on a state directory other users can read", async () => {
    const stateRoot = scratchState();
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

describe("boot sweep — a supervisor pid that now belongs to another process", () => {
  it("sweeps a stale run whose supervisor pid was reused, keeps a live one, and applies retention", async () => {
    const stateRoot = scratchState();
    const foreign = startGroup().pid as number; // a live pid that is not a bob
    const table = new Map([[foreign, ident(foreign, "900")]]);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    // A: this process's own pid, recorded by an EARLIER process (another instance).
    const a = seedRun(stateRoot, "run-reuseA", process.pid, {
      supervisor_instance: "an-earlier-bob",
    });
    // B: a live foreign pid whose identity differs from the recorded supervisor's.
    const b = seedRun(stateRoot, "run-reuseB", foreign, {
      supervisor_identity: ident(foreign, "1"),
    });
    // C: a live foreign pid, no identity on record, heartbeat an hour stale.
    const c = seedRun(stateRoot, "run-staleC", foreign);
    utimesSync(join(c, "run.json"), hourAgo, hourAgo);
    // D: a live foreign pid, no identity on record, heartbeat fresh: left alone.
    const d = seedRun(stateRoot, "run-freshD", foreign);
    // E: an ENDED run past retention whose supervisor still lives: deleted anyway.
    const e = seedRun(stateRoot, "run-endedE", foreign, {
      supervisor_identity: ident(foreign, "900"),
    });
    writeJson(join(e, "ended.json"), { v: 1, ended_at: twoDaysAgo });
    // F: an ENDED run inside retention with a capture left: capture swept, record kept.
    const f = seedRun(stateRoot, "run-endedF", foreign, {
      supervisor_identity: ident(foreign, "900"),
    });
    writeJson(join(f, "ended.json"), { v: 1, ended_at: hourAgo.toISOString() });

    live = await workSession({
      stateRoot,
      wire: { readIdentity: tableReader(table) },
      script: program(),
    });
    await live.work.bootSweep;

    for (const stale of [a, b, c]) {
      expect(existsSync(join(stale, "out")), stale).toBe(false);
      expect(existsSync(join(stale, "ended.json")), stale).toBe(true);
    }
    expect(existsSync(join(d, "out", "run-1.log"))).toBe(true);
    expect(existsSync(join(d, "ended.json"))).toBe(false);
    expect(existsSync(e)).toBe(false);
    expect(existsSync(join(f, "out"))).toBe(false);
    expect(existsSync(join(f, "run.json"))).toBe(true);
    // The foreign process was never signalled by any of this.
    expect(groupAlive(foreign)).toBe(true);
  }, 20_000);
});

// A /proc/<pid>/stat line for `pid` with the given start tick, as Linux writes
// it: "pid (comm) state ppid pgrp session tty tpgid flags … starttime …".
function statLine(pid: number, start: string, state = "S"): string {
  const after = [state, "1", String(pid), String(pid), "0", "-1", "4194304"];
  while (after.length < 19) after.push("0");
  after.push(start, "0", "0");
  return `${pid} (sleep (x)) ${after.join(" ")}\n`;
}

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("boot sweep — an identity that cannot be read", () => {
  it("an unreadable identity (EACCES) for a live supervisor with a fresh heartbeat is 'cannot tell': no signal, no capture deleted", async () => {
    const stateRoot = scratchState();
    const supervisor = startGroup().pid as number; // a live pid standing in for a bob
    const job = startGroup().pid as number; // the live run's pinned job
    const jobStart = "31337";
    // The REAL classification (identityFromProc) over an injected stat read:
    // the supervisor's /proc record fails with EACCES; the job's reads fine.
    const reader: IdentityReader = (pid) =>
      identityFromProc(pid, "test-boot", (path) => {
        if (path === `/proc/${supervisor}/stat`) throw errno("EACCES");
        if (path === `/proc/${job}/stat`) return statLine(job, jobStart);
        throw errno("ENOENT");
      });
    expect(reader(supervisor)).toBe("unreadable");
    const signals: Array<[number, string]> = [];
    // A live run: its supervisor's identity is on record, its heartbeat is fresh.
    const run = seedRun(stateRoot, "run-unread", supervisor, {
      supervisor_identity: ident(supervisor, "4242"),
    });
    writeJson(
      join(run, "jobs", `pg-${job}.run-1.json`),
      entry("run-1", job, supervisor, { boot: "test-boot", start: jobStart, pgid: job, sid: job }),
    );
    live = await workSession({
      stateRoot,
      wire: { readIdentity: reader, groupOps: recordingOps(signals) },
      script: program(),
    });
    expect(await live.work.bootSweep).toEqual([]);
    expect(signals).toEqual([]);
    expect(groupAlive(job)).toBe(true);
    expect(existsSync(join(run, "out", "run-1.log"))).toBe(true);
    expect(existsSync(join(run, "ended.json"))).toBe(false);
    expect(readEntry(run, `pg-${job}.run-1.json`).state).toBe("running");
  }, 20_000);

  it("the stat read's errors: only 'no such process' is gone; anything else is unreadable", () => {
    const read = (e: string) => () => {
      throw errno(e);
    };
    expect(identityFromProc(4321, "b", read("ENOENT"))).toBeNull();
    expect(identityFromProc(4321, "b", read("ESRCH"))).toBeNull();
    for (const code of ["EACCES", "EPERM", "EIO", "EMFILE"]) {
      expect(identityFromProc(4321, "b", read(code)), code).toBe("unreadable");
    }
    // A record that cannot be parsed cannot tell either; a zombie is gone.
    expect(identityFromProc(4321, "b", () => "garbage")).toBe("unreadable");
    expect(identityFromProc(4321, "b", () => statLine(4321, "77", "Z"))).toBeNull();
    // A good record pins start, group and session (comm may hold parens).
    expect(identityFromProc(4321, "b", () => statLine(4321, "77"))).toEqual({
      boot: "b",
      start: "77",
      pgid: 4321,
      sid: 4321,
    });
  });
});

describe("the process identity reader", () => {
  it.skipIf(process.platform !== "linux")(
    "Linux: pins start ticks, process group and session from /proc; a gone pid reads null",
    async () => {
      const c = startGroup();
      const pid = c.pid as number;
      const id = readProcIdentity(pid);
      expect(typeof id).toBe("object");
      const pinned = id as ProcIdentity;
      expect(pinned.pgid).toBe(pid);
      expect(pinned.sid).toBe(pid);
      expect(pinned.start).toMatch(/^\d+$/);
      expect(pinned.boot.length).toBeGreaterThan(0);
      expect(readProcIdentity(pid)).toEqual(pinned);
      process.kill(-pid, "SIGKILL");
      await new Promise((r) => c.once("exit", r));
      expect(await waitFor(() => readProcIdentity(pid) === null, 2000)).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "Linux: the real reader lets the boot sweep reap a pinned orphan",
    async () => {
      const stateRoot = scratchState();
      const dead = deadPid();
      const group = startGroup().pid as number;
      const pinned = readProcIdentity(group) as ProcIdentity;
      const run = seedRun(stateRoot, "run-linux1", dead);
      writeJson(join(run, "jobs", `pg-${group}.run-1.json`), entry("run-1", group, dead, pinned));
      live = await workSession({ stateRoot, script: program() });
      const [reap] = await live.work.bootSweep;
      expect(reap).toMatchObject({ signalled: true, cleanup_state: "group_killed" });
      expect(groupAlive(group)).toBe(false);
    },
  );

  it.skipIf(process.platform === "linux")(
    "elsewhere (no sub-second start time): unsupported, so the boot sweep never signals",
    () => {
      expect(readProcIdentity(process.pid)).toBe("unsupported");
    },
  );
});

describe("run's cwd stays inside the workspace (bob#213)", () => {
  let live: LiveWork | undefined;

  afterEach(() => {
    live?.cleanup();
    live = undefined;
  });

  it("accepts a relative path that resolves inside the workspace", async () => {
    live = await workSession({ script: program() });
    const subDir = join(live.cwd, "sub");
    mkdirSync(subDir);
    const j = await live.work.manager.start({ command: "echo ok", cwd: "sub" }, live.cwd);
    await j.done;
    expect(j.outcome).toBe("exited");
    expect(j.exitCode).toBe(0);
    await live.work.manager.endRun();
  });

   it("accepts a directory whose name starts with dots (e.g. ..cache)", async () => {
     live = await workSession({ script: program() });
     const dotDir = join(live.cwd, "..cache");
     mkdirSync(dotDir);
     const j = await live.work.manager.start({ command: "echo ok", cwd: "..cache" }, live.cwd);
    await j.done;
    expect(j.outcome).toBe("exited");
    expect(j.exitCode).toBe(0);
    await live.work.manager.endRun();
  });

  it("refuses a cwd that escapes outside the workspace", async () => {
    live = await workSession({ script: program() });
    let err: Error | undefined;
    try {
      await live.work.manager.start({ command: "echo out", cwd: ".." }, live.cwd);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect((err as Error).message).toContain("workspace");
    expect((err as Error).message).toContain(live.cwd);
    await live.work.manager.endRun();
  });

  it("refuses a symlink that resolves outside the workspace", async () => {
    live = await workSession({ script: program() });
    const linkPath = join(live.cwd, "outside-link");
    // Create a real directory OUTSIDE the workspace (the target must exist
      // or statSync rejects before the realpath check can trigger).
      const outside = mkdtempSync(join(tmpdir(), "bob-outside-"));
       expect(existsSync(outside)).toBe(true);
      try {
        symlinkSync(outside, linkPath, "dir");
       } catch {
        await live.work.manager.endRun();
        throw new Error("symlink setup failed");
       }
       // The symlink now points outside the workspace; the run tool must refuse.
      let err: Error | undefined;
      try {
        await live.work.manager.start({ command: "echo out", cwd: "outside-link" }, live.cwd);
       } catch (e) {
        err = e as Error;
       }
      expect(err).toBeDefined();
       expect((err as Error).message).toContain("workspace");
      expect((err as Error).message).toContain(live.cwd);
      await live.work.manager.endRun();
});
});
