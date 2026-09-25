// Issue #146 — the per-run log used to grow QUADRATICALLY with a long message
// because every `message_update` event is logged with `partial` (and a growing
// shallow-copy `message`), the whole assistant message so far, repeated on every
// streamed token. These tests pin the four properties the fix must provide:
//
//   1. A 5,000-token streamed message produces a log whose size is LINEAR in
//      the message (asserted under a fixed multiple of the message size), not
//      quadratic.
//   2. No logged `message_update` line contains `partial`.
//   3. Past the per-run size cap: tool-call and error events are still written,
//   4. Each record is on disk when its appendFileSync returns (read the log
//      before the next event), and retention leaves a live concurrent run's
//      older log untouched (dead-pid locks are treated as finished).
//      post-mortem property this log exists for).
//
// The fake session mirrors the real pi event shape: a `message_update` carries
// `assistantMessageEvent` (a text_delta with a growing `partial`) AND a growing
// shallow-copy `message` (its content grows in place) — both must be stripped for
// the log to stay linear.
//
// The fake sessions here also END an assistant message where a run must settle
// exit 0: since #145/#158 a run's final text is the last assistant message that
// ENDED (the observer's boundary), not the deltas accumulated in the subscribe
// callback the log is written from — so a stream of deltas with no message_end
// is a silent run by design, and a test that wants a successful run says so the
// way a real provider does.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSession, RunSessionFactory } from "../../src/shell/run.js";
import { pruneOldRunLogs, runAgent } from "../../src/shell/run.js";

// A fake AgentSession matching the RunSession seam. Emits a fixed list of raw
// events to every subscribed listener. `throwAfter` throws (a fatal mid-run
// error) once that many events have been emitted, after emitting them.
function fakeSession(
  events: unknown[],
  opts: {
    throwAfter?: number;
    throwError?: unknown;
    // Observe the on-disk log before the NEXT event is emitted — this is the "read
    // the file before the next event" seam for the on-disk-when-append-returns test.
    onEmit?: (count: number) => void | Promise<void>;
  } = {},
): RunSession {
  // biome-ignore lint/suspicious/noExplicitAny: minimal listener stub
  const listeners: Array<(event: any) => void> = [];
  return {
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt() {
      let emitted = 0;
      for (const ev of events) {
        for (const l of listeners) l(ev);
        emitted++;
        if (opts.throwAfter !== undefined && emitted >= opts.throwAfter) {
          throw opts.throwError ?? new Error("simulated mid-run crash");
        }
        // Let a test read the log before the next event is emitted.
        await opts.onEmit?.(emitted);
      }
    },
    get messages() {
      return [];
    },
    dispose() {},
  } as RunSession;
}

// A factory that hands back a pre-made fake session.
function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
}

// A reliably-dead PID for the retention test: spawn a tiny child and wait for it to
// exit. The finished child's PID is (for all practical purposes) not reused for the
// test's short duration, so process.kill(pid, 0) reports it as gone (ESRCH), i.e. the
// run that holds that lock is "finished" and its log is prunable like any other.
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  if (child.pid === undefined) throw new Error("deadPid: child PID unavailable");
  return child.pid;
}

// A LIVE PID held by a child of this test — never by the test process itself. The
// live-lock case must be proven by ANOTHER live process (issue #146, round 5):
// naming the test's own pid only proves the test is running, not that retention
// reads a lock the way a real concurrent run's would. Returns the pid plus a stop()
// that waits for the child to exit.
async function livePid(): Promise<{ pid: number; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("livePid: child PID unavailable");
  const pid = child.pid;
  // Let the child actually start before anything probes its liveness.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  return {
    pid,
    stop: async () => {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    },
  };
}

// Build a message_update event exactly like the real pi SDK emits one: a
// text_delta `assistantMessageEvent` carrying the growing `partial`, plus a
// growing shallow-copy `message` (its content grows in place).
function messageUpdate(delta: string, acc: string): unknown {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: acc },
    message: { role: "assistant", content: [{ type: "text", text: acc }] },
  };
}

// The event type of a log record (the inner session event), or undefined.
function eventType(r: unknown): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: log record shape
  return (r as any)?.event?.type;
}

function isCapLine(r: unknown): r is { cap: true; kind?: string; capBytes?: number } {
  return typeof r === "object" && r !== null && (r as { cap?: unknown }).cap === true;
}

