// bob#356 V2a — the BOB SIDE of the ears: gates before inputs.
//
// The socket-backed cases run a FAKE sidecar process speaking reachy-voice/1 on
// a real UNIX socket: an addressed transcript is admitted as a voice-origin turn
// with bob-issued ids and `speakerVerified:false`; `wakeHeard` alone never
// addresses; a malformed transcript is dropped with a named log line; a report of
// hardware mute drops the next transcript; and bob's own words are dropped by the
// echo guard (during playback and as a recent say-match). The remaining cases
// call the real modules directly: wire decoding, memory eligibility under a real
// parsed config, per-turn utterance cleanup, the queued-turn recheck, a fresh
// session's context isolation, and the tool-admission gate (stub tools through
// the real extension; the `voice` profile still exposes no body tool).
import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MemoryWriter,
  type OrgEventStore,
  orgEventRecordId,
  type PiLike,
  type ReachyCommands,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import { parseConfig } from "../../../src/capabilities/reachy/config.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";
import { addressed } from "../../../src/capabilities/reachy/policy.js";
import { decodeLine } from "../../../src/capabilities/reachy/wire.js";
import {
  admitToolCall,
  createToolAdmissionExtension,
  VOICE_GRANT_REFUSAL,
} from "../../../src/shell/tool-admission.js";
import {
  boundOrigin,
  createTurnAdmission,
  runtimeEventBus,
} from "../../../src/shell/turn-admission.js";
import type { TurnOrigin } from "../../../src/shell/turn-origin.js";
import { healthLine, must, TEST_SIDECAR_VERSION } from "./handshake.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const DRIVEN = join(REPO, "test", "fixtures", "reachy-stub", "driven-sidecar.py");

const scratch: string[] = [];
const procs: ChildProcess[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  for (const d of scratch) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

type Tool = {
  name: string;
  parameters: unknown;
  execute: (
    id: string,
    p: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
};
class FakePi implements PiLike {
  readonly tools = new Map<string, Tool>();
  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }
  async call(name: string, params: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return (await tool.execute("tc", params)).content.map((c) => c.text).join("");
  }
}
class FakeStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  private readonly byId = new Map<string, OrgEvent>();
  async write(event: OrgEvent): Promise<{ id: string }> {
    const id = orgEventRecordId(event);
    this.byId.set(id, event);
    this.all.push(event);
    return { id };
  }
  async getById(id: string): Promise<OrgEvent | null> {
    return this.byId.get(id) ?? null;
  }
}
class FakeMemory implements MemoryWriter {
  readonly writes: Array<{ content: string; metadata: { speakerId: string } }> = [];
  async writePrivate(write: {
    content: string;
    visibility: "private";
    authorId: string;
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
  }): Promise<{ id: string }> {
    this.writes.push(write);
    return { id: `mem_${this.writes.length}` };
  }
}

