// Issue #146, round 5 — the run log is a WHITELIST PROJECTION of pi's event
// unions, and one run means one log file.
//
// The log used to copy each session event WHOLE and strip the snapshot fields it
// already knew about, so each review round found one more accumulated field it
// did not know about (message_update's `partial`/`message`, then
// tool_execution_update's cumulative `partialResult`, then queue_update's whole
// queues). These tests pin the projection's inversion of that — a field
// WHITELIST per event type:
//
//   1. EVERY event type in pi 0.84.3's two event unions (pi-agent-core's
//      AgentEvent, pi-coding-agent's AgentSessionEvent — enumerated from the
//      installed `.d.ts`) projects to a fixed record that does not grow with the
//      payload a whole-copy logger would carry; an unknown type logs no payload.
//   2. A long streamed tool output is logged once, at tool_execution_end, and the
//      streamed updates carry no cumulative result.
//   3. One log per run, even in the same millisecond: the name carries the
//      timestamp, the pid and a random suffix, created exclusively; the lock
//      belongs to that file alone.
//   4. Logging never throws into the run — including creating the runs directory:
//      the run completes and warns once.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSession, RunSessionFactory } from "../../src/shell/run.js";
import { projectRunLogRecord, runAgent } from "../../src/shell/run.js";

type EventRecord = Record<string, unknown>;

const REPO_ROOT = join(import.meta.dir, "..", "..");