describe("run-log sizing + retention (issue #146)", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-runlog-"));
    const agentDir = join(agentsRoot, "testbot");
    mkdirSync(join(agentDir, "work"), { recursive: true });
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  name: Testbot",
        "  role: ea",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-sonnet-4-6",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
    );
    writeFileSync(join(agentDir, "soul.md"), "You are Testbot.");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  // Read the single run-log JSONL file written under runs/. Returns raw bytes +
  // parsed lines (each a JSON record, in order).
  function readRunLog(name: string): { path: string; raw: string; lines: unknown[] } {
    const runsDir = join(agentsRoot, name, "runs");
    const files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));
    const path = join(runsDir, files[0]);
    const raw = readFileSync(path, "utf8");
    const lines = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    return { path, raw, lines };
  }

  it("keeps a 5,000-token streamed message's log linear, not quadratic", async () => {
    const tokens = 5000;
    const delta = "tok "; // 4 chars per streamed token
    const events: unknown[] = [];
    let acc = "";
    for (let i = 0; i < tokens; i++) {
      acc += delta;
      events.push(messageUpdate(delta, acc));
    }
    // The message ENDS: its own content is the run's final text (the observer's
    // capture), and here it is exactly what the deltas accumulated.
    events.push({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: acc }] },
    });

    const res = await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(fakeSession(events)),
      captureStdout: true,
    });

    // The captured assistant text is byte-identical to the ended message's text.
    expect(res.stdout).toBe(acc);
    expect(res.exitCode).toBe(0);

    const log = readRunLog("testbot");
    const logBytes = statSync(log.path).size;
    // Linear: under a fixed multiple (100x) of the final message size. A
    // quadratic log (the old behavior) would be ~50 MB here and fail.
    expect(logBytes).toBeLessThan(100 * acc.length);
    // Sanity: every delta was recorded as a message_update (none silently lost).
    const updates = log.lines.filter((l) => eventType(l) === "message_update");
    expect(updates.length).toBe(tokens);
  });

  it("never logs `partial` on a message_update event", async () => {
    const events: unknown[] = [];
    let acc = "";
    for (let i = 0; i < 6; i++) {
      acc += "word";
      const ev = messageUpdate("word", acc);
      // A nested partial too: the projection logs no field it does not name, at any depth.
      (ev as { message: { partial: string } }).message.partial = "nested partial to drop";
      events.push(ev);
    }

    await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(fakeSession(events)),
    });

    const log = readRunLog("testbot");
    // The whole file must not contain the growing `partial` field, at any depth.
    expect(log.raw).not.toContain("partial");
    // And structurally: every message_update record has no `partial` anywhere.
    for (const l of log.lines) {
      if (eventType(l) === "message_update") {
        expect(JSON.stringify(l)).not.toContain("partial");
      }
    }
  });

  it("past the per-run DELTA cap: drops streamed deltas but keeps tool/error events; one delta-cap marker", async () => {
    const events: unknown[] = [];
    for (let i = 0; i < 300; i++) {
      // Each delta carries a small growing partial; ~13 of them overflow the cap.
      events.push({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "tok",
          partial: "tok".repeat(i + 1),
        },
      });
    }
    // Non-delta events that must still be written even past the cap.
    events.push({ type: "tool_execution_start", toolName: "read", toolCallId: "tc-1", args: {} });
    events.push({ type: "error", message: "provider blew up mid-run" });
    // A message ENDS, so the run settles 0 under the #145 contract; this test is
    // about the delta cap in the log.
    events.push({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });

    const res = await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(fakeSession(events)),
      runLogCapBytes: 2000,
    });
    expect(res.exitCode).toBe(0);

    const log = readRunLog("testbot");
    // Exactly one line records that the cap was hit.
    const capLines = log.lines.filter(isCapLine);
    expect(capLines.length).toBe(1);
    // The cap line records the configured cap so a reader knows the bound, and
    // names WHAT it capped: the streamed deltas, not the log.
    expect(capLines[0].capBytes).toBe(2000);
    expect(capLines[0].kind).toBe("delta");
    // Deltas after the cap are dropped: fewer message_update lines than tokens.
    const updates = log.lines.filter((l) => eventType(l) === "message_update");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.length).toBeLessThan(300);
    // The tool call and the error (non-delta) survive even past the cap.
    const types = log.lines.map(eventType).filter((t): t is string => t !== undefined);
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("error");
    // No message_update appears AFTER the cap line (deltas are dropped past it).
    const capIdx = log.lines.findIndex(isCapLine);
    expect(capIdx).toBeGreaterThan(0);
    for (const l of log.lines.slice(capIdx + 1)) {
      expect(eventType(l)).not.toBe("message_update");
    }
  });

  it("past the delta cap: message_end still records the final message, in full", async () => {
    // The documented consequence of the delta cap, pinned: past the cap the streamed
    // deltas are dropped, but message_end still records each final message once — so
    // the message's CONTENT is recoverable from the log even when its deltas were not
    // all written.
    const finalText = "FINAL-MESSAGE-BODY";
    const events: unknown[] = [];
    for (let i = 0; i < 60; i++) {
      events.push({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "tok",
          partial: "tok".repeat(i + 1),
        },
      });
    }
    events.push({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: finalText }] },
    });
    events.push({
      type: "tool_execution_start",
      toolCallId: "tc-after-cap",
      toolName: "read",
      args: {},
    });

    const res = await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(fakeSession(events)),
      runLogCapBytes: 1500,
    });
    expect(res.exitCode).toBe(0);

    const log = readRunLog("testbot");
    const capIdx = log.lines.findIndex(isCapLine);
    expect(capIdx).toBeGreaterThan(0);
    // The final message is logged ONCE, after the cap, carrying its full content.
    const endIdx = log.lines.findIndex((l) => eventType(l) === "message_end");
    expect(endIdx).toBeGreaterThan(capIdx);
    expect(JSON.stringify(log.lines[endIdx])).toContain(finalText);
    // Everything after the cap line is non-delta: the tool call is still logged.
    for (const l of log.lines.slice(capIdx + 1)) {
      expect(eventType(l)).not.toBe("message_update");
    }
    expect(log.lines.map(eventType)).toContain("tool_execution_start");
  });

  it("a crash past the cap before any message_end leaves no post-cap content", async () => {
    // The other half of the documented trade-off, pinned honestly: with the deltas
    // dropped and no message_end yet, that message's post-cap tail is simply not in
    // the log. (A reader of such a log needs to know that, not to guess it.)
    const events: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      events.push({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "tok",
          partial: "tok".repeat(i + 1),
        },
      });
    }

    const res = await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(
        fakeSession(events, {
          throwAfter: events.length,
          throwError: new Error("simulated mid-run crash"),
        }),
      ),
      runLogCapBytes: 1200,
    });
    expect(res.exitCode).toBe(1);

    const log = readRunLog("testbot");
    const capIdx = log.lines.findIndex(isCapLine);
    expect(capIdx).toBeGreaterThan(0);
    // No message_end was ever emitted, so no final message is in the log: the
    // post-cap tail of that message is genuinely absent.
    expect(log.lines.map(eventType)).not.toContain("message_end");
    const updatesAfterCap = log.lines
      .slice(capIdx + 1)
      .filter((l) => eventType(l) === "message_update");
    expect(updatesAfterCap.length).toBe(0);
    // The death is still recorded, so the log says why it ends there.
    const doneLine = log.lines.find((l) => (l as { done?: boolean }).done === true);
    expect(doneLine).toBeDefined();
  });

  it("creates the runs directory 0700 and the log and its lock 0600, under a permissive umask", async () => {
    if (process.platform === "win32") return;
    // The log carries assistant text, tool arguments and tool results. Under the
    // common 022 umask the defaults were a 0755 directory and a 0644 log and lock,
    // readable by every local user.
    const previous = process.umask(0o022);
    try {
      const runsDir = join(agentsRoot, "testbot", "runs");
      let lockMode = -1;
      await runAgent({
        name: "testbot",
        prompt: "go",
        agentsRoot,
        sessionFactory: factoryReturning(
          fakeSession([messageUpdate("tok", "tok")], {
            // The lock exists only while the run writes; read it mid-run.
            onEmit: async () => {
              const lock = readdirSync(runsDir).find((f) => f.endsWith(".jsonl.lock"));
              lockMode = statSync(join(runsDir, lock!)).mode & 0o777;
            },
          }),
        ),
      });
      expect(statSync(runsDir).mode & 0o777).toBe(0o700);
      expect(statSync(readRunLog("testbot").path).mode & 0o777).toBe(0o600);
      expect(lockMode).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("writes each record to disk when the append returns (read before the next event)", async () => {
    // A mix of delta (message_update) and a non-delta (tool) event, so the "read
    // before the next event" assertion is not delta-only.
    const events: unknown[] = [];
    let acc = "";
    for (let i = 0; i < 12; i++) {
      acc += "tok";
      events.push(messageUpdate("tok", acc));
    }
    events.push({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tc-ondisk",
      args: {},
    });

    // Read the log after every event, before the next one is emitted. appendFileSync
    // is synchronous, so the just-emitted record is already on disk: the line count
    // equals the number of events emitted so far (no cap line is interleaved here).
    let observed = 0; // highest event count we saw already on disk
    await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(
        fakeSession(events, {
          onEmit: async (count) => {
            const log = readRunLog("testbot");
            expect(log.lines.length).toBe(count);
            observed = count;
          },
        }),
      ),
      // Huge cap so no cap line is interleaved (keeps the on-disk line count exact).
      runLogCapBytes: 1 << 30,
    });
    // We observed the log after every one of the 13 events, each time with that many
    // lines already committed — the record landed on disk when its append returned.
    expect(observed).toBe(events.length);
  });

  it("retention leaves an older run whose sidecar lock is live untouched", async () => {
    // A standalone runs dir, NOT driven through runAgent (which hardcodes the newest-5
    // / 500 MB defaults), so the lock-aware path can be exercised with a small budget.
    const dir = mkdtempSync(join(tmpdir(), "bob-runlog-retain-"));
    // The live lock must name ANOTHER live process — a child of this test, not the
    // test process itself.
    const live = await livePid();
    try {
      const mk = (name: string, mtimeSec: number, withLock: boolean, pid: number): void => {
        const p = join(dir, `${name}.jsonl`);
        // ~20 lines, well over the tiny 10-byte budget, so every older log is prunable.
        writeFileSync(p, `${name}\n`.repeat(20));
        utimesSync(p, mtimeSec, mtimeSec);
        if (withLock) writeFileSync(`${p}.lock`, String(pid));
      };
      const now = Math.floor(Date.now() / 1000);
      // Oldest -> newest (the loop tries them oldest-first); all sit in the "older" set.
      mk("p1", now - 7000, false, 0);
      mk("p2", now - 6000, false, 0);
      // A crashed/finished run: its lock names a dead PID -> treated as finished -> pruned.
      const dead = await deadPid();
      mk("dead", now - 5000, true, dead);
      // THIS run's log: its lock names a live process (a child of this test) -> skipped.
      mk("live", now - 4000, true, live.pid);
      // The newest log: inside the newest-1 window, protected unconditionally.
      mk("newest", now, false, 0);

      const res = pruneOldRunLogs(dir, { keep: 1, budgetBytes: 10 });

      // The live run's older log is NOT removed, and its lock is left intact.
      expect(res.removed).not.toContain("live.jsonl");
      expect(existsSync(join(dir, "live.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "live.jsonl.lock"))).toBe(true);
      // The dead-PID (finished) log IS removed — treated as finished.
      expect(res.removed).toContain("dead.jsonl");
      expect(existsSync(join(dir, "dead.jsonl"))).toBe(false);
      // The plain (no-lock) older logs are removed oldest-first.
      expect(res.removed).toContain("p1.jsonl");
      expect(res.removed).toContain("p2.jsonl");
      // The newest log is untouched.
      expect(res.removed).not.toContain("newest.jsonl");
      expect(res.kept).toBe(1);
    } finally {
      await live.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retention fails safe: a lock it cannot read or parse KEEPS the log", async () => {
    // An unreadable or unparsable lock means "we cannot show this run is finished",
    // and retention must never prune what it cannot show is dead (issue #146, round
    // 5). Only a POSITIVE proof of death — no lock at all, or a lock naming a dead
    // PID — makes a log prunable.
    const dir = mkdtempSync(join(tmpdir(), "bob-runlog-failsafe-"));
    try {
      const mk = (name: string, mtimeSec: number): string => {
        const p = join(dir, `${name}.jsonl`);
        writeFileSync(p, `${name}\n`.repeat(20));
        utimesSync(p, mtimeSec, mtimeSec);
        return p;
      };
      const now = Math.floor(Date.now() / 1000);
      // Unreadable: a DIRECTORY where the lock file belongs, so readFileSync throws
      // (EISDIR) regardless of uid — no chmod, no root, same result everywhere.
      const unreadable = mk("unreadable", now - 8000);
      mkdirSync(`${unreadable}.lock`);
      // Present but not a PID.
      const unparsable = mk("unparsable", now - 7000);
      writeFileSync(`${unparsable}.lock`, "not-a-pid");
      // Present, names nothing at all.
      const empty = mk("empty", now - 6000);
      writeFileSync(`${empty}.lock`, "");
      // Present, and a DEAD PID's digits followed by something that is not: a prefix
      // parse (`Number.parseInt`) reads "<pid>garbage" as that pid and would prune
      // the log on a number the lock never named. The whole content must be digits,
      // so this is unparsable and KEPT (issue #146, round 7). The pid is a real
      // finished child's, so the prefix parse would take the PRUNING branch.
      const garbage = mk("garbage", now - 5500);
      writeFileSync(`${garbage}.lock`, `${await deadPid()}garbage`);
      // Provably dead: a lock naming a finished child's PID -> prunable.
      const dead = mk("dead", now - 5000);
      writeFileSync(`${dead}.lock`, String(await deadPid()));
      // No lock at all: the run dropped it at the end -> prunable.
      mk("finished", now - 4000);
      // The newest log: inside the newest-1 window, protected unconditionally.
      mk("newest", now);

      const res = pruneOldRunLogs(dir, { keep: 1, budgetBytes: 10 });

      // Kept: every log whose lock cannot be shown to be finished, plus the newest.
      for (const name of ["unreadable", "unparsable", "empty", "garbage", "newest"]) {
        expect(res.removed, `${name} is kept`).not.toContain(`${name}.jsonl`);
        expect(existsSync(join(dir, `${name}.jsonl`)), `${name} still on disk`).toBe(true);
      }
      // The locks of the kept logs are left alone too.
      expect(existsSync(`${unreadable}.lock`)).toBe(true);
      expect(existsSync(`${unparsable}.lock`)).toBe(true);
      expect(existsSync(`${garbage}.lock`)).toBe(true);
      // Pruned: the two logs we could positively show are finished.
      expect(res.removed).toContain("dead.jsonl");
      expect(res.removed).toContain("finished.jsonl");
      expect(existsSync(join(dir, "dead.jsonl"))).toBe(false);
      expect(existsSync(join(dir, "finished.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("keeps a growing extension entry flat: identity and size, never the entry", async () => {
    // An extension that appends a session STATE snapshot makes each entry grow with
    // the session, so logging `entry` whole would put that growth back into the log —
    // the quadratic shape, one opaque payload away. Each record carries the entry's
    // identity and the size of what it dropped instead, so the log grows with the
    // NUMBER of entries and the snapshots themselves never reach disk.
    const events: unknown[] = [];
    for (const kb of [1, 16, 256, 4096]) {
      events.push({
        type: "entry_appended",
        entry: {
          type: "custom",
          customType: "state-snapshot",
          id: "e1",
          parentId: null,
          data: { seen: "z".repeat(kb * 1024) },
        },
      });
    }
    // One message ENDS, so the run settles 0; this test is about the entries.
    events.push({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });

    const res = await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(fakeSession(events)),
      runLogCapBytes: 1 << 30,
    });
    expect(res.exitCode).toBe(0);

    const log = readRunLog("testbot");
    // biome-ignore lint/suspicious/noExplicitAny: log records are untyped
    const entries = log.lines.map((l: any) => l.event).filter((e) => e?.type === "entry_appended");
    expect(entries.length).toBe(4);
    // Every record is small and the same size, whatever the entry that produced it.
    const sizes = entries.map((e) => JSON.stringify(e).length);
    expect(Math.max(...sizes)).toBeLessThan(128);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(4);
    // Each one says what the entry was and how big it was — 4 MiB for the last.
    expect(entries[3].entryType).toBe("custom");
    expect(entries[3].entryCustomType).toBe("state-snapshot");
    expect(entries[3].entryId).toBe("e1");
    expect(entries[3].entryBytes).toBeGreaterThan(4_000_000);
    // The snapshots the entries carried are NOT in the log: the whole file is a
    // rounding error next to the ~4 MiB they held.
    expect(log.raw).not.toContain("z".repeat(100));
    expect(log.raw.length).toBeLessThan(4000);
  });

  it("a run that dies before message_end still records WHICH block each delta came from", async () => {
    // One message streams several blocks — thinking, then text, then tool-call
    // arguments — and each delta names its own block with `contentIndex`. The
    // message_end that would describe the message as a whole never arrives when the
    // run dies, so the deltas are all a reader has: without the block index they
    // cannot be attributed or reassembled.
    const events: unknown[] = [
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "hmm",
          partial: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "I will ",
          partial: { role: "assistant", content: [{ type: "text", text: "I will " }] },
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 2,
          delta: '{"pa',
          partial: { role: "assistant", content: [{ type: "toolCall", id: "tc-1" }] },
        },
      },
    ];

    const res = await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(
        fakeSession(events, {
          throwAfter: events.length,
          throwError: new Error("simulated mid-run crash"),
        }),
      ),
    });
    expect(res.exitCode).toBe(1);

    const log = readRunLog("testbot");
    // No message_end was written: the deltas ARE the record of that message.
    expect(log.lines.map(eventType)).not.toContain("message_end");
    // biome-ignore lint/suspicious/noExplicitAny: log records are untyped
    const updates = log.lines.map((l: any) => l.event).filter((e) => e?.type === "message_update");
    expect(updates.map((u) => [u.kind, u.contentIndex])).toEqual([
      ["thinking_delta", 0],
      ["text_delta", 1],
      ["toolcall_delta", 2],
    ]);
    // Placing a delta is all this is for: the payloads are still not logged.
    expect(log.raw).not.toContain("partial");
  });

  it("logs every agent_end's own messages, unchanged — nothing dropped when a later run is shorter (#139)", async () => {
    // pi emits one agent_end per low-level run, and its `messages` array holds
    // only that run's own messages — the agent loop builds each agent_end from
    // the run's own newMessages, not from the accumulated session history. So
    // the arrays are INDEPENDENT, and a retry or a failure can produce a
    // SHORTER array than the run before it.
    //
    // Round 3 assumed agent_end carried the whole history and sliced each array
    // against a running count. With real pi shapes that silently drops
    // messages: after a 6-message run, slice(6) on the next run's 2 messages
    // returns NOTHING; and a 10-message run followed by a 4-message one loses
    // all 4. Both shapes are exercised here.
    const runOf = (prefix: string, n: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({
        role: "assistant",
        content: [{ type: "text", text: `${prefix}${i + 1}` }],
      }));
    // 6 then 2 (the drop case), then a shrinking 10 then 4.
    const lengths = [6, 2, 10, 4];
    const runs = lengths.map((n, r) => runOf(`run${r + 1}-m`, n));
    const events: unknown[] = runs.map((messages) => ({ type: "agent_end", messages }));
    // One message ENDS, so the run settles 0 under the #145 contract; the
    // agent_end records below are the point of this test.
    events.push({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });

    const res = await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(fakeSession(events)),
      // Huge cap: this test is about the agent_end transform, not the cap.
      runLogCapBytes: 1 << 30,
    });
    expect(res.exitCode).toBe(0);

    const log = readRunLog("testbot");
    const agentEnds = log.lines.filter((l) => eventType(l) === "agent_end");
    // One record per run, all of them: a record is never merged or skipped.
    expect(agentEnds.length).toBe(lengths.length);

    const logged: unknown[] = [];
    for (const [i, e] of agentEnds.entries()) {
      // biome-ignore lint/suspicious/noExplicitAny: log records are untyped
      const ev = (e as any).event;
      const msgs = Array.isArray(ev?.messages) ? (ev.messages as unknown[]) : [];
      // The array is logged UNCHANGED — not sliced by any earlier run's length.
      expect(msgs, `run ${i + 1} logs its own ${lengths[i]} messages unchanged`).toEqual(runs[i]);
      // Round 3's carried prior-history count is gone with the slice it served.
      expect(
        (ev as Record<string, unknown>)?.priorMessageCount,
        "no priorMessageCount is written",
      ).toBeUndefined();
      logged.push(...msgs);
    }
    // Every message of every run, exactly once — nothing dropped, nothing
    // duplicated. (The round-3 slicing logged 6 + 0 + 8 + 0 = 14 of these 22:
    // both shorter runs after a longer one vanished entirely.)
    expect(logged).toEqual(runs.flat());
    expect(logged.length).toBe(lengths.reduce((a, b) => a + b, 0));
  });
});
