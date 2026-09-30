// The managed run tool (bob#211) — acceptance through the REAL pi/bob wiring.
//
// Every test here builds a real pi session through bob's one session factory
// and pi's session runtime (helpers.ts), loads the work capability through pi's
// extension loader, and drives run / run_status / run_cancel from a scripted
// model — so each call passes pi's registration, argument validation and agent
// loop, and bob's tool policy and audit. The commands are real processes.
//
// Only processes the tool started (or, for the "signal from outside" case, the
// leader of a group the tool started) are ever signalled, by pid/pgid.

import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  type DirPinOps,
  type DirStat,
  NODE_DIR_PIN_OPS,
  RunRefusal,
} from "../../../src/capabilities/work/run.js";
import { groupAlive, type LiveWork, WIRE_HOOK, waitFor, workSession } from "./helpers.js";
import { call, callWith, effect, lastOf, pause, pollUntilFinished, program } from "./program.js";

let live: LiveWork | undefined;
afterEach(async () => {
  await live?.cleanup();
  live = undefined;
});

const nonce = () => Math.random().toString(36).slice(2, 10);

function registryEntries(stateRoot: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const run of readdirSync(stateRoot)) {
    const jobs = join(stateRoot, run, "jobs");
    if (!existsSync(jobs)) continue;
    for (const f of readdirSync(jobs)) {
      if (f.endsWith(".json")) out.push(JSON.parse(readFileSync(join(jobs, f), "utf8")));
    }
  }
  return out;
}