// The event type names pi 0.84.3's two event unions actually declare, read out of
// the INSTALLED `.d.ts` files rather than copied into this test: "every event type
// in the unions" has to mean what the installed pi says, not what a list here
// remembers.
function unionTypeNames(): string[] {
  const sources: Array<{ file: string; decl: string }> = [
    {
      file: join(
        REPO_ROOT,
        "node_modules",
        "@earendil-works",
        "pi-agent-core",
        "dist",
        "types.d.ts",
      ),
      decl: "export type AgentEvent =",
    },
    {
      file: join(
        REPO_ROOT,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "core",
        "agent-session.d.ts",
      ),
      decl: "export type AgentSessionEvent =",
    },
  ];
  const names = new Set<string>();
  for (const { file, decl } of sources) {
    const text = readFileSync(file, "utf8");
    const start = text.indexOf(decl);
    expect(start, `${file} declares ${decl}`).toBeGreaterThan(-1);
    const end = text.indexOf("\n};", start);
    expect(end, `${file}: ${decl} union body ends`).toBeGreaterThan(start);
    for (const m of text.slice(start, end).matchAll(/type: "([a-z_]+)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

// A payload a whole-copy logger would carry: the accumulated snapshot, or a field
// the projection does not name. None of it may reach the record.
const BIG = "Z".repeat(8000);
const smallMessage = { role: "assistant", content: [{ type: "text", text: "hi" }] };
const toolResult = { content: [{ type: "text", text: "done" }], details: {} };

// One case per event type: `small` and `big` carry the SAME whitelisted fields and
// differ only in what the projection must drop, so any record that grows between
// them is a leaked field.
const cases: Array<{ type: string; small: EventRecord; big: EventRecord; expected: EventRecord }> =
  [
    {
      type: "agent_start",
      small: { type: "agent_start" },
      big: { type: "agent_start", extraPayload: BIG },
      expected: { type: "agent_start" },
    },
    {
      type: "turn_start",
      small: { type: "turn_start" },
      big: { type: "turn_start", extraPayload: BIG },
      expected: { type: "turn_start" },
    },
    {
      type: "agent_settled",
      small: { type: "agent_settled" },
      big: { type: "agent_settled", extraPayload: BIG },
      expected: { type: "agent_settled" },
    },
    {
      type: "summarization_retry_finished",
      small: { type: "summarization_retry_finished" },
      big: { type: "summarization_retry_finished", extraPayload: BIG },
      expected: { type: "summarization_retry_finished" },
    },
    {
      type: "message_start",
      small: { type: "message_start", message: smallMessage },
      big: { type: "message_start", message: smallMessage, extraPayload: BIG },
      expected: { type: "message_start", message: smallMessage },
    },
    {
      type: "message_end",
      small: { type: "message_end", message: smallMessage },
      big: { type: "message_end", message: smallMessage, extraPayload: BIG },
      expected: { type: "message_end", message: smallMessage },
    },
    {
      // The quadratic pair lives here: `partial` and `message` grow on every
      // streamed token. Only the inner event kind and its delta are logged.
      type: "message_update",
      small: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "tok",
          partial: smallMessage,
        },
        message: smallMessage,
      },
      big: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "tok",
          partial: { role: "assistant", content: [{ type: "text", text: BIG }] },
        },
        message: { role: "assistant", content: [{ type: "text", text: BIG }] },
        extraPayload: BIG,
      },
      expected: { type: "message_update", kind: "text_delta", delta: "tok" },
    },
    {
      type: "tool_execution_start",
      small: {
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "read",
        args: { path: "a" },
      },
      big: {
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "read",
        args: { path: "a" },
        extraPayload: BIG,
      },
      expected: {
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "read",
        args: { path: "a" },
      },
    },
    {
      // `partialResult` is the CUMULATIVE tool output: a long bash run streams the
      // whole output on every update. None of it is logged; the result arrives once
      // on tool_execution_end.
      type: "tool_execution_update",
      small: {
        type: "tool_execution_update",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "build" },
        partialResult: { content: [{ type: "text", text: "step 1" }], details: {} },
      },
      big: {
        type: "tool_execution_update",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "build" },
        partialResult: { content: [{ type: "text", text: BIG }], details: {} },
        extraPayload: BIG,
      },
      expected: { type: "tool_execution_update", toolCallId: "tc-1", toolName: "bash" },
    },
    {
      type: "tool_execution_end",
      small: {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "bash",
        result: toolResult,
        isError: false,
      },
      big: {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "bash",
        result: toolResult,
        isError: false,
        extraPayload: BIG,
      },
      expected: {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "bash",
        result: toolResult,
        isError: false,
      },
    },
    {
      type: "turn_end",
      small: { type: "turn_end", message: smallMessage, toolResults: [{ toolCallId: "tc-1" }] },
      big: {
        type: "turn_end",
        message: smallMessage,
        toolResults: [{ toolCallId: "tc-1" }],
        extraPayload: BIG,
      },
      expected: { type: "turn_end", message: smallMessage, toolResults: [{ toolCallId: "tc-1" }] },
    },
    {
      // Each agent_end carries only ITS OWN run's messages (issue #139), so the
      // array is logged unchanged — never sliced against an earlier run's count.
      type: "agent_end",
      small: { type: "agent_end", messages: [smallMessage], willRetry: false },
      big: { type: "agent_end", messages: [smallMessage], willRetry: false, extraPayload: BIG },
      expected: { type: "agent_end", messages: [smallMessage], willRetry: false },
    },
    {
      // The whole steering/follow-up TEXT is what accumulates, so only the counts
      // are logged. Same counts, bigger text: the same record.
      type: "queue_update",
      small: { type: "queue_update", steering: ["steer"], followUp: ["later"] },
      big: { type: "queue_update", steering: [BIG], followUp: [BIG] },
      expected: { type: "queue_update", steeringCount: 1, followUpCount: 1 },
    },
    {
      type: "bash_execution_update",
      small: { type: "bash_execution_update", id: "bash-1", delta: "chunk" },
      big: { type: "bash_execution_update", id: "bash-1", delta: "chunk", extraPayload: BIG },
      expected: { type: "bash_execution_update", id: "bash-1", delta: "chunk" },
    },
    {
      type: "compaction_start",
      small: { type: "compaction_start", reason: "threshold" },
      big: { type: "compaction_start", reason: "threshold", extraPayload: BIG },
      expected: { type: "compaction_start", reason: "threshold" },
    },
    {
      type: "compaction_end",
      small: {
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "s" },
        aborted: false,
        willRetry: false,
      },
      big: {
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "s" },
        aborted: false,
        willRetry: false,
        extraPayload: BIG,
      },
      expected: {
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "s" },
        aborted: false,
        willRetry: false,
      },
    },
    {
      type: "auto_retry_start",
      small: {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 100,
        errorMessage: "overloaded",
      },
      big: {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 100,
        errorMessage: "overloaded",
        extraPayload: BIG,
      },
      expected: {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 100,
        errorMessage: "overloaded",
      },
    },
    {
      type: "auto_retry_end",
      small: { type: "auto_retry_end", success: false, attempt: 2, finalError: "overloaded" },
      big: {
        type: "auto_retry_end",
        success: false,
        attempt: 2,
        finalError: "overloaded",
        extraPayload: BIG,
      },
      expected: { type: "auto_retry_end", success: false, attempt: 2, finalError: "overloaded" },
    },
    {
      type: "summarization_retry_scheduled",
      small: {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 50,
        errorMessage: "rate limit",
      },
      big: {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 50,
        errorMessage: "rate limit",
        extraPayload: BIG,
      },
      expected: {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 50,
        errorMessage: "rate limit",
      },
    },
    {
      type: "summarization_retry_attempt_start",
      small: { type: "summarization_retry_attempt_start", source: "branchSummary" },
      big: {
        type: "summarization_retry_attempt_start",
        source: "branchSummary",
        extraPayload: BIG,
      },
      expected: { type: "summarization_retry_attempt_start", source: "branchSummary" },
    },
    {
      type: "session_info_changed",
      small: { type: "session_info_changed", name: "s" },
      big: { type: "session_info_changed", name: "s", extraPayload: BIG },
      expected: { type: "session_info_changed", name: "s" },
    },
    {
      type: "thinking_level_changed",
      small: { type: "thinking_level_changed", level: "high" },
      big: { type: "thinking_level_changed", level: "high", extraPayload: BIG },
      expected: { type: "thinking_level_changed", level: "high" },
    },
    {
      type: "entry_appended",
      small: { type: "entry_appended", entry: { id: "e1" } },
      big: { type: "entry_appended", entry: { id: "e1" }, extraPayload: BIG },
      expected: { type: "entry_appended", entry: { id: "e1" } },
    },
  ];