async function waitFor(cond: () => boolean, what: string, ms = 8_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real fake-sidecar PROCESS on a real UNIX socket, driven line by line. */
function startSidecar() {
  const dir = mkdtempSync(join(tmpdir(), "reachy-v2a-"));
  scratch.push(dir);
  const socketPath = join(dir, "sidecar.sock");
  const proc = spawn("python3", ["-I", DRIVEN, socketPath, TEST_SIDECAR_VERSION], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (b: Buffer) => {
    stdout += b.toString();
  });
  proc.stderr?.on("data", (b: Buffer) => {
    stderr += b.toString();
  });
  const api = {
    proc,
    socketPath,
    out: () => stdout,
    err: () => stderr,
    send(obj: unknown) {
      proc.stdin?.write(`${JSON.stringify(obj)}\n`);
    },
    sleep(seconds: number) {
      api.send({ sleep: seconds });
    },
    close() {
      api.send({ close: true });
      proc.stdin?.end();
    },
    ready: () => waitFor(() => stdout.includes("READY"), "the fake sidecar's READY"),
    command: (name: string) =>
      stdout.split("\n").some((line) => {
        if (!line.startsWith("CMD ")) return false;
        try {
          return (JSON.parse(line.slice(4)) as { command?: string }).command === name;
        } catch {
          return false;
        }
      }),
  };
  return api;
}

type Admissions = Array<{ origin: TurnOrigin; text: string }>;

/** bob's real client + core against the fake process; returns a settle handle. */
async function connectBob(
  sidecar: ReturnType<typeof startSidecar>,
  opts: {
    echoWindowMs?: number;
    playbackMs?: (text: string) => number;
    roomSpeechOrigins?: string[];
    admitVoiceTurn?: (origin: TurnOrigin, text: string) => Promise<unknown[]>;
    enrolment?: Record<string, string>;
  } = {},
) {
  const pi = new FakePi();
  const store = new FakeStore();
  const memory = new FakeMemory();
  const state: PolicyState = {
    profile: "voice",
    wakeName: "jarvis",
    enrolment: opts.enrolment ?? {},
    mute: false,
    nowMs: () => Date.now(),
    roomSpeechOrigins: opts.roomSpeechOrigins ?? ["run"],
  };
  const client = new UnixSocketReachyClient({ socket: sidecar.socketPath });
  const admissions: Admissions = [];
  const logs: string[] = [];
  const wired = wireReachyCapability({
    pi,
    commands: client as ReachyCommands,
    memory,
    store,
    state,
    sidecarVersion: TEST_SIDECAR_VERSION,
    readOrigin: () => ({ kind: "run" }),
    admitVoiceTurn:
      opts.admitVoiceTurn ??
      (async (origin, text) => {
        admissions.push({ origin, text });
        return [];
      }),
    ...(opts.echoWindowMs !== undefined ? { echoWindowMs: opts.echoWindowMs } : {}),
    ...(opts.playbackMs !== undefined ? { playbackMs: opts.playbackMs } : {}),
    log: (m) => logs.push(m),
  });
  let pending: Array<Promise<unknown>> = [];
  client.onLine((line) => {
    pending.push(wired.handleLine(line));
  });
  client.onClose(() => wired.disconnected());
  // Connect, retrying until the fake sidecar has bound its socket. No stat of
  // the path: the connect itself is the only probe (and the only reader).
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      await client.connect();
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await wait(10);
    }
  }
  await wired.connected();
  await waitFor(() => wired.link().phase === "ready", "the reachy-voice/1 handshake");
  const settle = async () => {
    for (;;) {
      const batch = pending;
      pending = [];
      await Promise.all(batch);
      if (pending.length === 0) return;
    }
  };
  const transcript = (text: string, over: Record<string, unknown> = {}) => ({
    send: { type: "transcript", text, ts: new Date().toISOString(), wakeHeard: true, ...over },
  });
  return {
    pi,
    store,
    memory,
    wired,
    client,
    admissions,
    logs,
    settle,
    transcript,
    close: () => {
      client.close();
      sidecar.close();
    },
  };
}

// ── the addressed recompute ──────────────────────────────────────────────────
describe("bob#356 V2a — bob recomputes `addressed`; wakeHeard alone never addresses", () => {
  it("accepts the name and the measured near-name, and rejects a different near-name", () => {
    expect(addressed("hey jarvis, what time is it", "jarvis")).toBe(true);
    expect(addressed("Hey JARVIS what time is it", "jarvis")).toBe(true);
    // Measured on the device: the wake model fired on this near-name.
    expect(addressed("Hey Dervis, what time is it?", "jarvis")).toBe(true);
    // The other measured false positive: three edits from jarvis.
    expect(addressed("Hey Travis, what time is it?", "jarvis")).toBe(false);
    expect(addressed("what time is it", "jarvis")).toBe(false);
  });

  it("a socket transcript with wakeHeard but no name is dropped, not admitted", async () => {
    const sidecar = startSidecar();
    const bob = await connectBob(sidecar);
    try {
      sidecar.send(bob.transcript("what time is it", { wakeHeard: true }));
      await wait(200);
      await bob.settle();
      expect(bob.admissions).toEqual([]);
      expect(bob.logs.some((m) => m.includes("un-addressed transcript"))).toBe(true);
    } finally {
      bob.close();
    }
  }, 30_000);
});

