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

function isCapLine(r: unknown): r is { cap: true; capBytes?: number } {
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

    const res = await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(fakeSession(events)),
      captureStdout: true,
    });

    // The captured assistant text is byte-identical (the deltas, concatenated).
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
      // A nested partial too, to prove stripping works at any depth.
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

  it("past the per-run cap: drops deltas but keeps tool/error events; cap line once", async () => {
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
    // The cap line records the configured cap so a reader knows the bound.
    expect(capLines[0].capBytes).toBe(2000);
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
      // THIS run's log: its lock names a live PID (the test process) -> must be skipped.
      mk("live", now - 4000, true, process.pid);
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