describe("run-log projection (issue #146, round 5)", () => {
  it("projects EVERY event type in pi 0.84.3's unions to a fixed, non-growing record", () => {
    const names = unionTypeNames();
    // Canary: pi 0.84.3's two unions name exactly 23 event types. When pi adds
    // one, bump this count deliberately and extend `cases` — an unnamed type is
    // logged as `unknownEvent`, i.e. its payload would be dropped silently.
    expect(names.length).toBe(23);
    expect(cases.map((c) => c.type).sort()).toEqual(names);
    for (const c of cases) {
      const small = projectRunLogRecord(c.small);
      const big = projectRunLogRecord(c.big);
      expect(small, `${c.type}: named fields only`).toEqual(c.expected);
      expect(big, `${c.type}: named fields only`).toEqual(c.expected);
      // A record whose size does not grow with the payload a whole-copy logger
      // would carry (the accumulated snapshot, or an unnamed extra field).
      expect(JSON.stringify(big).length, `${c.type}: size does not grow`).toBe(
        JSON.stringify(small).length,
      );
      expect(JSON.stringify(big), `${c.type}: no leaked payload`).not.toContain("extraPayload");
    }
  });

  it("logs NO payload for an event type the projection does not name", () => {
    const unknown = projectRunLogRecord({
      type: "mystery_event_9",
      payload: BIG,
      nested: { inner: BIG },
      messages: [bigPayload()],
    });
    expect(unknown).toEqual({ type: "mystery_event_9", unknownEvent: true });
    expect(JSON.stringify(unknown).length).toBeLessThan(64);
    // Not even a type-less event leaks: it is still just an unrecognised event.
    expect(projectRunLogRecord({ payload: BIG })).toEqual({ unknownEvent: true });
  });
});

