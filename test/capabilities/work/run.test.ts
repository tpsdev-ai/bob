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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { groupAlive, type LiveWork, waitFor, workSession } from "./helpers.js";
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
    const runDir = live.work.manager.runDir;
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
