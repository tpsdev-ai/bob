// bob#356 V1 ("mouth first") — the acceptance list of rev 2.1, against the
// testable core (fakes; no socket, no sidecar):
//   authorized say without a transcript; forbidden and stale callers refused;
//   body tools absent under voice; the reachy-voice/1 handshake (mismatch,
//   one bounded alarm, reconnect); mute (bob, device, unknown/disconnected);
//   an audit failure blocks speech; a send failure is a linked refusal; a
//   presence line under voice is a content-free malformed audit.
// The isolation proofs are isolation.test.ts; the real sidecar's speech path is
// voice-sidecar.test.ts.
import { describe, expect, it } from "bun:test";
import { Value } from "typebox/value";
import {
  type OrgEventStore,
  orgEventRecordId,
  type PiLike,
  type ReachyCommands,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import {
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  superviseLink,
  UnixSocketReachyClient,
} from "../../../src/capabilities/reachy/client.js";
import {
  DEFAULT_PROFILE,
  loadConfigFromEnv,
  PROFILE_TOOLS,
  parseConfig,
} from "../../../src/capabilities/reachy/config.js";
import { reachyManifest } from "../../../src/capabilities/reachy/manifest.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";
import {
  checkHealth,
  decodeLine,
  HEALTH_LINE,
  VOICE_PROTOCOL,
} from "../../../src/capabilities/reachy/wire.js";
import type { TurnOrigin } from "../../../src/shell/turn-origin.js";
import { handshake, healthLine, must, TEST_MODEL_HASH, TEST_SIDECAR_VERSION } from "./handshake.js";

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
    const t = this.tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    return (await t.execute("tc", params)).content.map((c) => c.text).join("");
  }
}
/** Records every command; `failOn` makes those commands' sends throw. */
class FakeCommands implements ReachyCommands {
  readonly sent: Array<{ command: string; args?: Record<string, unknown> }> = [];
  failOn = new Set<string>();
  disconnects = 0;
  /** Called when the store's write starts, to interleave events (stale tests). */
  async send(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (this.failOn.has(command)) throw new Error(`send of ${command} failed`);
    this.sent.push({ command, args });
    return null;
  }
  disconnect(): void {
    this.disconnects++;
  }
}
class FakeStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  fail = false;
  /** Runs inside a write, before it completes (to change state mid-await). */
  during?: (event: OrgEvent) => void;
  order: string[];
  constructor(order: string[]) {
    this.order = order;
  }
  async write(event: OrgEvent): Promise<{ id: string }> {
    this.during?.(event);
    if (this.fail) throw new Error("event store unavailable");
    this.all.push(event);
    this.order.push(`audit:${event.kind}`);
    return { id: orgEventRecordId(event) };
  }
  async getById(): Promise<OrgEvent | null> {
    return null;
  }
}

function harness(
  opts: {
    profile?: "voice" | "reachy";
    roomSpeechOrigins?: string[];
    origin?: TurnOrigin | undefined;
    noAdmission?: boolean;
    mute?: boolean;
  } = {},
) {
  const order: string[] = [];
  const pi = new FakePi();
  const commands = new FakeCommands();
  const sendRaw = commands.send.bind(commands);
  commands.send = async (command, args) => {
    const r = await sendRaw(command, args);
    order.push(`send:${command}`);
    return r;
  };
  const store = new FakeStore(order);
  const logs: string[] = [];
  const state: PolicyState = {
    profile: opts.profile ?? "voice",
    wakeName: "jarvis",
    enrolment: {},
    mute: opts.mute ?? false,
    nowMs: () => 1_000,
    roomSpeechOrigins: opts.roomSpeechOrigins ?? ["run"],
  };
  let origin: TurnOrigin = opts.origin ?? { kind: "run" };
  const wired = wireReachyCapability({
    pi,
    commands,
    memory: { writePrivate: async () => ({ id: "m" }) },
    store,
    state,
    sidecarVersion: TEST_SIDECAR_VERSION,
    ...(opts.noAdmission ? {} : { readOrigin: () => origin }),
    log: (m) => logs.push(m),
  });
  return {
    pi,
    commands,
    store,
    state,
    wired,
    logs,
    order,
    setOrigin: (o: TurnOrigin) => {
      origin = o;
    },
    ready: async (over: Record<string, unknown> = {}) => {
      const r = await handshake(wired, state, over);
      commands.sent.length = 0;
      order.length = 0;
      return r;
    },
  };
}
const said = (h: ReturnType<typeof harness>) => h.commands.sent.filter((c) => c.command === "say");