function bigPayload(): unknown {
  return { role: "assistant", content: [{ type: "text", text: BIG }] };
}

// --- run-level: one log per run, and logging never throws --------------------

function fakeSession(
  events: unknown[],
  opts: { onEmit?: (count: number) => void | Promise<void> } = {},
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
        await opts.onEmit?.(emitted);
      }
    },
    get messages() {
      return [];
    },
    dispose() {},
  } as RunSession;
}

function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
}

// Run `fn` with process.stderr.write captured; returns everything written.
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  // biome-ignore lint/suspicious/noExplicitAny: monkeypatch signature match
  (process.stderr as any).write = (chunk: any): boolean => {
    buf += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return buf;
}

describe("run-log one-per-run + never-throw (issue #146, round 5)", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-rlproj-"));
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

  const runsDir = (): string => join(agentsRoot, "testbot", "runs");
  const jsonlFiles = (): string[] => readdirSync(runsDir()).filter((f) => f.endsWith(".jsonl"));
  const lockFiles = (): string[] => readdirSync(runsDir()).filter((f) => f.endsWith(".jsonl.lock"));

  it("logs a long streamed tool output exactly once — at tool_execution_end", async () => {
    const marker = "FINAL-OUTPUT-MARKER";
    const streamed = `${"streamed line\n".repeat(400)}`; // ~5.6 KB cumulative
    const events: unknown[] = [];
    for (let i = 1; i <= 40; i++) {
      events.push({
        type: "tool_execution_update",
        toolCallId: "tc-long",
        toolName: "bash",
        args: { command: "make build" },
        partialResult: {
          content: [{ type: "text", text: streamed.slice(0, (streamed.length / 40) * i) }],
          details: {},
        },
      });
    }
    events.push({
      type: "tool_execution_end",
      toolCallId: "tc-long",
      toolName: "bash",
      result: { content: [{ type: "text", text: `${streamed}${marker}` }], details: {} },
      isError: false,
    });
    events.push({
      type: "tool_execution_update",
      toolCallId: "tc-long",
      toolName: "bash",
      args: { command: "make build" },
      partialResult: { content: [{ type: "text", text: BIG }], details: {} },
    });

    await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      sessionFactory: factoryReturning(fakeSession(events)),
    });

    const files = jsonlFiles();
    expect(files.length).toBe(1);
    const raw = readFileSync(join(runsDir(), files[0]), "utf8");
    const lines = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as EventRecord);

    // The final output lands once, on tool_execution_end.
    expect(raw.split(marker).length - 1).toBe(1);
    const ends = lines.filter((l) => (l.event as EventRecord)?.type === "tool_execution_end");
    expect(ends.length).toBe(1);
    // The 41 streamed updates carry no cumulative result at all, and every one of
    // them is the same size — the log stays linear in the number of updates.
    const updates = lines.filter((l) => (l.event as EventRecord)?.type === "tool_execution_update");
    expect(updates.length).toBe(41);
    for (const u of updates) {
      const ev = u.event as EventRecord;
      expect(ev.partialResult).toBeUndefined();
      expect(JSON.stringify(ev).length).toBeLessThan(80);
    }
    // The whole log is a rounding error next to the streamed text it did not copy.
    expect(raw.length).toBeLessThan(events.length * 80 + 20_000);
  });

  it("gives two runs started in the same millisecond distinct logs — and distinct locks", async () => {
    // The clock is pinned, so both runs report the SAME start millisecond: only
    // the pid + random suffix can tell their files apart.
    const pinned = new Date("2026-01-01T00:00:00.000Z");
    const now = () => new Date(pinned.getTime());

    const during = (seen: { files: string[]; locks: string[] }[]) => {
      return async (): Promise<void> => {
        seen.push({ files: jsonlFiles(), locks: lockFiles() });
      };
    };

    const seenA: { files: string[]; locks: string[] }[] = [];
    await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      now,
      sessionFactory: factoryReturning(
        fakeSession(
          [
            { type: "tool_execution_start", toolCallId: "tc-a", toolName: "marker-a", args: {} },
            { type: "agent_end", messages: [], willRetry: false },
          ],
          { onEmit: during(seenA) },
        ),
      ),
    });

    const seenB: { files: string[]; locks: string[] }[] = [];
    await runAgent({
      name: "testbot",
      prompt: "go",
      agentsRoot,
      now,
      sessionFactory: factoryReturning(
        fakeSession(
          [
            { type: "tool_execution_start", toolCallId: "tc-b", toolName: "marker-b", args: {} },
            { type: "agent_end", messages: [], willRetry: false },
          ],
          { onEmit: during(seenB) },
        ),
      ),
    });

    // Two runs, two distinct log files, each created from the same timestamp.
    // Identify them by the run that made them — `readdir` order is not sorted.
    expect(seenA[0].files.length).toBe(1);
    const logA = seenA[0].files[0];
    expect(seenB[0].files.length).toBe(2);
    expect(seenB[0].files).toContain(logA);
    const logB = seenB[0].files.find((f) => f !== logA);
    expect(logB).toBeDefined();
    if (logB === undefined) throw new Error("expected a second per-run log file");
    expect(logA).not.toBe(logB);

    const files = jsonlFiles();
    expect(new Set(files)).toEqual(new Set([logA, logB]));
    for (const f of files) {
      expect(f).toStartWith("2026-01-01T00-00-00-000Z.");
      expect(f).toContain(`.${process.pid}.`); // the pid is in the name
    }

    // Each run held a lock for ITS OWN file, and only its own: the lock belongs to
    // that file alone.
    expect(seenA[0].locks).toEqual([`${logA}.lock`]);
    expect(seenB[0].locks).toEqual([`${logB}.lock`]);

    // Neither log clobbered the other: each holds its own run's records.
    const rawA = readFileSync(join(runsDir(), logA), "utf8");
    const rawB = readFileSync(join(runsDir(), logB), "utf8");
    expect(rawA).toContain("marker-a");
    expect(rawA).not.toContain("marker-b");
    expect(rawB).toContain("marker-b");
    expect(rawB).not.toContain("marker-a");
  });

  it("completes and warns ONCE when the runs directory cannot be created", async () => {
    // A file where the runs directory belongs: creating the dir throws, which is
    // the setup failure "logging never throws into the run" is about.
    writeFileSync(runsDir(), "not a directory\n");

    let stdout: string | undefined;
    let exitCode: number | undefined;
    const stderr = await captureStderr(async () => {
      const res = await runAgent({
        name: "testbot",
        prompt: "go",
        agentsRoot,
        captureStdout: true,
        sessionFactory: factoryReturning(
          fakeSession([
            {
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
            },
            {
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
            },
          ]),
        ),
      });
      stdout = res.stdout;
      exitCode = res.exitCode;
    });

    // The run still ran and returned its text.
    expect(exitCode).toBe(0);
    expect(stdout).toBe("hi");
    // Exactly one warning, and no run-log path announced (there was no log).
    const warnings = stderr.split("\n").filter((l) => l.includes("run log unavailable"));
    expect(warnings.length).toBe(1);
    expect(stderr).not.toContain("run log: ");
    // The runs path is still the file it was: nothing was created over it.
    expect(readFileSync(runsDir(), "utf8")).toBe("not a directory\n");
  });
});