describe("run — the deadline is never absent", () => {
  it("an omitted timeout gets the default, and the registry records that deadline", async () => {
    live = await workSession({ script: program(call("run", { command: "true" })) });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.isError).toBe(false);
    expect(r.details.effective_timeout_s).toBe(600);
    expect(r.details.timeout_source).toBe("default");
    expect(r.text).toContain("600 s (default)");
    const [entry] = registryEntries(live.stateRoot);
    const span = Date.parse(String(entry.deadline_at)) - Date.parse(String(entry.started_at));
    expect(span).toBe(600_000);
    expect(entry.timeout_s).toBe(600);
  }, 20_000);

  it("the default is ENFORCED: a command with no timeout_s is stopped at the default deadline", async () => {
    // The default shortened to 1 s through the seam, so the enforcement is observable.
    live = await workSession({
      wire: { defaultTimeoutS: 1 },
      script: program(call("run", { command: "sleep 6" })),
    });
    const started = Date.now();
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.details.outcome).toBe("timed_out");
    expect(r.details.effective_timeout_s).toBe(1);
    expect(r.details.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it("an invalid timeout is refused by name, and nothing starts", async () => {
    live = await workSession({
      script: program(
        call("run", { command: "true", timeout_s: 0 }),
        call("run", { command: "true", timeout_s: -5 }),
        call("run", { command: "true", timeout_s: "soon" }),
      ),
    });
    await live.prompt();
    const [zero, negative, word] = live.results;
    for (const r of [zero, negative]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("run refused: timeout_s must be a number of seconds greater than 0");
      expect(r.text).toContain("Omit timeout_s for the 600 s default");
    }
    // Non-numeric: pi's schema validation refuses it before the tool runs,
    // naming the field.
    expect(word.isError).toBe(true);
    expect(word.text).toContain("timeout_s");
    expect(live.work.manager.list()).toEqual([]);
  }, 20_000);

  it("a request above the hard maximum is capped, and says so", async () => {
    live = await workSession({
      script: program(call("run", { command: "true", timeout_s: 99999 })),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.details.effective_timeout_s).toBe(3600);
    expect(r.details.timeout_source).toBe("clamped");
    expect(r.text).toContain("capped at the 3600 s maximum");
  }, 20_000);
});

describe("run — honest outcomes", () => {
  it("exit 0 with a clean group is the only success", async () => {
    live = await workSession({
      script: program(call("run", { command: "echo hello" }), call("run", { command: "exit 3" })),
    });
    await live.prompt();
    const [ok, fail] = live.results;
    expect(ok.details).toMatchObject({
      outcome: "exited",
      exit_code: 0,
      cleanup_state: "group_empty",
      success: true,
      output_complete: true,
    });
    expect(ok.text).toContain("hello");
    expect(fail.details).toMatchObject({ outcome: "exited", exit_code: 3, success: false });
  }, 20_000);

  it("a command that ignores SIGTERM is escalated to SIGKILL and reported timed_out with the flag", async () => {
    live = await workSession({
      script: program(call("run", { command: "trap '' TERM; sleep 30", timeout_s: 1 })),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.details).toMatchObject({
      outcome: "timed_out",
      escalated: true,
      signal: "SIGKILL",
      cleanup_state: "group_killed",
      success: false,
    });
    expect(r.text).toContain("escalated to SIGKILL");
    expect(groupAlive(Number(r.details.pgid))).toBe(false);
  }, 20_000);

  it("a deadline that SIGTERM satisfies is timed_out WITHOUT the escalation flag", async () => {
    live = await workSession({
      script: program(call("run", { command: "sleep 30", timeout_s: 1 })),
    });
    await live.prompt();
    expect(lastOf(live.results, "run").details).toMatchObject({
      outcome: "timed_out",
      escalated: false,
      signal: "SIGTERM",
      cleanup_state: "group_killed",
    });
  }, 20_000);

  it("a signal from outside the deadline is reported as signalled", async () => {
    let pgid = 0;
    live = await workSession({
      script: program(
        call("run", { command: "sleep 30", background: true }),
        effect((r) => {
          pgid = Number(lastOf(r, "run").details.pgid);
          // The job's leader (pid == pgid), a process the tool started.
          process.kill(pgid, "SIGTERM");
        }),
        pollUntilFinished("run-1"),
      ),
    });
    await live.prompt();
    const r = lastOf(live.results, "run_status");
    expect(r.details).toMatchObject({
      outcome: "signalled",
      signal: "SIGTERM",
      exit_code: null,
      success: false,
    });
    expect(r.text).toContain("ended by signal SIGTERM from outside the deadline");
  }, 20_000);

  it("a missing exit status is reported as no_exit_status, never success", async () => {
    live = await workSession({
      // The OS report rewritten to carry neither a code nor a signal.
      wire: { observeExit: () => ({ code: null, signal: null }) },
      script: program(call("run", { command: "true" })),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.details).toMatchObject({ outcome: "no_exit_status", success: false });
    expect(r.text).toContain("NO exit status");
  }, 20_000);
});

describe("run — output", () => {
  it("large output: a truncated excerpt, the full capture on disk, output_complete honest", async () => {
    live = await workSession({ script: program(call("run", { command: "seq 1 300000" })) });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.details.output_complete).toBe(true);
    expect(r.details.output_excerpt_truncated).toBe(true);
    const excerpt = String(r.details.output_excerpt);
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(16 * 1024);
    expect(excerpt.trimEnd().endsWith("300000")).toBe(true);
    expect(excerpt).not.toContain("\n1\n");
    // The capture holds every byte (read before the run ends deletes it).
    const ref = String(r.details.output_ref);
    const full = readFileSync(ref, "utf8");
    expect(full.split("\n").filter(Boolean).length).toBe(300000);
    expect(r.details.output_bytes).toBe(statSync(ref).size);
    expect(r.text).toContain("excerpt is the tail only");
  }, 30_000);

  it("a capture cut short says so: output_complete false and the dropped bytes counted", async () => {
    live = await workSession({
      wire: { captureMaxBytes: 50_000 },
      script: program(call("run", { command: "seq 1 100000" })),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.details.output_complete).toBe(false);
    expect(Number(r.details.output_dropped_bytes)).toBeGreaterThan(0);
    expect(r.details.output_bytes).toBe(50_000);
    expect(r.text).toContain("not captured");
    // The command itself succeeded; the capture's honesty is a separate field.
    expect(r.details.outcome).toBe("exited");
  }, 30_000);

  it("the excerpt is redacted; the raw secret stays in the local capture only", async () => {
    const token = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    live = await workSession({
      script: program(
        call("run", {
          command: `echo "GITHUB_TOKEN=${token}"; echo "Authorization: Bearer abcdefgh12345678"; echo visible-line`,
        }),
      ),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.text).not.toContain(token);
    expect(r.text).not.toContain("abcdefgh12345678");
    expect(JSON.stringify(r.details)).not.toContain(token);
    expect(r.text).toContain("[redacted]");
    expect(r.text).toContain("visible-line");
    expect(Number(r.details.redactions)).toBeGreaterThanOrEqual(2);
    expect(readFileSync(String(r.details.output_ref), "utf8")).toContain(token);
  }, 20_000);

  it("a secret cut exactly at the capture cap never reaches the model", async () => {
    const token = `ghp_${"Q1w2E3r4T5".repeat(4)}`;
    // The cap falls 14 characters into the token: "safe line\n" + "ghp_" + 14.
    const cap = Buffer.byteLength("safe line\n") + 4 + 14;
    live = await workSession({
      wire: { captureMaxBytes: cap },
      script: program(call("run", { command: `printf 'safe line\\n${token}\\nafter\\n'` })),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.details.output_bytes).toBe(cap);
    expect(r.details.output_complete).toBe(false);
    expect(r.details.output_tail_withheld_bytes).toBe(18);
    expect(r.details.output_excerpt).toBe("safe line\n");
    // No piece of the token — not even the unrecognizable 14-character stub.
    expect(r.text).not.toContain("ghp_");
    expect(r.text).not.toContain(token.slice(4, 18));
    expect(r.text).toContain("withheld until the capture is complete");
    // The command itself still succeeded; the capture is what was cut.
    expect(r.details.outcome).toBe("exited");
  }, 20_000);

  it("Authorization header values are redacted whatever the scheme", async () => {
    live = await workSession({
      script: program(
        call("run", {
          command:
            "echo 'Authorization: Basic dXNlcjpwYXNz'; echo 'authorization: Token t0k3nvalue'; echo 'Authorization:         Basic sp4cedsecret'; echo 'Authorization: [redacted], nonce=\"n0ncesecret\"'",
        }),
      ),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.text).not.toContain("dXNlcjpwYXNz");
    expect(r.text).not.toContain("t0k3nvalue");
    expect(r.text).not.toContain("sp4cedsecret");
    expect(r.text).not.toContain("n0ncesecret");
    expect(r.text).toContain("Authorization: [redacted]");
    expect(r.details.redactions).toBe(4);
  }, 20_000);

  it("a quoted Digest header and a long Basic value are redacted whole in the run result", async () => {
    const digest = `Authorization: Digest username="alice", realm="example.org", nonce="secret123", uri="/api", response="6629fae49393a05397450978507c4ef1"`;
    const longBasic = `Authorization: Basic ${"a1.b2-".repeat(1200)}tail-secret-9`;
    live = await workSession({
      script: program(
        call("run", { command: `printf '%s\\n' '${digest}' '${longBasic}' 'after'` }),
      ),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    for (const leaked of [
      "alice",
      "example.org",
      "secret123",
      "6629fae4",
      "a1.b2-",
      "tail-secret",
    ]) {
      expect(r.text, leaked).not.toContain(leaked);
      expect(JSON.stringify(r.details), leaked).not.toContain(leaked);
    }
    expect(r.details.output_excerpt).toBe(
      "Authorization: [redacted]\nAuthorization: [redacted]\nafter\n",
    );
    expect(r.details.redactions).toBe(2);
  }, 20_000);

  it("a running job's unterminated final line is withheld until its capture completes", async () => {
    live = await workSession({
      script: program(
        call("run", { command: "printf 'done-line\\npartial'; sleep 30", background: true }),
        pause(400),
        call("run_status", { run_id: "run-1" }),
      ),
    });
    await live.prompt();
    const s = lastOf(live.results, "run_status");
    expect(s.details.state).toBe("running");
    expect(s.details.output_excerpt).toBe("done-line\n");
    expect(s.details.output_tail_withheld_bytes).toBe(7);
    expect(s.text).not.toContain("partial");
  }, 20_000);

  it("a capture removed after completion is reported missing, never complete", async () => {
    live = await workSession({
      script: program(
        call("run", { command: "echo hello" }),
        effect((r) => {
          unlinkSync(String(lastOf(r, "run").details.output_ref));
        }),
        call("run_status", { run_id: "run-1" }),
      ),
    });
    await live.prompt();
    const [ran, status] = live.results;
    expect(ran.details.output_complete).toBe(true);
    expect(status.details).toMatchObject({
      output_missing: true,
      output_complete: false,
      output_excerpt: "",
      outcome: "exited",
    });
    expect(status.text).toContain("the capture file is GONE");
  }, 20_000);

  it("the capture lives in an owner-only directory outside the workspace", async () => {
    live = await workSession({ script: program(call("run", { command: "echo x" })) });
    await live.prompt();
    const ref = String(lastOf(live.results, "run").details.output_ref);
    expect(ref.startsWith(live.stateRoot)).toBe(true);
    expect(ref.startsWith(live.cwd)).toBe(false);
    expect(statSync(ref).mode & 0o777).toBe(0o600);
    expect(statSync(join(ref, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(join(ref, "..", "..")).mode & 0o777).toBe(0o700);
    expect(statSync(live.stateRoot).mode & 0o777).toBe(0o700);
    // No stray file in the workspace.
    expect(readdirSync(live.cwd)).toEqual([]);
  }, 20_000);
});

describe("run — a failed first record write terminates the job", () => {
  it("a failed first registry write terminates the job and verifies no process from it remains", async () => {
    let failed = false;
    live = await workSession({
      wire: {
        // The first write of a JOB record fails once, as a full disk would.
        writeRecord: (path, value) => {
          if (!failed && path.includes(`${sep}jobs${sep}pg-`)) {
            failed = true;
            const err = new Error("no space left on device") as NodeJS.ErrnoException;
            err.code = "ENOSPC";
            throw err;
          }
          writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
        },
      },
      script: program(
        // A command that ignores SIGTERM once its trap is set: stopping it may
        // need the full escalation (the write fails microseconds after spawn,
        // so the trap may or may not be in place yet).
        call("run", { command: "trap '' TERM; sleep 30 & wait", background: true }),
        call("run_status", {}),
        call("run", { command: "echo recovered" }),
      ),
    });
    await live.prompt();
    const [refused, list, next] = live.results;
    expect(refused.isError).toBe(true);
    const m = /process group (\d+)/.exec(refused.text);
    expect(m).not.toBeNull();
    const pgid = Number(m?.[1]);
    try {
      expect(refused.text).toContain(
        "could not be written (ENOSPC) right after the job started, so termination was attempted (SIGTERM to its process group only if a first membership probe found members it may signal, then SIGKILL attempted if no probe reported the group empty during a grace)",
      );
      expect(refused.text).toContain("nothing from it is left running");
      // No process from that job remains.
      expect(groupAlive(pgid)).toBe(false);
      // It is not an owned job, and the next job runs normally.
      expect(list.text).toContain("This bob run has started no jobs");
      expect(next.details).toMatchObject({ outcome: "exited", success: true });
    } finally {
      // If a regression left the job's group running, end it: a group id still
      // in use cannot have been reused, so this is the tool's own job.
      if (groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
    }
  }, 20_000);
});

describe("run — private run directory, exclusive capture files", () => {
  it("the run directory is a fresh mkdtemp directory (0700, unpredictable name); captures are 0600", async () => {
    live = await workSession({
      script: program(call("run", { command: "echo a" }), call("run", { command: "echo b" })),
    });
    await live.prompt();
    const runDir = String(live.work.manager.runDir);
    // mkdtemp's shape: the prefix and random characters only — no pid, no
    // timestamp, nothing a process could predict and pre-create.
    expect(basename(runDir)).toMatch(/^run-[A-Za-z0-9]{6}$/);
    expect(basename(runDir)).not.toContain(String(process.pid));
    expect(join(runDir, "..")).toBe(live.stateRoot);
    for (const dir of [live.stateRoot, runDir, join(runDir, "out"), join(runDir, "jobs")]) {
      const st = lstatSync(dir);
      expect(st.isDirectory() && !st.isSymbolicLink(), dir).toBe(true);
      expect(st.mode & 0o777, dir).toBe(0o700);
    }
    for (const r of live.results) {
      const ref = String(r.details.output_ref);
      expect(join(ref, "..")).toBe(join(runDir, "out"));
      expect(lstatSync(ref).isFile()).toBe(true);
      expect(lstatSync(ref).mode & 0o777).toBe(0o600);
    }
    for (const f of readdirSync(join(runDir, "jobs"))) {
      expect(lstatSync(join(runDir, "jobs", f)).mode & 0o777, f).toBe(0o600);
    }
  }, 20_000);

  it("a symlink or a file already at a capture path is never written through", async () => {
    let victim = "";
    let planted = "";
    const outDir = () => join(String(live?.work.manager.runDir), "out");
    live = await workSession({
      script: program(
        call("run", { command: "echo first" }),
        effect(() => {
          // A symlink at the NEXT capture path, pointing at a file outside.
          victim = join(String(live?.scratch), "victim.txt");
          writeFileSync(victim, "victim: untouched\n");
          symlinkSync(victim, join(outDir(), "run-2.log"));
        }),
        call("run", { command: "echo THROUGH-THE-SYMLINK" }),
        effect(() => {
          // A plain file at the capture path after that.
          planted = join(outDir(), "run-3.log");
          writeFileSync(planted, "planted: untouched\n");
        }),
        call("run", { command: "echo INTO-THE-FILE" }),
        call("run", { command: "echo after" }),
      ),
    });
    await live.prompt();
    const [first, viaLink, viaFile, after] = live.results;
    expect(first.details.outcome).toBe("exited");
    for (const r of [viaLink, viaFile]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("could not be created exclusively (EEXIST)");
      expect(r.text).toContain("something already occupies that path");
      expect(r.text).toContain("Nothing was started, and nothing was written through it");
    }
    // Nothing was written through either entry, and neither was replaced.
    expect(readFileSync(victim, "utf8")).toBe("victim: untouched\n");
    expect(lstatSync(join(outDir(), "run-2.log")).isSymbolicLink()).toBe(true);
    expect(readFileSync(planted, "utf8")).toBe("planted: untouched\n");
    // The refused calls started no job; the next call works on a fresh path.
    expect(after.details).toMatchObject({ run_id: "run-4", outcome: "exited", success: true });
    expect(live.work.manager.list().map((j) => j.runId)).toEqual(["run-1", "run-4"]);
  }, 20_000);
});

// A command whose descendant leaves the job's process group (setsid via a
// detached spawn) while keeping the job's stdout pipe open for 8 s. It prints
// the escapee's pid so the test can end it (a process the test's command
// started). A runner that drained until EOF would wait those 8 s.
function escapeeCommand(then: string): string {
  const js = `const c=require("child_process").spawn("sleep",["8"],{detached:true,stdio:"inherit"});console.log("ESCAPEE "+c.pid);c.unref();`;
  return `"${process.execPath}" -e '${js}'; ${then}`;
}

function killEscapee(text: string): void {
  const m = /ESCAPEE (\d+)/.exec(text);
  if (!m) return;
  try {
    process.kill(Number(m[1]), "SIGKILL");
  } catch {
    // already gone
  }
}

describe("run — a descendant that escapes the group", () => {
  it("the deadline still fires, draining stops at a bound (no hang), and cleanup is NOT clean", async () => {
    live = await workSession({
      script: program(call("run", { command: escapeeCommand("sleep 30"), timeout_s: 1 })),
    });
    const started = Date.now();
    await live.prompt();
    const r = lastOf(live.results, "run");
    killEscapee(String(r.details.output_excerpt));
    expect(Date.now() - started).toBeLessThan(6000);
    expect(r.details.outcome).toBe("timed_out");
    expect(r.details.cleanup_state).toBe("escaped_or_unverified");
    expect(r.details.output_complete).toBe(false);
    expect(r.details.success).toBe(false);
  }, 15_000);

  it("a clean exit 0 whose escapee still holds the pipe is NOT a success", async () => {
    live = await workSession({
      script: program(call("run", { command: escapeeCommand("exit 0") })),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    killEscapee(String(r.details.output_excerpt));
    expect(r.details).toMatchObject({
      outcome: "exited",
      exit_code: 0,
      cleanup_state: "escaped_or_unverified",
      output_complete: false,
      success: false,
    });
  }, 15_000);

  it("what the command left inside its own group is ended and reported group_killed", async () => {
    live = await workSession({ script: program(call("run", { command: "sleep 30 & exit 0" })) });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.details).toMatchObject({
      outcome: "exited",
      exit_code: 0,
      cleanup_state: "group_killed",
      success: true,
    });
    expect(groupAlive(Number(r.details.pgid))).toBe(false);
  }, 15_000);
});

describe("run — background jobs and owned cancellation", () => {
  it("cancelling one background job leaves its sibling and the bob process alive", async () => {
    // The SAME command line twice: only the recorded process group tells them apart.
    const command = `sleep 30 # sibling-${nonce()}`;
    live = await workSession({
      script: program(
        call("run", { command, background: true }),
        call("run", { command, background: true }),
        call("run_cancel", { run_id: "run-1" }),
        call("run_status", { run_id: "run-2" }),
      ),
    });
    await live.prompt();
    const [first, second, cancel, status] = live.results;
    expect(first.details.background).toBe(true);
    expect(first.text).toContain("started in the background");
    const pgid1 = Number(first.details.pgid);
    const pgid2 = Number(second.details.pgid);
    expect(cancel.details).toMatchObject({
      run_id: "run-1",
      outcome: "cancelled",
      cleanup_state: "group_killed",
      cancel: "cancelled",
      success: false,
    });
    expect(groupAlive(pgid1)).toBe(false);
    // The sibling with the identical command line is untouched.
    expect(status.details.state).toBe("running");
    expect(groupAlive(pgid2)).toBe(true);
    // And the bob process (this test process hosts the session) is alive.
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  }, 20_000);

  it("run_status with no run_id lists every job this run owns", async () => {
    live = await workSession({
      script: program(
        call("run", { command: "true" }),
        call("run", { command: "sleep 30", background: true }),
        call("run_status", {}),
      ),
    });
    await live.prompt();
    const list = lastOf(live.results, "run_status");
    expect(list.text).toContain("This bob run owns 2 jobs");
    expect(list.text).toContain("run-1");
    expect(list.text).toContain("run-2: running");
    expect((list.details.jobs as unknown[]).length).toBe(2);
  }, 20_000);

  it("ending the run cancels every job it still owns and logs each cleanup", async () => {
    live = await workSession({
      script: program(
        call("run", { command: "sleep 30", background: true }),
        call("run", { command: "trap '' TERM; sleep 30", background: true }),
      ),
    });
    await live.prompt();
    const pgids = live.results.map((r) => Number(r.details.pgid));
    for (const p of pgids) expect(groupAlive(p)).toBe(true);
    const runDir = String(live.work.manager.runDir);
    expect(existsSync(runDir)).toBe(true);
    // End the run the way pi ends one: session_shutdown, then dispose.
    await live.runtime.dispose();
    for (const p of pgids) expect(await waitFor(() => !groupAlive(p), 3000)).toBe(true);
    const entries = registryEntries(live.stateRoot);
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect(e).toMatchObject({
        state: "finished",
        outcome: "cancelled",
        cancel_reason: "run_end",
        cleanup_state: "group_killed",
      });
    }
    expect(live.logs.filter((l) => l.startsWith("work: run end:")).length).toBe(2);
    // The captures are deleted at run end; the small job records stay.
    expect(existsSync(join(runDir, "out"))).toBe(false);
    expect(existsSync(join(runDir, "ended.json"))).toBe(true);
  }, 20_000);

  it("an unknown run_id is a named error for run_status and run_cancel", async () => {
    live = await workSession({
      script: program(
        call("run_status", { run_id: "run-99" }),
        call("run", { command: "true" }),
        call("run_cancel", { run_id: "run-99" }),
      ),
    });
    await live.prompt();
    const [status, , cancel] = live.results;
    expect(status.isError).toBe(true);
    expect(status.text).toContain('run_status refused: no job "run-99" in this bob run');
    expect(status.text).toContain("This run has started no jobs");
    expect(cancel.isError).toBe(true);
    expect(cancel.text).toContain('run_cancel refused: no job "run-99" in this bob run');
    expect(cancel.text).toContain("This run owns run-1");
  }, 20_000);

  it("a cancel that races a job which already exited reports the real outcome, never cancelled", async () => {
    live = await workSession({
      script: program(
        call("run", { command: "exit 0", background: true }),
        pollUntilFinished("run-1"),
        call("run_cancel", { run_id: "run-1" }),
      ),
    });
    await live.prompt();
    const cancel = lastOf(live.results, "run_cancel");
    expect(cancel.details).toMatchObject({
      outcome: "exited",
      exit_code: 0,
      cancel: "already_finished",
      success: true,
    });
    expect(cancel.text).toContain("had already finished before the cancel");
    expect(cancel.text).not.toContain("CANCELLED");
  }, 20_000);

  it("a second cancel is idempotent and says so", async () => {
    live = await workSession({
      script: program(
        call("run", { command: "sleep 30", background: true }),
        call("run_cancel", { run_id: "run-1" }),
        call("run_cancel", { run_id: "run-1" }),
      ),
    });
    await live.prompt();
    const [, first, second] = live.results;
    expect(first.details).toMatchObject({ outcome: "cancelled", cancel: "cancelled" });
    expect(second.details).toMatchObject({
      outcome: "cancelled",
      cancel: "already_cancelled",
      idempotent: true,
      cleanup_state: first.details.cleanup_state,
    });
    expect(second.text).toContain("already cancelled; this cancel changed nothing");
  }, 20_000);

  it("a background job gets the deadline too", async () => {
    live = await workSession({
      script: program(
        call("run", { command: "sleep 30", background: true, timeout_s: 1 }),
        pause(1200),
        pollUntilFinished("run-1"),
      ),
    });
    await live.prompt();
    expect(lastOf(live.results, "run_status").details).toMatchObject({
      outcome: "timed_out",
      cleanup_state: "group_killed",
    });
  }, 20_000);

  it("run_status on a running job shows its output so far and says it is running", async () => {
    live = await workSession({
      script: program(
        call("run", { command: "echo first-line; sleep 30", background: true }),
        pause(300),
        callWith("run_status", () => ({ run_id: "run-1" })),
      ),
    });
    await live.prompt();
    const s = lastOf(live.results, "run_status");
    expect(s.details.state).toBe("running");
    expect(s.details.outcome).toBe(null);
    expect(s.details.output_complete).toBe(false);
    expect(s.text).toContain("first-line");
    expect(s.text).toContain("running in the background");
  }, 20_000);
});

describe("run — refusals name actor, state and remedy", () => {
  it("a cwd that does not exist is refused with the resolved path", async () => {
    live = await workSession({ script: program(call("run", { command: "true", cwd: "nope" })) });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.isError).toBe(true);
    expect(r.text).toContain('run refused: cwd "nope"');
    expect(r.text).toContain("is not an existing directory");
  }, 20_000);

  it("more live jobs than the limit are refused, naming the running ones", async () => {
    live = await workSession({
      wire: { maxLiveJobs: 1 },
      script: program(
        call("run", { command: "sleep 30", background: true }),
        call("run", { command: "true" }),
      ),
    });
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("run refused: this run already has 1 running job (run-1)");
    expect(r.text).toContain("run_cancel");
  }, 20_000);
});

describe("run — the cwd is pinned and re-checked before the spawn (bob#224)", () => {
  // Every cwd and pin refusal test here runs a command that writes a MARKER
  // outside the workspace by absolute path: had the command started anywhere —
  // registered as a job or not — the marker would exist. An empty job list alone
  // would not prove that. (The live-job-limit test runs `sleep` instead and
  // checks the registration and the limit's refusal.)
  function marker(): { file: string; command: string } {
    const dir = join((live as LiveWork).scratch, "marker");
    mkdirSync(dir);
    const file = join(dir, "ran");
    return { file, command: `touch '${file}'` };
  }
  async function expectNothingStarted(file: string): Promise<void> {
    const w = live as LiveWork;
    expect(await waitFor(() => existsSync(file), 500)).toBe(false);
    expect(w.work.manager.list()).toEqual([]);
    // The capture file made for the refused job is gone too.
    const runDir = w.work.manager.runDir;
    if (runDir !== null) expect(readdirSync(join(runDir, "out"))).toEqual([]);
  }
  async function refusalOf(p: Promise<unknown>): Promise<Error> {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(RunRefusal);
      return err as Error;
    }
    throw new Error("expected run to refuse, but it started a job");
  }
  const failure = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
  // A directory OUTSIDE the workspace: a sibling of it in the session's scratch
  // directory, removed with the session.
  function outsideDir(name = "outside"): string {
    const dir = join((live as LiveWork).scratch, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("refuses when the checked cwd is replaced by a symlink to an outside dir after the pin (through the tool)", async () => {
    let outside = "";
    let m = { file: "", command: "" };
    live = await workSession({
      wire: {
        beforeSpawn: (cwd) => {
          rmSync(cwd, { recursive: true, force: true });
          symlinkSync(outside, cwd);
        },
      },
      script: program(callWith("run", () => ({ command: m.command, cwd: "sub" }))),
    });
    outside = outsideDir();
    m = marker();
    mkdirSync(join(live.cwd, "sub"));
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("now resolves outside the workspace");
    expect(r.text).toContain("immediately before the spawn");
    expect(r.text).toContain("Nothing was started");
    await expectNothingStarted(m.file);
  }, 20_000);

  it("(a) refuses when an INTERMEDIATE path component is replaced by a symlink after the pin", async () => {
    let outside = "";
    live = await workSession({
      script: program(),
      wire: {
        // Move the directory holding the pinned one outside, and link to it:
        // the pinned directory (same device + inode) is now reached through a
        // symlinked parent, outside the workspace.
        beforeSpawn: () => {
          const ws = (live as LiveWork).cwd;
          renameSync(join(ws, "a"), join(outside, "a"));
          symlinkSync(join(outside, "a"), join(ws, "a"), "dir");
        },
      },
    });
    outside = outsideDir();
    const m = marker();
    mkdirSync(join(live.cwd, "a", "b"), { recursive: true });
    const err = await refusalOf(
      live.work.manager.start({ command: m.command, cwd: "a/b" }, live.cwd),
    );
    expect(err.message).toContain("now resolves outside the workspace");
    expect(err.message).toContain(`(to ${realpathSync(join(outside, "a", "b"))})`);
    expect(err.message).toContain("immediately before the spawn");
    await expectNothingStarted(m.file);
  }, 20_000);

  it("(b) refuses when the pinned directory is moved outside and linked to", async () => {
    let outside = "";
    live = await workSession({
      script: program(),
      wire: {
        beforeSpawn: () => {
          const ws = (live as LiveWork).cwd;
          renameSync(join(ws, "sub"), join(outside, "sub"));
          symlinkSync(join(outside, "sub"), join(ws, "sub"), "dir");
        },
      },
    });
    outside = outsideDir();
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    const err = await refusalOf(
      live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
    );
    expect(err.message).toContain("now resolves outside the workspace");
    expect(err.message).toContain("immediately before the spawn");
    await expectNothingStarted(m.file);
  }, 20_000);

  it("(c) refuses when an INTERMEDIATE component is replaced by a symlink to another directory INSIDE the workspace, after the pin", async () => {
    live = await workSession({
      script: program(),
      wire: {
        // Move the pinned directory's parent elsewhere INSIDE the workspace and
        // link to it from the old name. The path still leads to the pinned
        // directory (same device + inode) and still resolves inside the
        // workspace, but to a different canonical path: only the canonical-path
        // comparison can refuse it.
        beforeSpawn: () => {
          const ws = (live as LiveWork).cwd;
          renameSync(join(ws, "a"), join(ws, "c"));
          symlinkSync(join(ws, "c"), join(ws, "a"), "dir");
        },
      },
    });
    const m = marker();
    mkdirSync(join(live.cwd, "a", "b"), { recursive: true });
    const err = await refusalOf(
      live.work.manager.start({ command: m.command, cwd: "a/b" }, live.cwd),
    );
    expect(err.message).toContain(`now resolves to ${realpathSync(join(live.cwd, "c", "b"))}`);
    expect(err.message).toContain(
      "immediately before the spawn, not to the canonical path that was checked",
    );
    await expectNothingStarted(m.file);
  }, 20_000);

  it("refuses when the cwd is replaced by ANOTHER directory inside the workspace after the pin", async () => {
    live = await workSession({
      script: program(),
      wire: {
        beforeSpawn: () => {
          const ws = (live as LiveWork).cwd;
          renameSync(join(ws, "sub"), join(ws, "sub-old"));
          mkdirSync(join(ws, "sub"));
        },
      },
    });
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    const err = await refusalOf(
      live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
    );
    expect(err.message).toContain("does not match its pin immediately before the spawn");
    expect(err.message).toContain("not a directory with the pinned device and inode");
    await expectNothingStarted(m.file);
  }, 20_000);

  // 64-bit identities: two values that are EQUAL as numbers (2^60 and 2^60 + 1
  // round to the same double) but DIFFERENT as bigints.
  const BIG_PINNED = 2n ** 60n;
  const BIG_OTHER = 2n ** 60n + 1n;
  // A stat seam that reports `value` as the directory's `field`, keeping the
  // real value of the other field.
  const withField = (real: DirStat, field: "dev" | "ino", value: bigint): DirStat => ({
    dev: field === "dev" ? value : real.dev,
    ino: field === "ino" ? value : real.ino,
    isDirectory: () => real.isDirectory(),
  });

  for (const field of ["dev", "ino"] as const) {
    it(`refuses a pin whose ${field} differs only beyond Number precision (${field} is compared as a 64-bit value)`, async () => {
      // The premise: as numbers these values are equal; as bigints they are not.
      expect(Number(BIG_PINNED)).toBe(Number(BIG_OTHER));
      expect(BIG_PINNED === BIG_OTHER).toBe(false);
      const dirPinOps: DirPinOps = {
        ...NODE_DIR_PIN_OPS,
        fstat: (fd) => withField(NODE_DIR_PIN_OPS.fstat(fd), field, BIG_PINNED),
        lstat: (p) => withField(NODE_DIR_PIN_OPS.lstat(p), field, BIG_OTHER),
      };
      live = await workSession({ script: program(), wire: { dirPinOps } });
      const m = marker();
      mkdirSync(join(live.cwd, "sub"));
      const err = await refusalOf(
        live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
      );
      expect(err.message).toContain("does not match its pin when it was pinned");
      expect(err.message).toContain("not a directory with the pinned device and inode");
      await expectNothingStarted(m.file);
    }, 20_000);
  }

  it("a pin whose 64-bit inode matches exactly still runs (the positive control)", async () => {
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      fstat: (fd) => withField(NODE_DIR_PIN_OPS.fstat(fd), "ino", BIG_PINNED),
      lstat: (p) => withField(NODE_DIR_PIN_OPS.lstat(p), "ino", BIG_PINNED),
    };
    live = await workSession({ script: program(), wire: { dirPinOps } });
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    const job = await live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd);
    await job.done;
    expect(job.outcome).toBe("exited");
    expect(job.exitCode).toBe(0);
    expect(existsSync(m.file)).toBe(true);
    await live.work.manager.endRun();
  }, 20_000);

  it("refuses when an intermediate component is swapped BEFORE the pin opens (the pin is verified as it is taken)", async () => {
    let outside = "";
    live = await workSession({
      script: program(),
      wire: {
        // The pin's open follows the swapped parent into an outside decoy.
        beforePin: () => {
          const w = live as LiveWork;
          renameSync(join(w.cwd, "a"), join(w.scratch, "stash-a"));
          symlinkSync(join(outside, "decoy"), join(w.cwd, "a"), "dir");
        },
      },
    });
    outside = outsideDir();
    mkdirSync(join(outside, "decoy", "b"), { recursive: true });
    const m = marker();
    mkdirSync(join(live.cwd, "a", "b"), { recursive: true });
    const err = await refusalOf(
      live.work.manager.start({ command: m.command, cwd: "a/b" }, live.cwd),
    );
    expect(err.message).toContain("now resolves outside the workspace");
    expect(err.message).toContain("when it was pinned");
    await expectNothingStarted(m.file);
  }, 20_000);

  it("a realpath that FAILS immediately before the spawn refuses (unknown is not inside)", async () => {
    let armed = false;
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      realpath: (p) => {
        if (armed) throw failure("EIO");
        return NODE_DIR_PIN_OPS.realpath(p);
      },
    };
    live = await workSession({
      script: program(),
      wire: {
        dirPinOps,
        beforeSpawn: () => {
          armed = true;
        },
      },
    });
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    const err = await refusalOf(
      live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
    );
    expect(err.message).toContain("could not be re-resolved immediately before the spawn (EIO)");
    // An EIO establishes neither a removal nor a replacement: no cause is claimed.
    expect(err.message).toContain("resolving it failed");
    expect(err.message).not.toMatch(/removed|replaced/);
    await expectNothingStarted(m.file);
  }, 20_000);

  it("a no-follow stat that FAILS immediately before the spawn refuses", async () => {
    let armed = false;
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      lstat: (p) => {
        if (armed) throw failure("EIO");
        return NODE_DIR_PIN_OPS.lstat(p);
      },
    };
    live = await workSession({
      script: program(),
      wire: {
        dirPinOps,
        beforeSpawn: () => {
          armed = true;
        },
      },
    });
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    const err = await refusalOf(
      live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
    );
    expect(err.message).toContain("could not be re-checked immediately before the spawn (EIO)");
    await expectNothingStarted(m.file);
  }, 20_000);

  it("a cwd whose realpath FAILS when it is first resolved is refused, not guessed", async () => {
    // Fails for the cwd only while resolving; the (never reached) pin would see it work.
    let failing = true;
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      realpath: (p) => {
        if (failing && p.endsWith(`${sep}sub`)) throw failure("EACCES");
        return NODE_DIR_PIN_OPS.realpath(p);
      },
    };
    live = await workSession({
      script: program(),
      wire: {
        dirPinOps,
        beforePin: () => {
          failing = false;
        },
      },
    });
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    const err = await refusalOf(
      live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
    );
    expect(err.message).toContain('run refused: cwd "sub"');
    expect(err.message).toContain("could not be resolved through its symlinks (EACCES)");
    await expectNothingStarted(m.file);
  }, 20_000);

  it("a workspace whose realpath FAILS is refused, not guessed", async () => {
    let failing = true;
    let ws = "";
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      realpath: (p) => {
        if (failing && p === ws) throw failure("EACCES");
        return NODE_DIR_PIN_OPS.realpath(p);
      },
    };
    live = await workSession({
      script: program(),
      wire: {
        dirPinOps,
        beforePin: () => {
          failing = false;
        },
      },
    });
    ws = live.cwd;
    const m = marker();
    const err = await refusalOf(live.work.manager.start({ command: m.command }, live.cwd));
    expect(err.message).toContain(`the workspace ${live.cwd} could not be resolved`);
    expect(err.message).toContain("(EACCES)");
    await expectNothingStarted(m.file);
  }, 20_000);

  it("an fstat that throws after the pin opened: run refuses and closes the descriptor, and says closed only because the close returned", async () => {
    const opened: number[] = [];
    const closed: number[] = [];
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      open: (p, flags) => {
        const fd = NODE_DIR_PIN_OPS.open(p, flags);
        opened.push(fd);
        return fd;
      },
      fstat: () => {
        throw failure("EIO");
      },
      close: (fd) => {
        closed.push(fd);
        NODE_DIR_PIN_OPS.close(fd);
      },
    };
    live = await workSession({ script: program(), wire: { dirPinOps } });
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    try {
      const err = await refusalOf(
        live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
      );
      expect(err.message).toContain("its identity could not be read (EIO)");
      expect(err.message).toContain("The descriptor that pinned it was closed.");
      expect(opened.length).toBe(1);
      expect(closed).toEqual(opened);
      await expectNothingStarted(m.file);
    } finally {
      // Should a regression leak the descriptor, do not leak it past this test.
      for (const fd of opened.filter((f) => !closed.includes(f))) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  }, 20_000);

  it("a pin release whose close throws refuses BEFORE anything is spawned, and does not claim the descriptor closed", async () => {
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      close: (fd) => {
        NODE_DIR_PIN_OPS.close(fd);
        throw failure("EIO");
      },
    };
    live = await workSession({ script: program(), wire: { dirPinOps } });
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    const err = await refusalOf(
      live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
    );
    expect(err.message).toContain("passed its final re-check");
    expect(err.message).toContain(
      "Closing the descriptor that pinned it then failed (EIO), so whether that descriptor is still open is unknown",
    );
    expect(err.message).not.toMatch(/\b(was|is) (closed|released)\b/i);
    expect(err.message).toContain("Nothing was started");
    await expectNothingStarted(m.file);
  }, 20_000);

  it("a FINAL re-check that fails, then a release close that throws BEFORE closing: run refuses and reports both", async () => {
    const opened: number[] = [];
    let closeAttempts = 0;
    let outside = "";
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      open: (p, flags) => {
        const fd = NODE_DIR_PIN_OPS.open(p, flags);
        opened.push(fd);
        return fd;
      },
      // Throws WITHOUT closing: the descriptor really is still open afterwards.
      close: () => {
        closeAttempts += 1;
        throw failure("EINTR");
      },
    };
    live = await workSession({
      script: program(),
      wire: {
        dirPinOps,
        // The pin was verified; the FINAL re-check then fails: the pinned
        // directory is moved outside the workspace and linked to.
        beforeSpawn: () => {
          const ws = (live as LiveWork).cwd;
          renameSync(join(ws, "sub"), join(outside, "sub"));
          symlinkSync(join(outside, "sub"), join(ws, "sub"), "dir");
        },
      },
    });
    outside = outsideDir();
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    try {
      const err = await refusalOf(
        live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
      );
      // The re-check's failure ...
      expect(err.message).toContain("now resolves outside the workspace");
      expect(err.message).toContain("immediately before the spawn");
      // ... AND the failed close, with the descriptor's state unknown.
      expect(err.message).toContain("Closing the descriptor that pinned it then failed (EINTR)");
      expect(err.message).toContain("whether that descriptor is still open is unknown");
      expect(err.message).not.toMatch(/\b(was|is) (closed|released)\b/i);
      expect(closeAttempts).toBe(1);
      // The case is real: the descriptor the refusal does not vouch for IS open.
      expect(opened.length).toBe(1);
      expect(fstatSync(opened[0]).isDirectory()).toBe(true);
      await expectNothingStarted(m.file);
    } finally {
      // The injected close never closed it; close it here so it does not leak.
      for (const fd of opened) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  }, 20_000);

  it("a cleanup close that throws BEFORE closing is reported: run refuses, starts nothing, and does not claim the descriptor closed", async () => {
    const opened: number[] = [];
    let closeAttempts = 0;
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      open: (p, flags) => {
        const fd = NODE_DIR_PIN_OPS.open(p, flags);
        opened.push(fd);
        return fd;
      },
      fstat: () => {
        throw failure("EIO");
      },
      // Throws WITHOUT closing: the descriptor really is still open afterwards.
      close: () => {
        closeAttempts += 1;
        throw failure("EINTR");
      },
    };
    live = await workSession({ script: program(), wire: { dirPinOps } });
    const m = marker();
    mkdirSync(join(live.cwd, "sub"));
    try {
      const err = await refusalOf(
        live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
      );
      expect(err.message).toContain("its identity could not be read (EIO)");
      expect(err.message).toContain("Closing the descriptor that pinned it then failed (EINTR)");
      expect(err.message).toContain("whether that descriptor is still open is unknown");
      expect(err.message).not.toMatch(/\b(was|is) closed\b/i);
      expect(err.message).toContain("Nothing was started");
      expect(closeAttempts).toBe(1);
      // The case is real: the descriptor the refusal does not vouch for IS open.
      expect(opened.length).toBe(1);
      expect(fstatSync(opened[0]).isDirectory()).toBe(true);
      await expectNothingStarted(m.file);
    } finally {
      // The injected close never closed it; close it here so it does not leak.
      for (const fd of opened) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  }, 20_000);

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "a searchable but unreadable directory is refused: the pin opens it for reading",
    async () => {
      // Node's realpath succeeds on a directory the process may search but not
      // read (bun's native one fails, EACCES, before the pin is reached): the
      // stub gives Node's answer for this one directory, so the pin's own open
      // is what refuses, as it does in production under Node.
      let rawSub = "";
      let canonSub = "";
      const dirPinOps: DirPinOps = {
        ...NODE_DIR_PIN_OPS,
        realpath: (p) => {
          if (canonSub !== "" && (p === rawSub || p === canonSub)) return canonSub;
          return NODE_DIR_PIN_OPS.realpath(p);
        },
      };
      live = await workSession({ script: program(), wire: { dirPinOps } });
      const m = marker();
      rawSub = join(live.cwd, "sub");
      mkdirSync(rawSub);
      canonSub = realpathSync(rawSub);
      chmodSync(rawSub, 0o300);
      try {
        const err = await refusalOf(
          live.work.manager.start({ command: m.command, cwd: "sub" }, live.cwd),
        );
        expect(err.message).toContain("could not be opened to pin its identity (EACCES)");
        expect(err.message).toContain("without read permission is refused");
        await expectNothingStarted(m.file);
      } finally {
        chmodSync(rawSub, 0o700);
      }
    },
    20_000,
  );

  it("the live-job limit holds for starts issued together: nothing yields between the check and the registration", async () => {
    live = await workSession({ script: program(), wire: { maxLiveJobs: 1 } });
    const manager = live.work.manager;
    const first = manager.start({ command: "sleep 30", background: true }, live.cwd);
    // Registered before start() returned its promise: no await ran between the
    // limit check and the registration (with no test seam set, as in production).
    expect(manager.list().map((j) => j.runId)).toEqual(["run-1"]);
    const second = manager.start({ command: "sleep 30", background: true }, live.cwd);
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason.message).toContain(
      "run refused: this run already has 1 running job (run-1)",
    );
    expect(manager.list().length).toBe(1);
    await manager.endRun();
  }, 20_000);

  it("a normal in-workspace cwd still runs, and the pin is opened and closed exactly once", async () => {
    const opened: number[] = [];
    const closed: number[] = [];
    const dirPinOps: DirPinOps = {
      ...NODE_DIR_PIN_OPS,
      open: (p, flags) => {
        const fd = NODE_DIR_PIN_OPS.open(p, flags);
        opened.push(fd);
        return fd;
      },
      close: (fd) => {
        closed.push(fd);
        NODE_DIR_PIN_OPS.close(fd);
      },
    };
    let m = { file: "", command: "" };
    live = await workSession({
      wire: { dirPinOps },
      script: program(callWith("run", () => ({ command: m.command, cwd: "sub" }))),
    });
    m = marker();
    mkdirSync(join(live.cwd, "sub"));
    await live.prompt();
    const r = lastOf(live.results, "run");
    expect(r.isError).toBe(false);
    expect(r.details.outcome).toBe("exited");
    expect(r.details.exit_code).toBe(0);
    // The positive control for every marker assertion above: a command that
    // starts writes the marker.
    expect(existsSync(m.file)).toBe(true);
    expect(opened.length).toBe(1);
    expect(closed).toEqual(opened);
  }, 20_000);
});

// #221: a setup that throws must not leave the scratch directory behind. The
// work harness removes it in a catch when the session load throws, so this holds
// even though a caller never receives a handle to clean up when setup fails.
describe("workSession — a failed setup leaves no scratch directory", () => {
  it("removes its scratch directory when setup throws", async () => {
    // Force setup to throw: a wire hook that is ALREADY installed trips the
    // one-at-a-time guard while the session loads (after the scratch dir is
    // created, before a handle is returned).
    const hooks = globalThis as unknown as Record<string, unknown>;
    const tmp = mkdtempSync(join(tmpdir(), "bob-work-throws-"));
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    hooks[WIRE_HOOK] = () => {};
    try {
      await expect(workSession({ script: async () => ({ text: "unused" }) })).rejects.toThrow(
        /one at a time/,
      );
      expect(readdirSync(tmp), "the scratch directory is gone").toEqual([]);
    } finally {
      delete hooks[WIRE_HOOK];
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