// ── gate 3: an addressed transcript is admitted as a voice-origin turn ───────
describe("bob#356 V2a — an addressed transcript goes through admitTurn as voice", () => {
  it("admits with speakerVerified:false and bob-issued utterance/correlation ids", async () => {
    const sidecar = startSidecar();
    const bob = await connectBob(sidecar);
    try {
      sidecar.send(bob.transcript("Hey Dervis, what time is it?"));
      await waitFor(() => bob.admissions.length === 1, "the voice admission");
      await bob.settle();
      const call = must(bob.admissions[0], "the admission");
      expect(call.text).toBe("Hey Dervis, what time is it?");
      expect(call.origin).toMatchObject({ kind: "voice", speakerVerified: false });
      if (call.origin.kind !== "voice") throw new Error("not a voice origin");
      expect(call.origin.utteranceId).toMatch(/^utt_[0-9a-f-]{36}$/);
      expect(call.origin.correlationId).toMatch(/^corr_[0-9a-f-]{36}$/);
      // No memory write from an unverified room transcript.
      expect(bob.memory.writes).toEqual([]);
    } finally {
      bob.close();
    }
  }, 30_000);

  it("an unverified speaker's addressed transcript is admitted and writes no memory", async () => {
    const sidecar = startSidecar();
    const bob = await connectBob(sidecar, { enrolment: {} });
    try {
      sidecar.send(bob.transcript("jarvis, remember the fire drill", { speakerId: "spk-visitor" }));
      await waitFor(() => bob.admissions.length === 1, "the voice admission");
      await bob.settle();
      expect(bob.memory.writes).toEqual([]);
      expect(bob.store.all.some((e) => e.kind === "reachy.memory.attempt")).toBe(false);
      expect(bob.admissions[0]?.origin).toMatchObject({ kind: "voice", speakerVerified: false });
    } finally {
      bob.close();
    }
  }, 30_000);

  it("the admitted origin is projected by the REAL admission; its tool reach is reachy_say only", async () => {
    // A voice turn runs in a FRESH session; this one is the only prompt target.
    const seen: TurnOrigin[] = [];
    let admission!: ReturnType<typeof createTurnAdmission>;
    admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => ({
        subscribe: () => () => {},
        dispose() {},
        async prompt() {
          seen.push(admission.readOrigin());
        },
      }),
    });
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt() {},
    });
    const origin: TurnOrigin = {
      kind: "voice",
      speakerVerified: false,
      utteranceId: "utt_1",
      correlationId: "corr_1",
    };
    await admission.admitTurn(origin, "hey jarvis");
    expect(seen).toEqual([origin]);
  });

  it("inside its own voice turn the admitted say is authorized; a later call is not", async () => {
    // The real admission binds the origin; the real capability supplies the
    // utterance it recorded for THIS turn. No socket: the command channel is a
    // recorder, so the assertion is about the gates. The voice prompt runs in a
    // FRESH session, never the resident one.
    let spoken: string | undefined;
    const bridgedKinds: string[] = [];
    let admission!: ReturnType<typeof createTurnAdmission>;
    admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => ({
        subscribe: () => () => {},
        dispose() {},
        async prompt() {
          spoken = await pi.call("reachy_say", { text: "It is noon." });
          // The FRESH session's reachy_say goes through this function (the
          // runtime hands it the resident capability's speech bridge).
          bridgedKinds.push((await wired.speak("It is noon.")).kind);
        },
      }),
    });
    const pi = new FakePi();
    const sent: Array<{ command: string }> = [];
    const store = new FakeStore();
    const state: PolicyState = {
      profile: "voice",
      wakeName: "jarvis",
      enrolment: {},
      mute: false,
      nowMs: () => Date.now(),
      roomSpeechOrigins: [],
    };
    const wired = wireReachyCapability({
      pi,
      commands: {
        async send(command: string) {
          sent.push({ command });
          return null;
        },
      },
      memory: new FakeMemory(),
      store,
      state,
      sidecarVersion: TEST_SIDECAR_VERSION,
      readOrigin: () => boundOrigin({ admission }),
      admitVoiceTurn: admission.admitTurn,
      log: () => {},
    });
    await wired.connected();
    await wired.handleLine(healthLine(wired, state));
    expect(wired.link().phase).toBe("ready");
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt() {},
    });
    const summary = await wired.handleLine({
      type: "transcript",
      text: "jarvis, what time is it",
      ts: "t",
      wakeHeard: true,
    });
    expect(summary).toMatchObject({ kind: "admitted", action: "voice" });
    expect(spoken).toBe("say: It is noon.");
    expect(bridgedKinds).toEqual(["admitted"]);
    expect(sent.filter((c) => c.command === "say")).toHaveLength(2);
    // After the turn, a voice-origin call with no current utterance refuses.
    const later = await wired.handleLine({
      type: "proposal",
      action: "say",
      args: { text: "hello" },
      confidence: 1,
      inputs: [],
    });
    expect(later).toMatchObject({ kind: "refused" });
    expect(sent.filter((c) => c.command === "say")).toHaveLength(2);
  }, 30_000);
});

