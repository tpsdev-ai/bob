// bob#356 V1 — the REAL reachy-voice sidecar (sidecar/reachy-voice/sidecar.py),
// unconfined, on a supported Unix host with python3: the reachy-voice/1 handshake against
// bob's real client and core, and local text-to-speech after which the work
// directory contains only the stand-in player's observation record.
// Piper and the OS player are stand-ins (test/fixtures/reachy-voice):
// what is under test is the sidecar's artifact handling, not the voice.
// The same sidecar under the deny-default profile, and as its own user, is
// isolation.test.ts.
import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OrgEventStore,
  orgEventRecordId,
  type PiLike,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";
import { must } from "./handshake.js";
import { probeVoiceHandshake } from "./handshake-proof.js";

const digest = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

const REPO = join(import.meta.dirname, "..", "..", "..");
const SIDECAR = join(REPO, "sidecar", "reachy-voice", "sidecar.py");
const FIXTURES = join(REPO, "test", "fixtures", "reachy-voice");
const SIDECAR_SOURCE = readFileSync(SIDECAR, "utf8");
const SIDECAR_VERSION = /^SIDECAR_VERSION = "([^"]+)"$/m.exec(SIDECAR_SOURCE)?.[1] ?? "";

const scratch: string[] = [];
const procs: ChildProcess[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function python(): string {
  const r = Bun.spawnSync([
    "python3",
    "-I",
    "-c",
    "import os,sys;print(os.path.realpath(sys.executable))",
  ]);
  return r.stdout.toString().trim();
}

function install() {
  const py = python();
  const base = mkdtempSync(join(tmpdir(), "rvs-"));
  scratch.push(base);
  const tts = join(base, "tts");
  mkdirSync(tts, { mode: 0o755 });
  // Piper is a Python stand-in: the sidecar runs it under its own interpreter,
  // so the installed file is 0644 and carries no shebang. The player is exec'd.
  writeFileSync(join(tts, "piper"), readFileSync(join(FIXTURES, "fake-piper.py")));
  chmodSync(join(tts, "piper"), 0o644);
  writeFileSync(
    join(tts, "player"),
    `#!${py} -I\n${readFileSync(join(FIXTURES, "fake-player.py"), "utf8")}`,
  );
  chmodSync(join(tts, "player"), 0o755);
  const model = randomBytes(64);
  writeFileSync(join(tts, "model.onnx"), model);
  return {
    py,
    base,
    tts,
    work: join(base, "work"),
    sock: join(base, "s.sock"),
    sha: createHash("sha256").update(model).digest("hex"),
  };
}

function start(
  inst: ReturnType<typeof install>,
  extra: string[] = [],
  over: Partial<Record<"sha" | "work", string>> = {},
) {
  const argv = [
    "-I",
    SIDECAR,
    "--socket",
    inst.sock,
    "--work-dir",
    over.work ?? inst.work,
    "--piper",
    join(inst.tts, "piper"),
    "--piper-model",
    join(inst.tts, "model.onnx"),
    "--piper-model-sha256",
    over.sha ?? inst.sha,
    "--player",
    join(inst.tts, "player"),
    ...extra,
  ];
  const proc = spawn(inst.py, argv, { stdio: ["ignore", "ignore", "pipe"] });
  procs.push(proc);
  let log = "";
  let exit: number | null | undefined;
  proc.stderr?.on("data", (b: Buffer) => {
    log += b.toString();
  });
  proc.on("exit", (code) => {
    exit = code;
  });
  return { proc, log: () => log, exit: () => exit };
}

async function waitFor(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

class Pi implements PiLike {
  readonly tools = new Map<
    string,
    {
      execute: (
        i: string,
        p: Record<string, unknown>,
      ) => Promise<{ content: Array<{ text: string }> }>;
    }
  >();
  registerTool(t: {
    name: string;
    execute: (
      i: string,
      p: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }> }>;
  }): void {
    this.tools.set(t.name, t);
  }
}
class Store implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  async write(e: OrgEvent): Promise<{ id: string }> {
    this.all.push(e);
    return { id: orgEventRecordId(e) };
  }
  async getById(): Promise<OrgEvent | null> {
    return null;
  }
}

async function connectBob(inst: ReturnType<typeof install>, profile: "voice" | "reachy" = "voice") {
  const pi = new Pi();
  const store = new Store();
  const state: PolicyState = {
    profile,
    wakeName: "jarvis",
    enrolment: {},
    mute: false,
    nowMs: () => Date.now(),
    roomSpeechOrigins: ["run"],
  };
  const client = new UnixSocketReachyClient({ socket: inst.sock });
  const wired = wireReachyCapability({
    pi,
    commands: client,
    memory: { writePrivate: async () => ({ id: "m" }) },
    store,
    state,
    sidecarVersion: SIDECAR_VERSION,
    // an operator's one-shot run, as the runtime declares it
    readOrigin: () => ({ kind: "run" }),
    log: () => {},
  });
  client.onLine((l) => void wired.handleLine(l));
  await client.connect();
  await wired.connected();
  return { pi, store, wired, client };
}