// ── profile ─────────────────────────────────────────────────────────────────
describe("bob#356 V1 — the bob-owned profile", () => {
  it("defaults to voice; an unknown profile is refused by the config schema", () => {
    expect(DEFAULT_PROFILE).toBe("voice");
    expect(parseConfig({ socket: "/s", sidecarVersion: "1" }).profile).toBe("voice");
    expect(parseConfig({ socket: "/s", sidecarVersion: "1", profile: "reachy" }).profile).toBe(
      "reachy",
    );
    expect(() => parseConfig({ socket: "/s", sidecarVersion: "1", profile: "robot" })).toThrow(
      /config is invalid \(at \/profile\)/,
    );
    expect(() =>
      loadConfigFromEnv({
        BOB_CAP_REACHY: JSON.stringify({ socket: "/s", sidecarVersion: "1", profile: "" }),
      }),
    ).toThrow(/profile/);
  });

  it("under voice the EFFECTIVE registry has no body tool; under reachy it has all four", () => {
    const voice = harness({ profile: "voice" });
    expect([...voice.pi.tools.keys()].sort()).toEqual(["reachy_say", "reachy_state"]);
    expect(voice.wired.tools).toEqual(PROFILE_TOOLS.voice);
    const body = harness({ profile: "reachy" });
    expect([...body.pi.tools.keys()].sort()).toEqual([
      "reachy_frame",
      "reachy_look",
      "reachy_say",
      "reachy_state",
    ]);
  });

  it("the manifest declares the union AND the per-profile map, and every row is in the union", () => {
    const provides = must(reachyManifest.provides, "provides");
    expect(provides.toolsByConfig?.field).toBe("profile");
    expect(provides.toolsByConfig?.default).toBe("voice");
    for (const row of Object.values(provides.toolsByConfig?.values)) {
      for (const t of row) expect(provides.tools).toContain(t);
    }
  });

  it("body PROPOSALS under voice refuse (look, frame, acknowledge) and send nothing", async () => {
    const h = harness({ profile: "voice" });
    await h.ready();
    for (const [action, args] of [
      ["look", { yaw: 1, pitch: 0 }],
      ["frame", {}],
      ["acknowledge", {}],
    ] as const) {
      const r = await h.wired.handleLine({
        type: "proposal",
        action,
        args,
        confidence: 1,
        inputs: [],
      });
      expect(r).toMatchObject({
        kind: "refused",
        reason: "body actions are absent under the voice profile",
      });
    }
    expect(h.commands.sent).toEqual([]);
  });

  it("a presence line under voice is a bounded, content-free malformed audit (and ignored under reachy)", async () => {
    const h = harness({ profile: "voice" });
    await h.ready();
    const r = await h.wired.handleLine({ type: "presence", count: 7, known: ["spk-secret-id"] });
    expect(r.kind).toBe("malformed");
    const ev = must(
      h.store.all.find((e) => e.kind === "reachy.malformed"),
      "the malformed event",
    );
    expect(ev.summary).toContain("voice profile");
    expect(ev.summary).not.toContain("spk-secret-id");
    expect(ev.summary).not.toContain("7");
    const body = harness({ profile: "reachy" });
    await body.ready();
    expect((await body.wired.handleLine({ type: "presence", count: 1, known: [] })).kind).toBe(
      "none",
    );
  });
});