// ── gate 1: malformed transcript is dropped with a named line ────────────────
describe("bob#356 V2a — a malformed transcript is dropped, never admitted", () => {
  it("empty text and an over-long text are malformed; a named audit and log line", async () => {
    const sidecar = startSidecar();
    const bob = await connectBob(sidecar);
    try {
      sidecar.send({ send: { type: "transcript", text: "", ts: "t", wakeHeard: true } });
      sidecar.send({
        send: { type: "transcript", text: "x".repeat(5000), ts: "t", wakeHeard: true },
      });
      await waitFor(
        () => bob.store.all.filter((e) => e.kind === "reachy.malformed").length === 2,
        "two malformed audits",
      );
      await bob.settle();
      expect(bob.admissions).toEqual([]);
      expect(bob.store.all.filter((e) => e.kind === "reachy.malformed")[0]?.summary).toContain(
        "transcript line failed its schema",
      );
      expect(bob.logs.some((m) => m.includes("transcript line failed its schema"))).toBe(true);
    } finally {
      bob.close();
    }
  }, 30_000);
});

// ── gate 4: hardware mute drops the next transcript ──────────────────────────
describe("bob#356 V2a — a transcript after a hardware-mute report is not admitted", () => {
  it("admits before the mute, drops after it", async () => {
    const sidecar = startSidecar();
    const bob = await connectBob(sidecar);
    try {
      sidecar.send(bob.transcript("jarvis, what time is it"));
      await waitFor(() => bob.admissions.length === 1, "the first admission");

      sidecar.send({
        send: healthLine(bob.wired, { profile: "voice", wakeName: "jarvis" }, { muted: true }),
      });
      await waitFor(() => bob.wired.link().deviceMuted === true, "the mute report");
      sidecar.send(bob.transcript("jarvis, are you there"));
      await wait(200);
      await bob.settle();
      expect(bob.admissions.length).toBe(1);
      expect(bob.store.all.some((e) => e.kind === "reachy.malformed")).toBe(false);
    } finally {
      bob.close();
    }
  }, 30_000);
});

// ── gate 5: the echo guard ───────────────────────────────────────────────────
describe("bob#356 V2a — the echo guard drops bob's own words", () => {
  it("say-match: a transcript that matches recent speech is dropped; a different one is admitted", async () => {
    const sidecar = startSidecar();
    const bob = await connectBob(sidecar, { echoWindowMs: 10_000, playbackMs: () => 0 });
    try {
      expect(await bob.pi.call("reachy_say", { text: "The meeting is at noon today." })).toBe(
        "say: The meeting is at noon today.",
      );
      await waitFor(() => sidecar.command("say"), "the say command");
      // NFKC/case/punctuation-insensitive near-match of the emitted line.
      sidecar.send(bob.transcript("the meeting is at noon today"));
      await wait(200);
      await bob.settle();
      expect(bob.admissions).toEqual([]);
      expect(bob.logs.some((m) => m.includes("echo guard: say-match"))).toBe(true);

      sidecar.send(bob.transcript("jarvis, what is on the calendar"));
      await waitFor(() => bob.admissions.length === 1, "the control admission");
    } finally {
      bob.close();
    }
  }, 30_000);

  it("playback interlock: a different transcript arriving during playback is dropped", async () => {
    const sidecar = startSidecar();
    const bob = await connectBob(sidecar, { playbackMs: () => 60_000 });
    try {
      expect(await bob.pi.call("reachy_say", { text: "One moment." })).toBe("say: One moment.");
      await waitFor(() => sidecar.command("say"), "the say command");
      sidecar.send(bob.transcript("jarvis, what is on the calendar"));
      await wait(200);
      await bob.settle();
      expect(bob.admissions).toEqual([]);
      expect(bob.logs.some((m) => m.includes("echo guard: playback"))).toBe(true);
    } finally {
      bob.close();
    }
  }, 30_000);
});

