// bob#356 V2a — the BOB SIDE of transcript intake: gates before inputs.
//
// The socket-backed cases run a FAKE sidecar process speaking reachy-voice/1 on
// a real UNIX socket: an addressed transcript is submitted for admission as a
// voice-origin turn with bob-issued ids and `speakerVerified:false`;
// `wakeHeard` alone never addresses; on a ready, unmuted link a malformed
// transcript is dropped with a named log line; a sidecar-reported mute drops
// the next transcript; and text recorded for an attempted say is dropped by the
// echo guard (during the estimated playback and as a recent say-match). The
// remaining cases call the real modules directly: the wake-name edit tiers,
// wire decoding, a malformed line that a mute or the handshake drops (no
// malformed audit), an unrecognised line type (a fixed, content-free reason), a
// failing audit store (refusals stand, nothing is sent), memory eligibility
// under a real parsed config, per-turn utterance cleanup, the queued-turn
// recheck (a mute or a disconnect drops it; a link that comes back first
// refuses it as stale), a turn that fails after it started (it returns a
// refusal), the admission's beforeStart for a non-voice turn, the echo guard's
// clearing on link changes, context isolation with fake sessions (the
// production path is voice-v2a-production-356.test.ts), and the tool-admission
// gate (stub tools through the real extension; the `voice` profile still
// exposes no body tool).
import { afterAll, describe, expect, it, spyOn } from "bun:test";
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
import { MAX_LINE_BYTES, UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import { parseConfig } from "../../../src/capabilities/reachy/config.js";
import { EchoGuard } from "../../../src/capabilities/reachy/echo.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";
import { addressed } from "../../../src/capabilities/reachy/policy.js";
import {
  decodeLine,
  OVERSIZED_LINE,
  UNRECOGNISED_LINE_REASON,
} from "../../../src/capabilities/reachy/wire.js";
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
  // the path: the connect itself is the only probe (and the only reader). If the
  // link never comes up, close the client and the sidecar here: the caller's
  // try/finally starts only once this returns.
  try {
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
  } catch (err) {
    client.close();
    sidecar.close();
    throw err;
  }
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
  it("accepts the name and the near-name dervis, and rejects travis", () => {
    expect(addressed("hey jarvis, what time is it", "jarvis")).toBe(true);
    expect(addressed("Hey JARVIS what time is it", "jarvis")).toBe(true);
    // A near-name transcript: two edits from jarvis, inside the allowance.
    expect(addressed("Hey Dervis, what time is it?", "jarvis")).toBe(true);
    // Three edits from jarvis: outside the allowance.
    expect(addressed("Hey Travis, what time is it?", "jarvis")).toBe(false);
    expect(addressed("what time is it", "jarvis")).toBe(false);
  });

  // The allowance is tiered by the normalized name's length: 1 edit up to four
  // characters, 2 up to eight, 3 beyond. Each pair sits on a tier's edge, so
  // moving either boundary or flattening the tiers turns one of them over.
  it("the edit allowance is tiered by the name's length, at each boundary", () => {
    const matches = (word: string, name: string) => addressed(`${word}, good morning`, name);
    // 4 characters: one edit, not two.
    expect(matches("iras", "iris")).toBe(true);
    expect(matches("uras", "iris")).toBe(false);
    // 5 characters: two edits, not three.
    expect(matches("rubyn", "robin")).toBe(true);
    expect(matches("rubyx", "robin")).toBe(false);
    // 8 characters: two edits, not three.
    expect(matches("kangslay", "kingsley")).toBe(true);
    expect(matches("kangslax", "kingsley")).toBe(false);
    // 9 characters: three edits, not four.
    expect(matches("alaxundar", "alexander")).toBe(true);
    expect(matches("ulaxundar", "alexander")).toBe(false);
    // A two-word name is sized as its normalized phrase ("hey rocky", 9).
    expect(addressed("hay rucku, good morning", "hey-rocky")).toBe(true);
    expect(addressed("hay ruckuu, good morning", "hey-rocky")).toBe(false);
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

// ── gate 3: an addressed transcript is submitted for admission as voice ─────
describe("bob#356 V2a — an addressed transcript goes through admitTurn as voice", () => {
  it("submits with speakerVerified:false and bob-issued utterance/correlation ids", async () => {
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

  it("an unverified speaker's addressed transcript is submitted and writes no memory", async () => {
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

  it("the admitted origin is projected by the REAL admission into the fresh session's prompt", async () => {
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
    // After the turn, a sidecar say proposal is refused and nothing is sent.
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

/** A voice-profile capability on a recorder channel, for single-line cases. */
function recorderWorld() {
  const store = new FakeStore();
  const logs: string[] = [];
  const state: PolicyState = {
    profile: "voice",
    wakeName: "jarvis",
    enrolment: {},
    mute: false,
    nowMs: () => Date.now(),
    roomSpeechOrigins: [],
  };
  const wired = wireReachyCapability({
    pi: new FakePi(),
    commands: {
      async send() {
        return null;
      },
    },
    memory: new FakeMemory(),
    store,
    state,
    sidecarVersion: TEST_SIDECAR_VERSION,
    readOrigin: () => undefined,
    log: (m) => logs.push(m),
  });
  const ready = async (over: Record<string, unknown> = {}) => {
    await wired.connected();
    await wired.handleLine(healthLine(wired, state, over));
    expect(wired.link().phase).toBe("ready");
  };
  const traces = () => ({
    audits: store.all.filter((e) => e.kind === "reachy.malformed").length,
    logs: logs.filter((m) => m.includes("dropped malformed input")).length,
  });
  return { wired, state, store, logs, ready, traces };
}

// ── a malformed line that a mute or the handshake drops is not "malformed" ──
describe("bob#356 V2a — a malformed line dropped by a mute or before the handshake gets no malformed audit or log", () => {
  // Wire-malformed: empty text fails the transcript schema.
  const BAD = { type: "transcript", text: "", ts: "t", wakeHeard: true };
  it("CONTROL: on a ready link with both mutes off it IS audited and logged", async () => {
    const w = recorderWorld();
    await w.ready();
    expect((await w.wired.handleLine(BAD)).kind).toBe("malformed");
    expect(w.traces()).toEqual({ audits: 1, logs: 1 });
  });

  it("under bob's mute: dropped, with neither", async () => {
    const w = recorderWorld();
    await w.ready();
    w.state.mute = true;
    expect((await w.wired.handleLine(BAD)).kind).toBe("drop");
    expect(w.traces()).toEqual({ audits: 0, logs: 0 });
  });

  it("on a ready link the sidecar reports muted: dropped, with neither", async () => {
    const w = recorderWorld();
    await w.ready({ muted: true });
    expect(w.wired.link().effectiveMuted).toBe(true);
    expect((await w.wired.handleLine(BAD)).kind).toBe("drop");
    expect(w.traces()).toEqual({ audits: 0, logs: 0 });
  });

  it("while handshaking, before the first health line: the LINK is refused instead", async () => {
    const w = recorderWorld();
    await w.wired.connected();
    expect(w.wired.link().phase).toBe("handshaking");
    await w.wired.handleLine(BAD);
    expect(w.wired.link().phase).toBe("disconnected");
    expect(w.store.all.some((e) => e.kind === "reachy.link.refused")).toBe(true);
    expect(w.traces()).toEqual({ audits: 0, logs: 0 });
  });
});

// ── an unrecognised line type gets a fixed reason ───────────────────────────
describe("bob#356 V2a — an unrecognised line type gets a fixed, content-free reason", () => {
  const MARKER = "MARKER-6f1c";

  it("decoding: an unknown, non-string or missing type gets the fixed reason", () => {
    for (const line of [{ type: `${MARKER} words` }, { type: { inner: MARKER } }, {}]) {
      expect(decodeLine(line)).toEqual({ kind: "malformed", reason: UNRECOGNISED_LINE_REASON });
    }
  });

  it("decoding: a proposal or presence line that fails its schema is named by its type", () => {
    expect(decodeLine({ type: "proposal", extra: MARKER })).toEqual({
      kind: "malformed",
      reason: "proposal line failed its schema",
    });
    expect(decodeLine({ type: "presence", extra: MARKER })).toEqual({
      kind: "malformed",
      reason: "presence line failed its schema",
    });
  });

  it('the client\'s oversized-line symbol gets the size reason; a line typed "__oversized__" is unrecognised', () => {
    expect(decodeLine(OVERSIZED_LINE)).toEqual({
      kind: "malformed",
      reason: "line exceeds the 64 KiB bound",
    });
    // Through the real socket client: a short line that names the old marker
    // string arrives as that object, and an over-bound line as the symbol.
    const client = new UnixSocketReachyClient({ socket: "/unused" });
    const lines: unknown[] = [];
    client.onLine((l) => lines.push(l));
    client.ingest('{"type":"__oversized__"}\n');
    client.ingest(`${"x".repeat(MAX_LINE_BYTES + 1)}\n`);
    expect(lines).toHaveLength(2);
    expect(decodeLine(lines[0])).toEqual({ kind: "malformed", reason: UNRECOGNISED_LINE_REASON });
    expect(lines[1]).toBe(OVERSIZED_LINE);
    expect(decodeLine('{"type":"__oversized__"}')).toEqual({
      kind: "malformed",
      reason: UNRECOGNISED_LINE_REASON,
    });
  });

  it("on a ready link: the malformed log line and audit carry the fixed reason, not the type", async () => {
    const w = recorderWorld();
    await w.ready();
    const result = await w.wired.handleLine({ type: `${MARKER} words from the line`, text: "x" });
    expect(result).toEqual({ kind: "malformed", reason: UNRECOGNISED_LINE_REASON });
    expect(w.traces()).toEqual({ audits: 1, logs: 1 }); // both were written
    expect(w.logs.join("\n")).not.toContain(MARKER);
    expect(JSON.stringify(w.store.all)).not.toContain(MARKER);
    expect(w.logs.join("\n")).toContain(UNRECOGNISED_LINE_REASON);
  });
});

// ── an audit store that fails: refusals stand, nothing is sent ──────────────
describe("bob#356 V2a — with the audit store failing, a voice turn still refuses and sends nothing", () => {
  it("the turn's reachy_say is refused unsent, and the failed turn still returns a refusal", async () => {
    const pi = new FakePi();
    const sent: string[] = [];
    const logs: string[] = [];
    let writes = 0;
    const store: OrgEventStore = {
      async write() {
        writes += 1;
        throw new Error("the audit store is down");
      },
      async getById() {
        return null;
      },
    };
    const state: PolicyState = {
      profile: "voice",
      wakeName: "jarvis",
      enrolment: {},
      mute: false,
      nowMs: () => Date.now(),
      roomSpeechOrigins: [],
    };
    let spoken: string | undefined;
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => ({
        subscribe: () => () => {},
        dispose() {},
        async prompt() {
          spoken = await pi.call("reachy_say", { text: "It is noon." });
          throw new Error("the voice turn failed after it tried to speak");
        },
      }),
    });
    admission.bind({ subscribe: () => () => {}, dispose() {}, async prompt() {} });
    const wired = wireReachyCapability({
      pi,
      commands: {
        async send(command: string) {
          sent.push(command);
          return null;
        },
      },
      memory: new FakeMemory(),
      store,
      state,
      sidecarVersion: TEST_SIDECAR_VERSION,
      readOrigin: () => boundOrigin({ admission }),
      admitVoiceTurn: admission.admitTurn,
      log: (m) => logs.push(m),
    });
    await wired.connected();
    await wired.handleLine(healthLine(wired, state));
    expect(wired.link().phase).toBe("ready");
    sent.length = 0; // only what the voice turn causes

    const result = await wired.handleLine({
      type: "transcript",
      text: "jarvis, what time is it",
      ts: "t",
      wakeHeard: true,
    });
    // The say was admitted by policy, but its audit failed: refused, unsent.
    expect(spoken).toBe("refused: audit write failed");
    expect(sent).toEqual([]);
    // The failed turn still returns a refusal, though its audit failed too.
    expect(result).toMatchObject({ kind: "refused", action: "voice" });
    expect(writes).toBeGreaterThanOrEqual(2); // both audits were attempted
    expect(logs.filter((m) => m.includes("could not persist OrgEvent")).length).toBe(writes);
  });
});

// ── gate 4: a sidecar-reported mute drops the next transcript ────────────────
describe("bob#356 V2a — a transcript after a sidecar-reported mute is not admitted", () => {
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
describe("bob#356 V2a — the echo guard drops text recorded for an attempted say", () => {
  it("say-match: a transcript matching text recorded for a say is dropped; a different one is submitted", async () => {
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

  it("playback interlock: a different transcript arriving inside the estimated playback window is dropped", async () => {
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

// ── the echo guard records before the send ──────────────────────────────────
describe("bob#356 V2a — the echo guard records a say's text before the send", () => {
  it("a say whose send fails still records its text: that transcript matches the guard", async () => {
    const SAID = "jarvis, the meeting moved to noon";
    const pi = new FakePi();
    const logs: string[] = [];
    const admissions: Admissions = [];
    const state: PolicyState = {
      profile: "voice",
      wakeName: "jarvis",
      enrolment: {},
      mute: false,
      nowMs: () => Date.now(),
      roomSpeechOrigins: ["run"],
    };
    const wired = wireReachyCapability({
      pi,
      commands: {
        async send(command: string) {
          if (command === "say") throw new Error("the sidecar write failed");
          return null;
        },
      },
      memory: new FakeMemory(),
      store: new FakeStore(),
      state,
      sidecarVersion: TEST_SIDECAR_VERSION,
      readOrigin: () => ({ kind: "run" }),
      admitVoiceTurn: async (origin, text) => {
        admissions.push({ origin, text });
        return [];
      },
      echoWindowMs: 600_000,
      playbackMs: () => 0,
      log: (m) => logs.push(m),
    });
    await wired.connected();
    await wired.handleLine(healthLine(wired, state));
    expect(wired.link().phase).toBe("ready");
    expect(await pi.call("reachy_say", { text: SAID })).toContain("sidecar send failed");
    const result = await wired.handleLine({
      type: "transcript",
      text: SAID,
      ts: "t",
      wakeHeard: true,
    });
    expect(result).toEqual({ kind: "none" });
    expect(logs.some((m) => m.includes("echo guard: say-match"))).toBe(true);
    expect(admissions).toEqual([]);
  });
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
    // Every LISTED grant tool gets the same fixed grant refusal.
    for (const grant of ["calendar_accept", "payment_send"]) {
      expect(admitToolCall(grant, voice())).toEqual({
        allow: false,
        grant: true,
        reason: VOICE_GRANT_REFUSAL,
      });
    }
    // Default-deny: a tool that does not exist yet is unreachable from voice,
    // with the generic refusal that names the one reachable tool and this one.
    expect(admitToolCall("some_future_tool", voice())).toEqual({
      allow: false,
      reason:
        "a voice-origin turn may use only reachy_say; some_future_tool is not reachable from the room",
    });
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

    // CONTROL: the same grant tool runs on a cron turn (the gate restricts only
    // voice origins).
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
    let disposals = 0;
    let releaseResident!: () => void;
    const residentGate = new Promise<void>((resolve) => {
      releaseResident = resolve;
    });
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => ({
        subscribe: () => () => {},
        dispose() {
          disposals += 1;
        },
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
    return { wired, state, admission, voicePrompts, releaseResident, disposed: () => disposals };
  }

  it("a mute while the voice turn waits drops it before its prompt", async () => {
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
    expect(world.disposed()).toBe(1); // the fresh session, built then discarded
  });

  it("a disconnect while the voice turn waits drops it before its prompt", async () => {
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
    expect(world.disposed()).toBe(1); // the fresh session, built then discarded
  });

  // The link comes BACK before the turn starts: effective mute is off again, so
  // only the epoch says the transcript belongs to a link that is gone.
  async function queuedThenRestored(
    restore: (world: ReturnType<typeof queuedWorld>) => Promise<void>,
  ) {
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
    await restore(world);
    expect(world.wired.link().phase).toBe("ready");
    expect(world.wired.link().effectiveMuted).toBe(false);
    world.releaseResident();
    await holding;
    return { world, result: await queued };
  }

  it("a reconnect to a fresh READY link while the voice turn waits refuses it as stale", async () => {
    const { world, result } = await queuedThenRestored(async (w) => {
      w.wired.disconnected();
      await w.wired.connected();
      await w.wired.handleLine(healthLine(w.wired, w.state));
    });
    expect(result).toMatchObject({ kind: "refused", action: "voice" });
    expect(JSON.stringify(result)).toContain(
      "stale: the sidecar link changed while the voice turn waited",
    );
    expect(world.voicePrompts).toEqual([]);
    expect(world.disposed()).toBe(1); // the fresh session, built then discarded
  });

  it("a device mute and unmute while the voice turn waits refuses it as stale", async () => {
    const { world, result } = await queuedThenRestored(async (w) => {
      await w.wired.handleLine(healthLine(w.wired, w.state, { muted: true }));
      expect(w.wired.link().effectiveMuted).toBe(true);
      await w.wired.handleLine(healthLine(w.wired, w.state, { muted: false }));
    });
    expect(result).toMatchObject({ kind: "refused", action: "voice" });
    expect(JSON.stringify(result)).toContain(
      "stale: the sidecar link changed while the voice turn waited",
    );
    expect(world.voicePrompts).toEqual([]);
    expect(world.disposed()).toBe(1); // the fresh session, built then discarded
  });

  // Only the starting-line mute is a drop. A turn that failed for any other
  // reason returns a refusal and attempts its audit (the store works here, so
  // the audit is written), even when the link went quiet before the failure
  // was caught.
  type Wired = ReturnType<typeof wireReachyCapability>;
  type AdmitVoice = (
    origin: TurnOrigin,
    text: string,
    opts?: { beforeStart?: () => string | null },
  ) => Promise<unknown[]>;
  /** A capability on a recorder channel whose voice admission `make` builds;
   *  `wired()` reads the capability lazily, so the admission can drive it. */
  function failingWorld(make: (world: { wired: () => Wired; state: PolicyState }) => AdmitVoice) {
    const store = new FakeStore();
    const state: PolicyState = {
      profile: "voice",
      wakeName: "jarvis",
      enrolment: {},
      mute: false,
      nowMs: () => Date.now(),
      roomSpeechOrigins: [],
    };
    let wired!: Wired;
    const admitVoiceTurn = make({ wired: () => wired, state });
    wired = wireReachyCapability({
      pi: new FakePi(),
      commands: {
        async send() {
          return null;
        },
      },
      memory: new FakeMemory(),
      store,
      state,
      sidecarVersion: TEST_SIDECAR_VERSION,
      readOrigin: () => undefined,
      admitVoiceTurn,
      log: () => {},
    });
    return { wired, state, store };
  }
  const addressedLine = {
    type: "transcript",
    text: "jarvis, what time is it",
    ts: "t",
    wakeHeard: true,
  };

  it("a turn that passed beforeStart and then failed after a disconnect is REFUSED, with its audit written", async () => {
    const world = failingWorld(({ wired }) => async (_origin, _text, opts) => {
      expect(opts?.beforeStart?.()).toBeNull(); // the turn starts
      wired().disconnected(); // the link goes away mid-turn
      throw new Error("the voice turn failed after it started");
    });
    await world.wired.connected();
    await world.wired.handleLine(healthLine(world.wired, world.state));
    const result = await world.wired.handleLine(addressedLine);
    expect(world.wired.link().effectiveMuted).toBe(true); // quiet when caught
    expect(result).toMatchObject({ kind: "refused", action: "voice" });
    const refused = world.store.all.filter((e) => e.kind === "reachy.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.summary).toContain("the voice turn failed after it started");
  });

  it("a voice session that failed to start after a device mute is REFUSED, with its audit written", async () => {
    // The REAL admission: voiceSession() runs before beforeStart, so a session
    // that cannot start never reaches the starting-line check.
    const world = failingWorld(({ wired, state }) => {
      const admission = createTurnAdmission({
        log: () => {},
        voiceSession: async () => {
          await wired().handleLine(healthLine(wired(), state, { muted: true }));
          throw new Error("the voice session could not start");
        },
      });
      admission.bind({ subscribe: () => () => {}, dispose() {}, async prompt() {} });
      return admission.admitTurn;
    });
    await world.wired.connected();
    await world.wired.handleLine(healthLine(world.wired, world.state));
    const result = await world.wired.handleLine(addressedLine);
    expect(world.wired.link().effectiveMuted).toBe(true); // quiet when caught
    expect(result).toMatchObject({ kind: "refused", action: "voice" });
    const refused = world.store.all.filter((e) => e.kind === "reachy.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.summary).toContain("the voice session could not start");
  });

  it("beforeStart is checked for a queued NON-voice turn too, when it leaves the queue", async () => {
    const prompts: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admission = createTurnAdmission({ log: () => {} });
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt(text: string) {
        prompts.push(text);
        if (text === "hold") await held;
      },
    });
    const holding = admission.admitTurn({ kind: "cron", job: "hold" }, "hold");
    let checks = 0;
    const refused = admission.admitTurn({ kind: "cron", job: "digest" }, "digest", {
      beforeStart: () => {
        checks += 1;
        return "the digest is no longer due";
      },
    });
    const allowed = admission.admitTurn({ kind: "cron", job: "later" }, "later", {
      beforeStart: () => null,
    });
    await wait(20);
    expect(checks).toBe(0); // still queued behind the held turn
    release();
    await holding;
    await expect(refused).rejects.toThrow("bob: turn not admitted: the digest is no longer due");
    await allowed;
    expect(checks).toBe(1);
    expect(prompts).toEqual(["hold", "later"]);
  });
});

// ── no resident history in a voice turn (fake sessions) ─────────────────────
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

// ── the capability clears its echo guard on every link change ───────────────
describe("bob#356 V2a — wireReachyCapability clears its echo guard on link changes", () => {
  const SAID = "jarvis, the meeting moved to noon";

  /** A capability on a recorder channel (no device, no audio) whose speech is
   *  granted to `run`. The say-match window outlasts the test and the ESTIMATED
   *  playback window is zero, so the say-match is the guard under test. */
  async function echoWorld() {
    const pi = new FakePi();
    const admissions: Admissions = [];
    const logs: string[] = [];
    const state: PolicyState = {
      profile: "voice",
      wakeName: "jarvis",
      enrolment: {},
      mute: false,
      nowMs: () => Date.now(),
      roomSpeechOrigins: ["run"],
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
      readOrigin: () => ({ kind: "run" }),
      admitVoiceTurn: async (origin, text) => {
        admissions.push({ origin, text });
        return [];
      },
      echoWindowMs: 600_000,
      playbackMs: () => 0,
      log: (m) => logs.push(m),
    });
    const handshake = async () => {
      await wired.connected();
      await wired.handleLine(healthLine(wired, state));
      expect(wired.link().phase).toBe("ready");
    };
    const receive = (text: string) =>
      wired.handleLine({ type: "transcript", text, ts: "t", wakeHeard: true });
    await handshake();
    // bob sends the line as a `say`, and the same text sent back as a
    // transcript is dropped by the say-match: the control.
    expect(await pi.call("reachy_say", { text: SAID })).toBe(`say: ${SAID}`);
    expect(await receive(SAID)).toEqual({ kind: "none" });
    expect(logs.some((m) => m.includes("echo guard: say-match"))).toBe(true);
    expect(admissions).toEqual([]);
    return { wired, state, admissions, handshake, receive };
  }

  it("a disconnect and a fresh handshake: the recorded text no longer matches the guard", async () => {
    const world = await echoWorld();
    world.wired.disconnected();
    await world.handshake();
    expect(await world.receive(SAID)).toMatchObject({ kind: "admitted", action: "voice" });
    expect(world.admissions).toHaveLength(1);
  });

  it("a new connection without a disconnect notice: the handshake alone clears it", async () => {
    const world = await echoWorld();
    await world.handshake();
    expect(await world.receive(SAID)).toMatchObject({ kind: "admitted", action: "voice" });
  });

  it("a refused link (health mismatch) and a reconnect: cleared", async () => {
    const world = await echoWorld();
    await world.wired.handleLine(
      healthLine(world.wired, world.state, { version: "another-sidecar" }),
    );
    expect(world.wired.link().phase).toBe("disconnected");
    await world.handshake();
    expect(await world.receive(SAID)).toMatchObject({ kind: "admitted", action: "voice" });
  });

  it("a device mute flip (unmuted, muted, unmuted) on the same link: cleared", async () => {
    const world = await echoWorld();
    await world.wired.handleLine(healthLine(world.wired, world.state, { muted: true }));
    expect(world.wired.link().effectiveMuted).toBe(true);
    await world.wired.handleLine(healthLine(world.wired, world.state, { muted: false }));
    expect(world.wired.link().phase).toBe("ready");
    expect(world.wired.link().effectiveMuted).toBe(false);
    expect(await world.receive(SAID)).toMatchObject({ kind: "admitted", action: "voice" });
  });

  it("each of the four link changes clears the guard itself", async () => {
    // A later handshake also clears, so the behaviour above cannot tell a
    // disconnect's or a refusal's own clear from the reconnect's. Count them.
    const clears = spyOn(EchoGuard.prototype, "clear");
    try {
      const world = await echoWorld();
      const count = () => clears.mock.calls.length;
      const at = count();
      world.wired.disconnected();
      expect(count()).toBe(at + 1);
      await world.wired.connected();
      expect(count()).toBe(at + 2);
      await world.wired.handleLine(healthLine(world.wired, world.state));
      expect(count()).toBe(at + 2); // the first health line of a link is no change
      await world.wired.handleLine(healthLine(world.wired, world.state, { muted: true }));
      expect(count()).toBe(at + 3);
      await world.wired.handleLine(healthLine(world.wired, world.state, { muted: true }));
      expect(count()).toBe(at + 3); // no flip, no clear
      await world.wired.handleLine(
        healthLine(world.wired, world.state, { version: "another-sidecar" }),
      );
      expect(count()).toBe(at + 4);
    } finally {
      clears.mockRestore();
    }
  });
});