// ── the reachy-voice/1 wire and handshake ───────────────────────────────────
describe("bob#356 V1 — the strict reachy-voice/1 health line", () => {
  const good = {
    type: "health",
    protocol: VOICE_PROTOCOL,
    version: "v",
    profile: "voice",
    generation: 1,
    wakeName: "jarvis",
    mode: "off",
    trainedPhrase: null,
    modelHash: null,
    muted: false,
    ok: true,
  };
  it("accepts exactly the protocol's fields; legacy, missing, unknown and out-of-bound fields are malformed", () => {
    expect(Value.Check(HEALTH_LINE, good)).toBe(true);
    expect(decodeLine(good).kind).toBe("health");
    const { version: _v, ...missing } = good;
    for (const bad of [
      { type: "health", ok: true }, // the legacy line
      missing,
      { ...good, extra: 1 },
      { ...good, protocol: "reachy-voice/2" },
      { ...good, generation: 0 },
      { ...good, mode: "listening" },
      { ...good, modelHash: "XYZ" },
      { ...good, wakeName: "x".repeat(33) },
      { ...good, muted: "no" },
    ]) {
      expect(decodeLine(bad)).toMatchObject({ kind: "malformed", protocol: true });
    }
  });
  it("checkHealth names every mismatched field (never its value) and enforces the trained-artifact rule", () => {
    const expect_ = { version: "v", profile: "voice" as const, wakeName: "jarvis", generation: 3 };
    const h = (over: Record<string, unknown>) => ({ ...good, generation: 3, ...over }) as never;
    expect(checkHealth(h({}), expect_)).toEqual([]);
    expect(checkHealth(h({ version: "w" }), expect_)).toEqual(["version"]);
    expect(checkHealth(h({ profile: "reachy" }), expect_)).toEqual(["profile"]);
    expect(checkHealth(h({ wakeName: "rocky" }), expect_)).toEqual(["wakeName"]);
    expect(checkHealth(h({ generation: 2 }), expect_)).toEqual(["generation"]);
    expect(checkHealth(h({ ok: false }), expect_)).toEqual(["ok"]);
    // trained: the artifact must be for THIS name, and present
    expect(
      checkHealth(
        h({ mode: "trained", trainedPhrase: "jarvis", modelHash: TEST_MODEL_HASH }),
        expect_,
      ),
    ).toEqual([]);
    expect(
      checkHealth(
        h({ mode: "trained", trainedPhrase: "rocky", modelHash: TEST_MODEL_HASH }),
        expect_,
      ),
    ).toEqual(["trainedPhrase"]);
    expect(
      checkHealth(h({ mode: "trained", trainedPhrase: "jarvis", modelHash: null }), expect_),
    ).toEqual(["modelHash"]);
    // gate-only (training) explicitly carries no matching trained artifact
    expect(
      checkHealth(h({ mode: "gate-only", trainedPhrase: "rocky", modelHash: null }), expect_),
    ).toEqual([]);
  });
});