// ── gate 6: grants never ride on voice ───────────────────────────────────────
describe("bob#356 V2a — a grant tool is never executed on a voice-origin turn", () => {
  const voice = (): TurnOrigin => ({
    kind: "voice",
    speakerVerified: false,
    utteranceId: "utt_1",
    correlationId: "corr_1",
  });

  it("the allowlist is origin-keyed: voice reaches reachy_say only; a grant gets the fixed refusal", () => {
    expect(admitToolCall("reachy_say", voice())).toEqual({ allow: true });
    expect(admitToolCall("mail_send", voice())).toEqual({
      allow: false,
      grant: true,
      reason: VOICE_GRANT_REFUSAL,
    });
    expect(admitToolCall("calendar_accept", voice()).allow).toBe(false);
    expect(admitToolCall("payment_send", voice()).allow).toBe(false);
    // Default-deny: a tool that does not exist yet is unreachable from voice.
    expect(admitToolCall("some_future_tool", voice()).allow).toBe(false);
    // Every non-voice origin is unchanged.
    expect(admitToolCall("mail_send", { kind: "run" }).allow).toBe(true);
    expect(admitToolCall("mail_send", { kind: "cron", job: "digest" }).allow).toBe(true);
    expect(admitToolCall("mail_send", undefined).allow).toBe(true);
  });

  it("the REAL extension blocks a stub grant tool inside a voice turn, and allows it on a cron turn", async () => {
    // The voice prompt runs in a FRESH session; the CONTROL cron turn runs in
    // the resident one. Both exercise the same real tool_call handler.
    let runCalls: () => Promise<void> = async () => {};
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => ({
        subscribe: () => () => {},
        dispose() {},
        async prompt() {
          await runCalls();
        },
      }),
    });
    const handlers = new Map<string, Array<(event: unknown) => unknown>>();
    const pi = {
      events: runtimeEventBus({ admission }),
      on(type: string, handler: (event: unknown) => unknown) {
        handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      },
    };
    createToolAdmissionExtension({ log: () => {} }).factory(pi);
    let executed: string[] = [];
    const callTool = async (toolName: string) => {
      const handler = handlers.get("tool_call")?.[0];
      if (!handler) throw new Error("no tool_call handler");
      const result = (await handler({ type: "tool_call", toolCallId: "t", toolName, input: {} })) as
        | { block?: boolean; reason?: string }
        | undefined;
      if (!result?.block) executed.push(toolName);
      return result;
    };
    const results: Array<{ tool: string; result: unknown }> = [];
    runCalls = async () => {
      results.push({ tool: "reachy_say", result: await callTool("reachy_say") });
      results.push({ tool: "mail_send", result: await callTool("mail_send") });
    };
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt() {
        await runCalls();
      },
    });
    executed = [];
    await admission.admitTurn(voice(), "send the report by mail");
    expect(executed).toEqual(["reachy_say"]);
    expect(results[1]?.result).toMatchObject({ block: true, reason: VOICE_GRANT_REFUSAL });

    // CONTROL: the same grant tool runs on an authenticated cron turn.
    results.length = 0;
    executed = [];
    await admission.admitTurn({ kind: "cron", job: "digest" }, "send the report by mail");
    expect(executed).toEqual(["reachy_say", "mail_send"]);
  });

  it("a socket-driven voice transcript cannot make the gate execute a stub grant tool", async () => {
    const sidecar = startSidecar();
    let executed = false;
    const bob = await connectBob(sidecar, {
      admitVoiceTurn: async (origin) => {
        const decision = admitToolCall("mail_send", origin);
        if (decision.allow) executed = true;
        return [];
      },
    });
    try {
      sidecar.send(bob.transcript("jarvis, mail the report to the team"));
      await wait(200);
      await bob.settle();
      expect(executed).toBe(false);
    } finally {
      bob.close();
    }
  }, 30_000);
});

// ── gate 7: body tools stay absent under the voice profile ───────────────────
describe("bob#356 V2a — under `voice` the body tools remain absent", () => {
  it("registers only reachy_say and reachy_state", async () => {
    const sidecar = startSidecar();
    const bob = await connectBob(sidecar);
    try {
      expect([...bob.pi.tools.keys()].sort()).toEqual(["reachy_say", "reachy_state"]);
      expect(bob.wired.tools).toEqual(["reachy_say", "reachy_state"]);
      expect(bob.pi.tools.has("reachy_look")).toBe(false);
      expect(bob.pi.tools.has("reachy_frame")).toBe(false);
    } finally {
      bob.close();
    }
  }, 30_000);
});