const AUDIO = /\.(wav|wave|ogg|flac|mp3|aiff?|caf|m4a|pcm|raw)$/i;
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("bob#356 V1 — the real voice sidecar", () => {
  it("handshakes with bob: its OWN version and profile, bob's wake name and generation, no ears", async () => {
    const inst = install();
    const sc = start(inst, ["--device-mute", "absent"]);
    await waitFor(() => sc.log().includes("listening"), "listening");
    const bob = await connectBob(inst);
    try {
      await waitFor(() => bob.wired.link().phase === "ready", "the handshake");
      expect(bob.wired.link().health).toMatchObject({
        protocol: "reachy-voice/1",
        version: SIDECAR_VERSION,
        profile: "voice",
        wakeName: "jarvis",
        generation: 1,
        mode: "off",
        trainedPhrase: null,
        modelHash: null,
        muted: false,
        ok: true,
      });
    } finally {
      bob.client.close();
    }
  }, 30_000);

  it("a bob configured for the BODY is refused by the voice sidecar's own profile report (no downgrade)", async () => {
    const inst = install();
    const sc = start(inst, ["--device-mute", "absent"]);
    await waitFor(() => sc.log().includes("listening"), "listening");
    const bob = await connectBob(inst, "reachy");
    try {
      await waitFor(
        () => bob.store.all.some((e) => e.kind === "reachy.link.refused"),
        "the refusal",
      );
      expect(bob.wired.link().phase).toBe("disconnected");
      expect(bob.store.all.find((e) => e.kind === "reachy.link.refused")?.summary).toContain(
        "profile",
      );
    } finally {
      bob.client.close();
    }
  }, 30_000);

  it("speaks through an EPHEMERAL 0600 artifact in a 0700 dir, removes it, and logs no spoken text", async () => {
    const inst = install();
    const sc = start(inst, ["--device-mute", "absent"]);
    await waitFor(() => sc.log().includes("listening"), "listening");
    const bob = await connectBob(inst);
    const SECRET = `SPOKEN${randomBytes(4).toString("hex")}`;
    try {
      await waitFor(() => bob.wired.link().phase === "ready", "the handshake");
      const out = await bob.pi.tools.get("reachy_say")?.execute("tc", { text: `hi ${SECRET}` });
      expect(out.content[0]?.text).toBe(`say: hi ${SECRET}`);
      await waitFor(() => sc.log().includes("say.spoken"), "the playback");
      const files = filesUnder(inst.work);
      expect(files.map((f) => f.slice(inst.work.length + 1))).toEqual(["player-obs.jsonl"]);
      expect(files.some((f) => AUDIO.test(f))).toBe(false);
      const obs = JSON.parse(readFileSync(must(files[0], "the record"), "utf8").trim());
      expect(obs).toMatchObject({ mode: "0o600", dirMode: "0o700", riff: true, inWorkDir: true });
      expect(sc.log()).not.toContain(SECRET);
      // the playback id is logged only as a digest
      const say = bob.store.all.find((e) => e.kind === "reachy.say");
      const id = must(
        say?.targetIds?.find((t) => t.startsWith("play_")),
        "the playback id",
      );
      expect(sc.log()).toContain(`say.spoken playback=${digest(id)}`);
      expect(sc.log()).not.toContain(id);
    } finally {
      bob.client.close();
    }
  }, 30_000);

  it("a sender-chosen playback id never reaches the log verbatim, even one carrying text", async () => {
    const inst = install();
    const sc = start(inst, ["--device-mute", "absent"]);
    await waitFor(() => sc.log().includes("listening"), "listening");
    const raw = new UnixSocketReachyClient({ socket: inst.sock });
    await raw.connect();
    const SMUGGLED = `the-launch-code-is-${randomBytes(4).toString("hex")}`;
    try {
      await raw.send("configure", {
        protocol: "reachy-voice/1",
        profile: "voice",
        wakeName: "jarvis",
        generation: 1,
      });
      await raw.send("say", { text: "ok", playbackId: SMUGGLED });
      await raw.send("say", { text: "two\nlines", playbackId: `${SMUGGLED}-2` });
      await waitFor(() => sc.log().includes("say.spoken"), "the playback");
      await waitFor(() => sc.log().includes("say.refused"), "the refusal");
      expect(sc.log()).not.toContain(SMUGGLED);
      expect(sc.log()).toContain(`playback=${digest(SMUGGLED)}`);
    } finally {
      raw.close();
    }
  }, 30_000);

  it("FAIL CLOSED: cleanup failure sends ok=false on this live connection and refuses later speech", async () => {
    const inst = install();
    const sc = start(inst, ["--device-mute", "absent"]);
    await waitFor(() => sc.log().includes("listening"), "listening");
    writeFileSync(join(inst.work, "sabotage-cleanup"), "");
    const bob = await connectBob(inst);
    try {
      await waitFor(() => bob.wired.link().phase === "ready", "the handshake");
      const out = await must(bob.pi.tools.get("reachy_say"), "reachy_say").execute("tc", {
        text: "hello",
      });
      expect(out.content[0]?.text).toBe("say: hello");
      await waitFor(() => sc.log().includes("say.cleanup_failed"), "the cleanup failure");
      // This live connection delivers the update; bob refuses the link.
      await waitFor(
        () => bob.store.all.some((e) => e.kind === "reachy.link.refused"),
        "bob's refusal",
      );
      expect(
        must(
          bob.store.all.find((e) => e.kind === "reachy.link.refused"),
          "the alarm",
        ).summary,
      ).toContain("ok did not match");
      expect(bob.wired.link().phase).toBe("disconnected");
      // a direct client cannot make it speak again
      const raw = new UnixSocketReachyClient({ socket: inst.sock });
      await raw.connect();
      await raw.send("configure", {
        protocol: "reachy-voice/1",
        profile: "voice",
        wakeName: "jarvis",
        generation: 9,
      });
      await raw.send("say", { text: "again", playbackId: "play_again" });
      await waitFor(() => sc.log().includes("reason=dirty"), "the dirty refusal");
      expect(sc.log().match(/say\.spoken/g)?.length).toBe(1);
      raw.close();
    } finally {
      bob.client.close();
    }
  }, 30_000);

  it("FAIL CLOSED: a stale artifact that cannot be removed refuses startup", async () => {
    const inst = install();
    const stale = join(inst.work, "tts-stale");
    mkdirSync(inst.work, { mode: 0o700 });
    writeFileSync(stale, "RIFF....");
    const sc = start(inst, ["--device-mute", "absent"]);
    await waitFor(() => sc.exit() !== undefined, "the refusal");
    expect(sc.exit()).not.toBe(0);
    expect(sc.log()).toContain("cannot be removed; refusing to start");
    expect(existsSync(inst.sock)).toBe(false); // it never listened
  }, 30_000);

  it("the sidecar re-checks every say: a multi-line or extra-field say, or one before configure, is not spoken", async () => {
    const inst = install();
    const sc = start(inst, ["--device-mute", "absent"]);
    await waitFor(() => sc.log().includes("listening"), "listening");
    const raw = new UnixSocketReachyClient({ socket: inst.sock });
    try {
      const unconfigured = createConnection(inst.sock);
      await new Promise<void>((resolve, reject) => {
        unconfigured.once("error", reject);
        unconfigured.once("connect", resolve);
      });
      unconfigured.end(
        `${JSON.stringify({ command: "say", args: { text: "before configure", playbackId: "play_0" } })}\n`,
      );
      await waitFor(() => sc.log().includes("command.before_configure"), "unconfigured refusal");
      await waitFor(() => sc.log().includes("disconnected"), "unconfigured client disconnect");
      await raw.connect();
      await raw.send("configure", {
        protocol: "reachy-voice/1",
        profile: "voice",
        wakeName: "jarvis",
        generation: 1,
      });
      await raw.send("say", { text: "two\nlines", playbackId: "play_1" });
      await raw.send("say", { text: "hi", playbackId: "play_2", memoryId: "m" });
      await raw.send("say", { text: "x".repeat(501), playbackId: "play_3" });
      await raw.send("say", { text: "ok", playbackId: "play_4" }); // control: spoken
      await waitFor(
        () => sc.log().includes(`say.spoken playback=${digest("play_4")}`),
        "the control playback",
      );
      expect(sc.log()).toContain("command.before_configure");
      expect(sc.log()).not.toContain(`say.spoken playback=${digest("play_1")}`);
      expect(sc.log()).not.toContain(`say.spoken playback=${digest("play_2")}`);
      expect(sc.log()).not.toContain(`say.spoken playback=${digest("play_3")}`);
      const obs = readFileSync(join(inst.work, "player-obs.jsonl"), "utf8").trim().split("\n");
      expect(obs.length).toBe(1);
    } finally {
      raw.close();
    }
  }, 30_000);

  it("with the hardware mute unread (the default), the sidecar reports MUTED (fail closed): bob refuses speech", async () => {
    const inst = install();
    const sc = start(inst); // --device-mute defaults to unknown
    await waitFor(() => sc.log().includes("listening"), "listening");
    const bob = await connectBob(inst);
    try {
      await waitFor(() => bob.wired.link().phase === "ready", "the handshake");
      expect(bob.wired.link()).toMatchObject({ deviceMuted: true, effectiveMuted: true });
      const out = await bob.pi.tools.get("reachy_say")?.execute("tc", { text: "hi" });
      expect(out.content[0]?.text).toContain("refused: muted");
    } finally {
      bob.client.close();
    }
  }, 30_000);

  it("refuses to start on a model that does not match its pinned sha256, a work dir that is not 0700, or a relative work dir", async () => {
    const inst = install();
    const bad = start(inst, [], { sha: "0".repeat(64) });
    await waitFor(() => bad.exit() !== undefined, "the refusal");
    expect(bad.exit()).not.toBe(0);
    expect(bad.log()).toContain("does not match its pinned sha256");

    const open = join(inst.base, "open-work");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    const loose = start(inst, [], { work: open });
    await waitFor(() => loose.exit() !== undefined, "the refusal");
    expect(loose.exit()).not.toBe(0);
    expect(loose.log()).toContain("must be a 0700 directory");

    const relative = start(inst, [], { work: "rv-relative-work" });
    await waitFor(() => relative.exit() !== undefined, "the refusal");
    expect(relative.exit()).not.toBe(0);
    expect(relative.log()).toContain("--work-dir must be an absolute path");
  }, 30_000);

  it("sweeps speech a crash left behind, at startup", async () => {
    const inst = install();
    mkdirSync(join(inst.work, "tts-crashed"), { recursive: true, mode: 0o700 });
    chmodSync(inst.work, 0o700);
    writeFileSync(join(inst.work, "tts-crashed", "speech.wav"), "RIFF....", { mode: 0o600 });
    const sc = start(inst, ["--device-mute", "absent"]);
    await waitFor(() => sc.log().includes("listening"), "listening");
    expect(existsSync(join(inst.work, "tts-crashed"))).toBe(false);
  }, 30_000);

  it("the handshake proof against the REAL sidecar: a live session answers nothing, so the probe reports handshake-timeout; with the sidecar's one pending slot also taken, the connect is refused and the probe reports no-listener", async () => {
    const inst = install();
    const sc = start(inst, ["--device-mute", "absent"]);
    await waitFor(() => sc.log().includes("listening"), "listening");
    const bob = await connectBob(inst);
    try {
      await waitFor(() => bob.wired.link().phase === "ready", "the handshake");
      // The live session holds the sidecar in `Session.serve()`; the probe's
      // connection queues until that session ends, its `configure` is never read,
      // so no line arrives in the limit.
      const timed = await probeVoiceHandshake(
        inst.sock,
        { version: SIDECAR_VERSION, profile: "voice", wakeName: "jarvis", generation: 1 },
        { timeoutMs: 800, connectMs: 1_000 },
      );
      expect(timed.ok).toBe(false);
      expect(timed.reason).toBe("handshake-timeout");

      // Take the sidecar's one pending slot as well: a further connect is refused,
      // and the probe reports the refused connect, not a guessed diagnosis. How
      // many pending connects the listen backlog admits is platform behaviour: on
      // Linux this connect takes the slot; on macOS the backlog can already be
      // full and refuse it. Either way the probe's own connect is refused next.
      const queued = createConnection(inst.sock);
      await new Promise<void>((resolve) => {
        queued.once("error", () => resolve());
        queued.once("connect", () => resolve());
      });
      const refused = await probeVoiceHandshake(
        inst.sock,
        { version: SIDECAR_VERSION, profile: "voice", wakeName: "jarvis", generation: 1 },
        { timeoutMs: 800, connectMs: 1_000 },
      );
      expect(refused.ok).toBe(false);
      expect(refused.reason).toBe("no-listener");
      queued.destroy();
    } finally {
      bob.client.close();
    }
  }, 30_000);

  it("contains no audio-capture code path (V1 has no ears)", () => {
    // A static guard beside the fs audits: the sidecar names no input-device API.
    for (const api of [
      "sounddevice",
      "pyaudio",
      "InputStream",
      "AVAudioRecorder",
      "AVCaptureDevice",
      "arecord",
      "avfoundation",
      "openWakeWord",
      "whisper",
    ]) {
      expect(SIDECAR_SOURCE.toLowerCase()).not.toContain(api.toLowerCase());
    }
  });
});