describe("bob#356 V1 — the handshake: control/status first, mismatch disconnects with one alarm, reconnect", () => {
  it("connected() sends ONE control command, `configure`, carrying bob's protocol, profile, wake name and generation", async () => {
    const h = harness();
    await h.wired.connected();
    expect(h.commands.sent).toEqual([
      {
        command: "configure",
        args: { protocol: VOICE_PROTOCOL, profile: "voice", wakeName: "jarvis", generation: 1 },
      },
    ]);
    expect(h.wired.link().phase).toBe("handshaking");
    expect(h.wired.link().effectiveMuted).toBe(true); // unknown = muted
  });

  it("before the handshake no action is sent, and a non-health line fails the link", async () => {
    const h = harness();
    expect(await h.pi.call("reachy_say", { text: "hi" })).toContain("refused: muted");
    await h.wired.connected();
    h.commands.sent.length = 0;
    expect(await h.pi.call("reachy_say", { text: "hi" })).toContain("refused: muted");
    expect(h.commands.sent).toEqual([]);
    const r = await h.wired.handleLine({
      type: "transcript",
      text: "jarvis hi",
      ts: "t",
      wakeHeard: true,
    });
    expect(r).toMatchObject({ kind: "refused", action: "handshake" });
    expect(h.commands.disconnects).toBe(1);
    expect(h.wired.link().phase).toBe("disconnected");
  });

  it.each([
    ["version", { version: "other-sidecar" }],
    ["profile", { profile: "reachy" }],
    ["wakeName", { wakeName: "rocky" }],
    ["generation", { generation: 99 }],
    ["ok", { ok: false }],
  ])("a %s mismatch disconnects and raises ONE bounded alarm", async (field, over) => {
    const h = harness();
    const r = await h.ready(over);
    expect(r).toMatchObject({ kind: "refused", action: "handshake" });
    expect(h.commands.disconnects).toBe(1);
    expect(h.wired.link().phase).toBe("disconnected");
    const alarms = h.store.all.filter((e) => e.kind === "reachy.link.refused");
    expect(alarms.length).toBe(1);
    // bounded and content-free: EXACTLY the field name, never the sidecar's value
    expect(alarms[0]?.summary).toBe(
      `refused the sidecar link: ${field} did not match the reachy-voice/1 handshake; disconnected`,
    );
  });

  it("a legacy health line fails the handshake (no per-line audit flood); a repeat failure alarms once", async () => {
    const h = harness();
    await h.wired.connected();
    await h.wired.handleLine({ type: "health", ok: true });
    await h.wired.connected();
    await h.wired.handleLine({ type: "health", ok: true });
    expect(h.store.all.filter((e) => e.kind === "reachy.link.refused").length).toBe(1);
    expect(h.store.all.filter((e) => e.kind === "reachy.malformed").length).toBe(0);
    expect(h.logs.filter((m) => m.includes("handshake refused")).length).toBe(2);
  });

  it("reconnect: a fresh handshake with the NEXT generation works; the old generation's health is refused", async () => {
    const h = harness();
    await h.ready({ version: "wrong" });
    expect(h.wired.link().phase).toBe("disconnected");
    await h.wired.connected();
    expect(h.wired.link().generation).toBe(2);
    const stale = await h.wired.handleLine(healthLine(h.wired, h.state, { generation: 1 }));
    expect(stale).toMatchObject({ kind: "refused", action: "handshake" });
    await h.wired.connected();
    expect((await h.wired.handleLine(healthLine(h.wired, h.state))).kind).toBe("none");
    expect(h.wired.link()).toMatchObject({ phase: "ready", generation: 3, effectiveMuted: false });
    // the alarm repeats only for a NEW failure after a good handshake
    await h.wired.handleLine(healthLine(h.wired, h.state, { version: "wrong" }));
    expect(h.store.all.filter((e) => e.kind === "reachy.link.refused").length).toBe(3);
  });

  it("a READY link that reports a mismatched health line later is disconnected too", async () => {
    const h = harness();
    await h.ready();
    expect(h.wired.link().phase).toBe("ready");
    await h.wired.handleLine(healthLine(h.wired, h.state, { profile: "reachy" }));
    expect(h.wired.link().phase).toBe("disconnected");
    expect(await h.pi.call("reachy_say", { text: "hi" })).toContain("refused: muted");
  });

  it("lines that arrive after a disconnect are dropped, unaudited", async () => {
    const h = harness();
    await h.ready();
    h.wired.disconnected();
    const before = h.store.all.length;
    expect((await h.wired.handleLine("not json")).kind).toBe("drop");
    expect(h.store.all.length).toBe(before);
  });
});