// ── wire bounds and the reason that names every failed field ────────────────
describe("bob#356 V2a — the transcript line's bounds and its named failure reason", () => {
  const line = (over: Record<string, unknown> = {}) => ({
    type: "transcript",
    text: "jarvis, what time is it",
    ts: "2026-01-01T00:00:00Z",
    wakeHeard: true,
    ...over,
  });
  const reasonOf = (raw: unknown): string => {
    const decoded = decodeLine(raw);
    if (decoded.kind !== "malformed") throw new Error(`expected malformed, got ${decoded.kind}`);
    return decoded.reason;
  };

  it("bounds the timestamp (1..64) without echoing it", () => {
    expect(decodeLine(line({ ts: "" })).kind).toBe("malformed");
    expect(decodeLine(line({ ts: "x".repeat(65) })).kind).toBe("malformed");
    expect(decodeLine(line({ ts: "x".repeat(64) })).kind).toBe("transcript");
    expect(reasonOf(line({ ts: "x".repeat(65) }))).toBe("transcript line failed its schema (ts)");
  });

  it("bounds the speakerId (1..128) and names it in the reason", () => {
    expect(decodeLine(line({ speakerId: "" })).kind).toBe("malformed");
    expect(decodeLine(line({ speakerId: "s".repeat(129) })).kind).toBe("malformed");
    expect(decodeLine(line({ speakerId: "s".repeat(128) })).kind).toBe("transcript");
    expect(reasonOf(line({ speakerId: "s".repeat(129) }))).toContain("speakerId");
  });

  it("rejects an unknown field", () => {
    const reason = reasonOf(line({ transcript: "extra" }));
    expect(reason).toContain("unknown field");
  });

  it("enforces ONE line of text and names text when it is not", () => {
    expect(decodeLine(line({ text: "one line\nsecond line" })).kind).toBe("malformed");
    expect(decodeLine(line({ text: "one line\r\nsecond line" })).kind).toBe("malformed");
    expect(reasonOf(line({ text: "one\nline" }))).toContain("text");
    expect(decodeLine(line({ text: "one line" })).kind).toBe("transcript");
  });

  it("names EVERY failed field, including speakerId", () => {
    const reason = reasonOf({
      type: "transcript",
      text: "",
      ts: "",
      wakeHeard: "yes",
      speakerId: "",
    });
    for (const field of ["text", "ts", "wakeHeard", "speakerId"]) {
      expect(reason).toContain(field);
    }
  });
});

// ── no memory write from a voice transcript, even for an enrolled id ────────
describe("bob#356 V2a — a voice transcript is ineligible for a memory write", () => {
  it("a real parsed config with a nonempty enrolment and a forged matching speakerId writes nothing", async () => {
    const config = parseConfig({
      socket: "/tmp/reachy.sock",
      sidecarVersion: "reachy-voice-test",
      enrolledSpeakers: { "spk-a": "member-a" },
    });
    expect(config.enrolledSpeakers).toEqual({ "spk-a": "member-a" });
    const pi = new FakePi();
    const memory = new FakeMemory();
    const store = new FakeStore();
    const state: PolicyState = {
      profile: config.profile,
      wakeName: config.wakeName,
      enrolment: config.enrolledSpeakers,
      mute: false,
      nowMs: () => Date.now(),
      roomSpeechOrigins: [],
    };
    const admissions: Admissions = [];
    const wired = wireReachyCapability({
      pi,
      commands: {
        async send() {
          return null;
        },
      },
      memory,
      store,
      state,
      sidecarVersion: TEST_SIDECAR_VERSION,
      readOrigin: () => ({ kind: "run" }),
      admitVoiceTurn: async (origin, text) => {
        admissions.push({ origin, text });
        return [];
      },
      log: () => {},
    });
    await wired.connected();
    await wired.handleLine(healthLine(wired, state));
    expect(wired.link().phase).toBe("ready");
    const summary = await wired.handleLine({
      type: "transcript",
      text: "jarvis, remember the fire drill",
      ts: "t",
      wakeHeard: true,
      speakerId: "spk-a",
    });
    expect(summary).toMatchObject({ kind: "admitted", action: "voice" });
    expect(memory.writes).toEqual([]);
    expect(store.all.some((e) => e.kind === "reachy.memory.attempt")).toBe(false);
  });
});

