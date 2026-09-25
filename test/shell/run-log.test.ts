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
//      deltas are dropped, and the cap line appears exactly once.
//   4. A mid-run crash still leaves the events written before it on disk (the
//      post-mortem property this log exists for).
//
// The fake session mirrors the real pi event shape: a `message_update` carries
// `assistantMessageEvent` (a text_delta with a growing `partial`) AND a growing
// shallow-copy `message` (its content grows in place) — both must be stripped for
// the log to stay linear.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSession, RunSessionFactory } from "../../src/shell/run.js";
import { runAgent } from "../../src/shell/run.js";

// A fake AgentSession matching the RunSession seam. Emits a fixed list of raw
// events to every subscribed listener. `throwAfter` throws (a fatal mid-run
// error) once that many events have been emitted, after emitting them.
function fakeSession(
  events: unknown[],
  opts: { throwAfter?: number; throwError?: unknown } = {},
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

  it("a mid-run crash still leaves the events before it on disk", async () => {
    const events: unknown[] = [];
    let acc = "";
    for (let i = 0; i < 5; i++) {
      acc += "tok";
      events.push(messageUpdate("tok", acc));
    }
    // A tool call right before the crash — the last thing the run did.
    events.push({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tc-crash",
      args: {},
    });

    // The run dies (throws) after emitting all events, before it would finish.
    const res = await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(
        fakeSession(events, {
          throwAfter: events.length,
          throwError: new Error("hard crash mid-run"),
        }),
      ),
    });
    // The fatal error is surfaced (non-zero exit), not swallowed.
    expect(res.exitCode).toBe(1);

    const log = readRunLog("testbot");
    // The durability property: everything emitted before the crash is on disk
    // (the post-mortem trail this log exists for). `partial` stripping is test
    // 2's concern, not this one's.
    expect(log.lines.filter((l) => eventType(l) === "message_update").length).toBe(5);
    // The last event before the crash (the tool call) is on disk.
    const types = log.lines.map(eventType).filter((t): t is string => t !== undefined);
    expect(types).toContain("tool_execution_start");
    // A done line records the non-zero exit, so the log is not silently truncated.
    const done = log.lines.find(
      (l): l is { done: boolean; exitCode: number } =>
        typeof l === "object" && l !== null && (l as { done?: unknown }).done === true,
    );
    expect(done).toBeDefined();
    expect(done?.exitCode).toBe(1);
  });
});