// ── the say split ───────────────────────────────────────────────────────────
describe("bob#356 V1 — the say caller split (Kern 5)", () => {
  it("AUTHORIZED: a granted turn speaks with NO transcript ever seen; the audit is written BEFORE the send and names the playback", async () => {
    const h = harness({
      roomSpeechOrigins: ["cron:standup"],
      origin: { kind: "cron", job: "standup" },
    });
    await h.ready();
    expect(h.wired.lastTranscript()).toBeNull();
    expect(await h.pi.call("reachy_say", { text: "Standup in five minutes." })).toBe(
      "say: Standup in five minutes.",
    );
    const [say] = said(h);
    expect(say?.args?.text).toBe("Standup in five minutes.");
    expect(String(say?.args?.playbackId)).toMatch(/^play_/);
    expect(h.order).toEqual(["audit:reachy.say", "send:say"]);
    const ev = must(
      h.store.all.find((e) => e.kind === "reachy.say"),
      "the say event",
    );
    expect(ev.targetIds).toContain(say?.args?.playbackId);
    // the audit is content-free: the spoken text is not in it
    expect(JSON.stringify(ev)).not.toContain("Standup in five minutes.");
  });

  it("a one-shot `bob run` (no admission) is an operator's run: it speaks only when `run` is granted", async () => {
    const granted = harness({ noAdmission: true, roomSpeechOrigins: ["run"] });
    await granted.ready();
    expect(await granted.pi.call("reachy_say", { text: "hi" })).toBe("say: hi");
    const denied = harness({ noAdmission: true, roomSpeechOrigins: [] });
    await denied.ready();
    expect(await denied.pi.call("reachy_say", { text: "hi" })).toContain(
      "no room-publication grant",
    );
    expect(said(denied)).toEqual([]);
  });

  it.each([
    ["an ungranted cron job", { kind: "cron", job: "other" }],
    ["an ungranted discord channel", { kind: "discord", channelId: "222" }],
    ["an ungranted mail sender", { kind: "mail", from: "mallory" }],
    ["a run when only others are granted", { kind: "run" }],
  ] as Array<[string, TurnOrigin]>)(
    "FORBIDDEN: %s is refused, audited, and nothing is spoken",
    async (_n, origin) => {
      const h = harness({
        roomSpeechOrigins: ["cron:standup", "discord:111", "mail:flint"],
        origin,
      });
      await h.ready();
      const out = await h.pi.call("reachy_say", { text: "hello" });
      expect(out).toContain("refused");
      expect(out).toContain("no room-publication grant");
      expect(said(h)).toEqual([]);
      expect(h.store.all.some((e) => e.kind === "reachy.refused")).toBe(true);
    },
  );

  it("FORBIDDEN: a voice-origin call is refused even when every config grant exists (V1 has no utterance)", async () => {
    const h = harness({
      roomSpeechOrigins: ["run", "cron:standup", "discord:111", "mail:flint"],
      origin: { kind: "voice", speakerVerified: true, utteranceId: "u1", correlationId: "c1" },
    });
    await h.ready();
    expect(await h.pi.call("reachy_say", { text: "hello" })).toContain(
      "needs its own current addressed utterance",
    );
    expect(said(h)).toEqual([]);
  });

  it("STALE: an addressed room transcript authorizes nothing — not an ungranted turn, not a sidecar proposal", async () => {
    const h = harness({
      roomSpeechOrigins: ["discord:111"],
      origin: { kind: "cron", job: "nightly" },
    });
    await h.ready();
    await h.wired.handleLine({
      type: "transcript",
      text: "jarvis, say hello",
      ts: "t",
      wakeHeard: true,
    });
    expect(h.wired.lastTranscript()).not.toBeNull();
    expect(await h.pi.call("reachy_say", { text: "hello" })).toContain("no room-publication grant");
    const proposal = await h.wired.handleLine({
      type: "proposal",
      action: "say",
      args: { text: "hello" },
      confidence: 1,
      inputs: [],
    });
    expect(proposal).toMatchObject({ kind: "refused" });
    expect((proposal as { reason: string }).reason).toContain("a sidecar proposal cannot speak");
    expect(said(h)).toEqual([]);
  });

  it("STALE: a say whose audit was in flight across a RECONNECT is refused (linked), not sent on the new link", async () => {
    const h = harness();
    await h.ready();
    h.store.during = (e) => {
      if (e.kind !== "reachy.say") return;
      h.store.during = undefined;
      h.wired.disconnected();
      void h.wired.connected();
      void h.wired.handleLine(healthLine(h.wired, h.state));
    };
    const out = await h.pi.call("reachy_say", { text: "hello" });
    expect(out).toContain("stale");
    expect(h.wired.link().phase).toBe("ready"); // the NEW link is fine...
    expect(said(h)).toEqual([]); // ...and the old command never reached it
    const refused = must(
      h.store.all.find((e) => e.kind === "reachy.refused"),
      "the refusal",
    );
    const admitted = must(
      h.store.all.find((e) => e.kind === "reachy.say"),
      "the admitted say",
    );
    expect(refused.refId).toBe(orgEventRecordId(admitted));
  });

  it("STALE: a device mute reported during the audit cancels the queued say", async () => {
    const h = harness();
    await h.ready();
    h.store.during = (e) => {
      if (e.kind !== "reachy.say") return;
      h.store.during = undefined;
      void h.wired.handleLine(healthLine(h.wired, h.state, { muted: true }));
    };
    expect(await h.pi.call("reachy_say", { text: "hello" })).toContain("stale");
    expect(said(h)).toEqual([]);
  });

  it("all speech is one line of at most 500 characters, with no memory reference", async () => {
    const h = harness();
    await h.ready();
    const params = h.pi.tools.get("reachy_say")?.parameters as never;
    expect(Value.Check(params, { text: "x".repeat(500) })).toBe(true);
    expect(Value.Check(params, { text: "x".repeat(501) })).toBe(false);
    expect(Value.Check(params, { text: "a\nb" })).toBe(false);
    expect(Value.Check(params, { text: "hi", memoryId: "m" })).toBe(false);
    expect(await h.pi.call("reachy_say", { text: "x".repeat(501) })).toContain("refused");
    expect(await h.pi.call("reachy_say", { text: "hi", memoryId: "m" })).toContain("refused");
    expect(said(h)).toEqual([]);
  });
});