// ── a voice turn is its own turn: cleanup and correlation binding ───────────
describe("bob#356 V2a — a voice utterance authorizes only its own turn", () => {
  it("a call AFTER the admitted turn fails, and a foreign correlationId never matches", async () => {
    const pi = new FakePi();
    const sent: string[] = [];
    let correlationId = "";
    const state: PolicyState = {
      profile: "voice",
      wakeName: "jarvis",
      enrolment: {},
      mute: false,
      nowMs: () => Date.now(),
      roomSpeechOrigins: [],
    };
    const wired = wireReachyCapability({
      pi,
      commands: {
        async send(command: string, args?: Record<string, unknown>) {
          if (command === "say" && typeof args?.text === "string") sent.push(args.text);
          return null;
        },
      },
      memory: new FakeMemory(),
      store: new FakeStore(),
      state,
      sidecarVersion: TEST_SIDECAR_VERSION,
      // A voice origin that STAYS bound after the turn: the stale reader the
      // cleanup must defeat on its own.
      readOrigin: () => ({
        kind: "voice",
        speakerVerified: false,
        utteranceId: "utt_1",
        correlationId,
      }),
      admitVoiceTurn: async (origin) => {
        if (origin.kind === "voice") {
          correlationId = origin.correlationId;
          // While THIS turn's utterance is live, a call bound to a DIFFERENT
          // correlation id must not inherit it: the binding is by id, not by
          // "some voice turn is running".
          const issued = correlationId;
          correlationId = "corr_other";
          const foreignDuring = await pi.call("reachy_say", { text: "foreign" });
          expect(foreignDuring).toContain("needs its own current addressed utterance");
          correlationId = issued;
        }
        return [];
      },
      log: () => {},
      // Deterministic ids, so the stale reader below uses the SAME correlation id
      // the capability issued for the turn.
      uuid: (() => {
        let n = 0;
        return () => `u${++n}`;
      })(),
    });
    await wired.connected();
    await wired.handleLine(healthLine(wired, state));
    expect(wired.link().phase).toBe("ready");
    const summary = await wired.handleLine({
      type: "transcript",
      text: "jarvis, what time is it",
      ts: "t",
      wakeHeard: true,
    });
    expect(summary).toMatchObject({ kind: "admitted", action: "voice" });
    expect(correlationId).toMatch(/^corr_u\d+$/);
    // AFTER the turn: the capability's record is gone, so this call refuses.
    const after = await pi.call("reachy_say", { text: "It is noon." });
    expect(after).toContain(
      "refused: a voice-origin call needs its own current addressed utterance",
    );
    expect(sent).toEqual([]);
    // A forged/other correlation id never had a record at all.
    correlationId = "corr_other";
    const foreign = await pi.call("reachy_say", { text: "It is noon." });
    expect(foreign).toContain("needs its own current addressed utterance");
    expect(sent).toEqual([]);
  });
});

// ── a queued voice turn rechecks the link before it starts ──────────────────
describe("bob#356 V2a — mute or disconnect while a voice turn is queued", () => {
  function queuedWorld() {
    const pi = new FakePi();
    const voicePrompts: string[] = [];
    let releaseResident!: () => void;
    const residentGate = new Promise<void>((resolve) => {
      releaseResident = resolve;
    });
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => ({
        subscribe: () => () => {},
        dispose() {},
        async prompt(text: string) {
          voicePrompts.push(text);
        },
      }),
    });
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt() {
        await residentGate;
      },
    });
    const state: PolicyState = {
      profile: "voice",
      wakeName: "jarvis",
      enrolment: {},
      mute: false,
      nowMs: () => Date.now(),
      roomSpeechOrigins: [],
    };
    const wired = wireReachyCapability({
      pi,
      commands: {
        async send() {
          return null;
        },
      },
      memory: new FakeMemory(),
      store: new FakeStore(),
      state,
      sidecarVersion: TEST_SIDECAR_VERSION,
      readOrigin: () => boundOrigin({ admission }),
      admitVoiceTurn: admission.admitTurn,
      log: () => {},
    });
    return { wired, state, admission, voicePrompts, releaseResident };
  }

  it("a mute while the voice turn waits refuses it", async () => {
    const world = queuedWorld();
    await world.wired.connected();
    await world.wired.handleLine(healthLine(world.wired, world.state));
    expect(world.wired.link().phase).toBe("ready");
    const holding = world.admission.admitTurn({ kind: "cron", job: "hold" }, "hold");
    const queued = world.wired.handleLine({
      type: "transcript",
      text: "jarvis, what time is it",
      ts: "t",
      wakeHeard: true,
    });
    await wait(20);
    world.state.mute = true;
    world.releaseResident();
    await holding;
    const result = await queued;
    expect(result.kind).toBe("drop");
    expect(world.voicePrompts).toEqual([]);
  });

  it("a disconnect while the voice turn waits refuses it", async () => {
    const world = queuedWorld();
    await world.wired.connected();
    await world.wired.handleLine(healthLine(world.wired, world.state));
    const holding = world.admission.admitTurn({ kind: "cron", job: "hold" }, "hold");
    const queued = world.wired.handleLine({
      type: "transcript",
      text: "jarvis, what time is it",
      ts: "t",
      wakeHeard: true,
    });
    await wait(20);
    world.wired.disconnected();
    world.releaseResident();
    await holding;
    const result = await queued;
    expect(result.kind).toBe("drop");
    expect(world.voicePrompts).toEqual([]);
  });
});