// ── mute, audit failure, send failure ───────────────────────────────────────
describe("bob#356 V1 — mute, audit failure and send failure", () => {
  it("effective mute = bob mute OR device mute OR no ready link: each blocks speech, and the device unmute restores it", async () => {
    const bob = harness({ mute: true });
    await bob.wired.connected();
    await bob.wired.handleLine(healthLine(bob.wired, bob.state)); // dropped: bob mute
    expect(await bob.pi.call("reachy_say", { text: "hi" })).toContain("refused: muted");
    expect(said(bob)).toEqual([]);

    const device = harness();
    await device.ready({ muted: true });
    expect(device.wired.link()).toMatchObject({
      phase: "ready",
      deviceMuted: true,
      effectiveMuted: true,
    });
    expect(await device.pi.call("reachy_say", { text: "hi" })).toContain("refused: muted");
    // the device mute drops transcripts too
    expect(
      (
        await device.wired.handleLine({
          type: "transcript",
          text: "jarvis",
          ts: "t",
          wakeHeard: true,
        })
      ).kind,
    ).toBe("drop");
    await device.wired.handleLine(healthLine(device.wired, device.state, { muted: false }));
    expect(await device.pi.call("reachy_say", { text: "hi" })).toBe("say: hi");

    const gone = harness();
    await gone.ready();
    gone.wired.disconnected();
    expect(gone.wired.link().effectiveMuted).toBe(true);
    expect(await gone.pi.call("reachy_say", { text: "hi" })).toContain("refused: muted");
    expect(said(gone)).toEqual([]);
  });

  it("a mute flip forgets the last transcript (no buffered words survive it)", async () => {
    const h = harness();
    await h.ready();
    await h.wired.handleLine({ type: "transcript", text: "jarvis hi", ts: "t", wakeHeard: true });
    expect(h.wired.lastTranscript()).not.toBeNull();
    await h.wired.handleLine(healthLine(h.wired, h.state, { muted: true }));
    expect(h.wired.lastTranscript()).toBeNull();
  });

  it("an AUDIT failure blocks speech: refused, nothing sent", async () => {
    const h = harness();
    await h.ready();
    h.store.fail = true;
    expect(await h.pi.call("reachy_say", { text: "hi" })).toBe("refused: audit write failed");
    expect(said(h)).toEqual([]);
  });

  it("a SEND failure is a linked refusal, never an unhandled rejection or a 'said'", async () => {
    const h = harness();
    await h.ready();
    h.commands.failOn.add("say");
    const out = await h.pi.call("reachy_say", { text: "hi" });
    expect(out).toContain("refused: sidecar send failed");
    const admitted = must(
      h.store.all.find((e) => e.kind === "reachy.say"),
      "the admitted say",
    );
    const refused = must(
      h.store.all.find((e) => e.kind === "reachy.refused"),
      "the refusal",
    );
    expect(refused.refId).toBe(orgEventRecordId(admitted));
  });

  it("a failed `configure` send fails the link (disconnect + alarm), it does not hang in handshaking", async () => {
    const h = harness();
    h.commands.failOn.add("configure");
    await h.wired.connected();
    expect(h.wired.link().phase).toBe("disconnected");
    expect(h.store.all.filter((e) => e.kind === "reachy.link.refused").length).toBe(1);
  });
});