// ── no private context in a voice turn ──────────────────────────────────────
describe("bob#356 V2a — a voice turn sees no resident history", () => {
  it("a model that saw a private value in the resident session cannot say it from a voice turn", async () => {
    const pi = new FakePi();
    const sent: string[] = [];
    const residentHistory: string[] = [];
    const voiceHistories: string[][] = [];
    let inVoice = false;
    let admission!: ReturnType<typeof createTurnAdmission>;

    const modelReply = (history: string[]): string =>
      history.some((line) => line.includes("PRIVATE-42")) ? "PRIVATE-42" : "It is noon.";

    const resident = {
      subscribe: () => () => {},
      dispose() {},
      async prompt(text: string) {
        residentHistory.push(text);
      },
    };
    admission = createTurnAdmission({
      log: () => {},
      // FRESH: a new session per voice turn, with its own empty history.
      voiceSession: async () => {
        const history: string[] = [];
        voiceHistories.push(history);
        return {
          subscribe: () => () => {},
          dispose() {},
          async prompt(text: string) {
            history.push(text);
            const reply = modelReply(history);
            inVoice = true;
            try {
              const spoken = await pi.call("reachy_say", { text: reply });
              if (inVoice) sent.push(spoken);
            } finally {
              inVoice = false;
            }
          },
        };
      },
    });
    const wired = wireReachyCapability({
      pi,
      commands: {
        async send(command: string, args?: Record<string, unknown>) {
          if (command === "say" && typeof args?.text === "string") sent.push(String(args.text));
          return null;
        },
      },
      memory: new FakeMemory(),
      store: new FakeStore(),
      state: {
        profile: "voice",
        wakeName: "jarvis",
        enrolment: {},
        mute: false,
        nowMs: () => Date.now(),
        roomSpeechOrigins: ["run"],
      },
      sidecarVersion: TEST_SIDECAR_VERSION,
      readOrigin: () => boundOrigin({ admission }),
      admitVoiceTurn: admission.admitTurn,
      log: () => {},
    });
    await wired.connected();
    await wired.handleLine(
      healthLine(wired, {
        profile: "voice",
        wakeName: "jarvis",
        enrolment: {},
        mute: false,
        nowMs: () => Date.now(),
        roomSpeechOrigins: ["run"],
      }),
    );
    admission.bind(resident);
    // The resident session has seen the private value.
    await admission.admitTurn({ kind: "run" }, "PRIVATE-42 is your context");
    expect(residentHistory.join("\n")).toContain("PRIVATE-42");

    const summary = await wired.handleLine({
      type: "transcript",
      text: "jarvis, what time is it",
      ts: "t",
      wakeHeard: true,
    });
    expect(summary).toMatchObject({ kind: "admitted", action: "voice" });
    // The fresh voice session never carried the resident history...
    expect(voiceHistories).toHaveLength(1);
    expect(voiceHistories[0]?.join("\n")).not.toContain("PRIVATE-42");
    // ...so its model could not hand the value to reachy_say.
    expect(sent.join("\n")).not.toContain("PRIVATE-42");
    expect(sent).toContain("It is noon.");
  });
});