// ── the link supervisor and the socket client ───────────────────────────────
describe("bob#356 V1 — reconnect supervision and per-connection buffers", () => {
  it("backs off doubling to the cap while the link never gets ready; a READY link resets it", async () => {
    let fail = true;
    const close: Array<() => void> = [];
    let phase: "disconnected" | "handshaking" | "ready" = "disconnected";
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    const sup = superviseLink({
      client: {
        async connect() {
          if (fail) throw new Error("ECONNREFUSED");
        },
        onClose: (l) => close.push(l),
      },
      wired: {
        async connected() {
          phase = "ready";
        },
        disconnected() {
          phase = "disconnected";
        },
        link: () => ({
          phase,
          generation: 0,
          deviceMuted: undefined,
          effectiveMuted: true,
          health: null,
        }),
      },
      schedule: (fn, ms) => {
        delays.push(ms);
        pending.push(fn);
      },
      log: () => {},
    });
    await sup.start();
    for (let i = 0; i < 8; i++) {
      const next = must(pending.shift(), "a scheduled retry");
      next();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(delays.slice(0, 4)).toEqual([RECONNECT_MIN_MS, 2_000, 4_000, 8_000]);
    expect(Math.max(...delays)).toBe(RECONNECT_MAX_MS);
    // now the sidecar comes back, the handshake completes, and later the link drops
    fail = false;
    pending.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(phase).toBe("ready");
    close[0]?.();
    expect(delays.at(-1)).toBe(RECONNECT_MIN_MS);
  });

  it("a partial line from a dropped connection never prefixes the next connection's first line", async () => {
    const client = new UnixSocketReachyClient({ socket: "/nonexistent" });
    const lines: unknown[] = [];
    client.onLine((l) => lines.push(l));
    client.ingest('{"type":"transcript","text":"half');
    // a reconnect starts with a cleared buffer (connect() resets it first)
    await client.connect().catch(() => {});
    client.ingest('{"type":"presence","count":1,"known":[]}\n');
    expect(lines).toEqual([{ type: "presence", count: 1, known: [] }]);
  });
});
