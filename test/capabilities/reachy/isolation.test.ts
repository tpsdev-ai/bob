// bob#356 V1 — the reachy-voice sidecar's isolation proofs.
//
//   1. DENY-DEFAULT CONFINEMENT (macOS seatbelt, the shipped
//      sidecar/reachy-voice/reachy-voice.sb). Every refusal is shown to SUCCEED
//      without the profile first (a probe whose control fails proves nothing):
//      TCP over IPv4 and IPv6, UDP, another UNIX socket, the DNS service socket,
//      network-capable mach services, a child process's connect, exec of an
//      arbitrary binary, and reads/writes outside the allow-list. Then the REAL
//      sidecar runs under the same profile and bob's REAL client round-trips the
//      reachy-voice/1 handshake and a `say` over the one authorized socket; the
//      speech artifact is 0600 in a 0700 directory while it plays and is gone
//      after, and the log never carries the spoken text.
//   2. The SAME proofs as the separate `jarvis-sidecar` user (bob#180 §3.2).
//   3. #180 S1's KEY-READ proof: as `jarvis-sidecar`, reading the admin password
//      and the agent key fails with EACCES/EPERM, while both are 0600 and owned
//      by the agent, and a 0644 control in the same traversable directory IS
//      readable — so the denial is the file mode, not the directory. Fixtures
//      always; the REAL files when the release host names them.
//
// Locally the separate-user proofs SKIP with their reason (the sidecar user and
// its constrained `sudo -n` path are provisioned once, by an admin — see
// sidecar/reachy-voice/RUNBOOK.md). Nothing here creates a user or calls sudo
// unless that user already exists. With BOB_REQUIRE_ISOLATION_PROOFS=1 (the
// release check) a proof that would skip FAILS.
import { afterAll, describe, expect } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
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
import { proof } from "./isolation-gate.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const SIDECAR_SRC = join(REPO, "sidecar", "reachy-voice");
const FIXTURES = join(REPO, "test", "fixtures", "reachy-voice");
const PROBE = readFileSync(join(FIXTURES, "egress-probe.py"), "utf8");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SIDECAR_USER = "jarvis-sidecar";
const DARWIN = process.platform === "darwin";
// The version the shipped sidecar reports; bob's config pins it exactly.
const SIDECAR_VERSION = /^SIDECAR_VERSION = "([^"]+)"$/m.exec(
  readFileSync(join(SIDECAR_SRC, "sidecar.py"), "utf8"),
)?.[1];
// Network-capable system services the sidecar must not reach (each needs a
// working control: a name this macOS does not register proves nothing).
const MACH_SERVICES = [
  "com.apple.nsurlsessiond",
  "com.apple.dnssd.service",
  "com.apple.cfnetwork.cfnetworkagent",
  "com.apple.analyticsd",
];
const MIN_MACH_CONTROLS = 2;
// The audio signatures the fs audit refuses (RIFF/WAVE, Ogg, FLAC, MP3/ID3,
// AIFF) and the extensions.
const AUDIO_MAGIC = ["RIFF", "OggS", "fLaC", "ID3", "FORM"];
const AUDIO_EXT = /\.(wav|wave|ogg|oga|opus|flac|mp3|aif|aiff|caf|m4a|pcm|raw)$/i;

// ── what this host can prove ────────────────────────────────────────────────
const seatbeltSkip = !DARWIN
  ? "sandbox-exec (seatbelt) is macOS-only"
  : !existsSync(SANDBOX_EXEC)
    ? "sandbox-exec is not installed"
    : "";
const hasUser = (() => {
  try {
    execFileSync("id", ["-u", SIDECAR_USER], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
// sudo is touched ONLY when the user exists: never on a host without it.
const sudoCat =
  hasUser &&
  spawnSync("sudo", ["-n", "-u", SIDECAR_USER, "/bin/cat", "/dev/null"], { stdio: "ignore" })
    .status === 0;
const sudoSandbox =
  hasUser &&
  DARWIN &&
  spawnSync(
    "sudo",
    ["-n", "-u", SIDECAR_USER, SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"],
    { stdio: "ignore" },
  ).status === 0;
const userSkip = !hasUser
  ? `the ${SIDECAR_USER} user is not provisioned (RUNBOOK step 1)`
  : !sudoCat
    ? `the constrained sudo -n path to ${SIDECAR_USER} is unavailable (RUNBOOK step 2)`
    : "";
const separateSeatbeltSkip =
  seatbeltSkip ||
  userSkip ||
  (!sudoSandbox ? `sudo -n cannot run sandbox-exec as ${SIDECAR_USER} (RUNBOOK step 2)` : "");
const REAL_ADMIN_PASS = process.env.BOB_ISOLATION_ADMIN_PASS;
const REAL_AGENT_KEY = process.env.BOB_ISOLATION_AGENT_KEY;
const realKeysSkip =
  userSkip ||
  (!REAL_ADMIN_PASS || !REAL_AGENT_KEY
    ? "the real key paths are not given (BOB_ISOLATION_ADMIN_PASS, BOB_ISOLATION_AGENT_KEY)"
    : "");

// The interpreter, RESOLVED (the profile's paths must be real paths).
function pythonPaths(): { python: string; prefix: string } {
  const r = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import os,sys;e=os.path.realpath(sys.executable);print(e);print(os.path.commonpath([e,os.path.realpath(sys.base_prefix)]))",
    ],
    { encoding: "utf8" },
  );
  const [python, prefix] = r.stdout.trim().split("\n");
  if (r.status !== 0 || !python || !prefix) throw new Error("python3 is not available");
  return { python, prefix };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const scratch: string[] = [];
const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

interface Layout {
  base: string;
  sd: string; // the installed sidecar (sidecar.py + profile), world-readable
  tts: string; // the fake Piper install: piper, player, model
  side: string; // where the sidecar creates its work dir and socket
  work: string;
  sock: string;
  outside: string; // outside every allow-list
  python: string;
  prefix: string;
  modelSha: string;
}

/** A fresh layout. Under /private/tmp on macOS (a volume that keeps owners, and
 *  that another user can traverse); the base is 0711. `shared` makes the
 *  sidecar's directory sticky-world-writable so a DIFFERENT user can create its
 *  work dir and socket there. */
function layout(shared: boolean): Layout {
  const { python, prefix } = pythonPaths();
  const base = mkdtempSync(join(DARWIN ? "/private/tmp" : tmpdir(), "rv-"));
  scratch.push(base);
  chmodSync(base, 0o711);
  const sd = join(base, "sd");
  const tts = join(base, "tts");
  const side = join(base, "side");
  const outside = join(base, "outside");
  for (const d of [sd, tts]) mkdirSync(d, { mode: 0o755 });
  mkdirSync(side, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o755 });
  chmodSync(sd, 0o755);
  chmodSync(tts, 0o755);
  chmodSync(outside, shared ? 0o1777 : 0o755);
  chmodSync(side, shared ? 0o1777 : 0o700);
  for (const f of ["sidecar.py", "reachy-voice.sb"]) {
    copyFileSync(join(SIDECAR_SRC, f), join(sd, f));
    chmodSync(join(sd, f), 0o644);
  }
  for (const [name, src] of [
    ["piper", "fake-piper.py"],
    ["player", "fake-player.py"],
  ] as const) {
    const body = readFileSync(join(FIXTURES, src), "utf8");
    writeFileSync(join(tts, name), `#!${python} -I\n${body}`, { mode: 0o755 });
    chmodSync(join(tts, name), 0o755);
  }
  const model = randomBytes(64);
  writeFileSync(join(tts, "model.onnx"), model, { mode: 0o644 });
  chmodSync(join(tts, "model.onnx"), 0o644);
  writeFileSync(join(outside, "control-0644"), "fixture-control-not-a-secret\n", { mode: 0o644 });
  chmodSync(join(outside, "control-0644"), 0o644);
  return {
    base,
    sd,
    tts,
    side,
    work: join(side, "work"),
    sock: join(side, "s.sock"),
    outside,
    python,
    prefix,
    modelSha: createHash("sha256").update(model).digest("hex"),
  };
}

function profileArgs(l: Layout): string[] {
  return [
    "-f",
    join(l.sd, "reachy-voice.sb"),
    "-D",
    `PYTHON_PREFIX=${l.prefix}`,
    "-D",
    `SIDECAR_DIR=${l.sd}`,
    "-D",
    `TTS_DIR=${l.tts}`,
    "-D",
    `PLAYER=${join(l.tts, "player")}`,
    "-D",
    `WORK_DIR=${l.work}`,
    "-D",
    `SOCKET=${l.sock}`,
  ];
}

const UNCONFINED = ["-p", "(version 1)(allow default)"];

/** Run argv as this user, or as the sidecar user through the constrained path. */
function runAs(asSidecarUser: boolean, argv: string[]) {
  const [cmd, ...rest] = asSidecarUser ? ["sudo", "-n", "-u", SIDECAR_USER, ...argv] : argv;
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(must(cmd, "a command"), rest, { stdio: ["ignore", "pipe", "pipe"] });
    // Never hang the suite: a probe that outlives this is killed (and fails).
    const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    p.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    p.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

type ProbeResults = Record<string, { ok: boolean; err: string; files?: string[] }>;

async function probe(
  l: Layout,
  asSidecarUser: boolean,
  confined: boolean,
  spec: Record<string, unknown>,
): Promise<ProbeResults> {
  const py = [l.python, "-I", "-c", PROBE, JSON.stringify(spec)];
  const r = await runAs(asSidecarUser, [
    SANDBOX_EXEC,
    ...(confined ? profileArgs(l) : UNCONFINED),
    ...py,
  ]);
  if (r.status !== 0) throw new Error(`the probe itself failed (status ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as ProbeResults;
}

function listen(server: Server, ...args: unknown[]): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    (server.listen as (...a: unknown[]) => void)(...args, () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
}

/** Local listeners the probes aim at (nothing leaves the host). */
async function listeners(l: Layout) {
  const tcp4 = createServer((s) => s.destroy());
  const tcp6 = createServer((s) => s.destroy());
  const unix = createServer((s) => s.destroy());
  const udp = createSocket("udp4");
  const p4 = await listen(tcp4, 0, "127.0.0.1");
  const p6 = await listen(tcp6, 0, "::1");
  const otherSock = join(l.outside, "other.sock");
  await listen(unix, otherSock);
  chmodSync(otherSock, 0o777);
  const pu = await new Promise<number>((resolve) =>
    udp.bind(0, "127.0.0.1", () => resolve(udp.address().port)),
  );
  const close = () => {
    tcp4.close();
    tcp6.close();
    unix.close();
    udp.close();
  };
  cleanups.push(close);
  return { p4, p6, pu, otherSock, close };
}

/** Every refusal, with its control: the full egress/escape matrix. */
async function proveConfinement(asSidecarUser: boolean) {
  const l = layout(asSidecarUser);
  const net = await listeners(l);
  try {
    const spec = {
      tcp4: net.p4,
      tcp6: net.p6,
      udp4: net.pu,
      unixOther: net.otherSock,
      mdns: "/var/run/mDNSResponder",
      mach: MACH_SERVICES,
      childTcp4: net.p4,
      exec: "/usr/bin/true",
      readOutside: join(l.outside, "control-0644"),
      writeOutside: join(l.outside, `w-${randomBytes(6).toString("hex")}`),
    };
    const control = await probe(l, asSidecarUser, false, spec);
    const confined = await probe(l, asSidecarUser, true, spec);
    let machControls = 0;
    for (const [name, result] of Object.entries(control)) {
      if (name.startsWith("mach:")) {
        if (!result.ok) continue; // not registered on this macOS: no claim either way
        machControls++;
      } else {
        expect(result.ok, `control ${name} must SUCCEED unconfined (${result.err})`).toBe(true);
      }
      expect(confined[name]?.ok, `${name} must be DENIED under the profile`).toBe(false);
      expect(confined[name]?.err ?? "").not.toContain("TimeoutError");
    }
    expect(machControls).toBeGreaterThanOrEqual(MIN_MACH_CONTROLS);
    expect(confined.childTcp4?.err).toContain("child exit 3"); // the CHILD's PermissionError
    for (const name of [
      "tcp4",
      "tcp6",
      "udp4",
      "unixOther",
      "mdns",
      "readOutside",
      "writeOutside",
    ]) {
      expect(confined[name]?.err, name).toContain("PermissionError");
    }
  } finally {
    net.close();
  }
}

class NoPi implements PiLike {
  readonly tools = new Map<
    string,
    {
      execute: (
        id: string,
        p: Record<string, unknown>,
      ) => Promise<{ content: Array<{ text: string }> }>;
    }
  >();
  registerTool(tool: {
    name: string;
    execute: (
      id: string,
      p: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }> }>;
  }): void {
    this.tools.set(tool.name, tool);
  }
}
class MemStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  async write(event: OrgEvent): Promise<{ id: string }> {
    this.all.push(event);
    return { id: orgEventRecordId(event) };
  }
  async getById(): Promise<OrgEvent | null> {
    return null;
  }
}

async function waitFor(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The REAL sidecar under the shipped profile, and bob's REAL client: the
 *  handshake and one `say` over the authorized socket, then the fs audit. */
async function proveRoundTrip(asSidecarUser: boolean) {
  const l = layout(asSidecarUser);
  const SECRET = `SAYWORD${randomBytes(4).toString("hex")}`;
  const argv = [
    SANDBOX_EXEC,
    ...profileArgs(l),
    l.python,
    "-I",
    join(l.sd, "sidecar.py"),
    "--socket",
    l.sock,
    "--work-dir",
    l.work,
    "--piper",
    join(l.tts, "piper"),
    "--piper-model",
    join(l.tts, "model.onnx"),
    "--piper-model-sha256",
    l.modelSha,
    "--player",
    join(l.tts, "player"),
    "--device-mute",
    "absent",
    "--socket-mode",
    asSidecarUser ? "0666" : "0600",
  ];
  const [cmd, ...rest] = asSidecarUser ? ["sudo", "-n", "-u", SIDECAR_USER, ...argv] : argv;
  const proc = spawn(must(cmd, "a command"), rest, { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  proc.stderr.on("data", (b: Buffer) => {
    log += b.toString();
  });
  cleanups.push(() => proc.kill());
  const client = new UnixSocketReachyClient({ socket: l.sock });
  try {
    await waitFor(() => log.includes("listening"), "the sidecar to listen");
    const pi = new NoPi();
    const store = new MemStore();
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
      commands: client,
      memory: { writePrivate: async () => ({ id: "m" }) },
      store,
      state,
      sidecarVersion: must(SIDECAR_VERSION, "the sidecar version"),
      log: () => {},
    });
    client.onLine((line) => void wired.handleLine(line));
    await client.connect();
    await wired.connected();
    await waitFor(() => wired.link().phase === "ready", "the reachy-voice/1 handshake");
    expect(wired.link().health?.version).toBe(SIDECAR_VERSION);
    expect(wired.link().health?.mode).toBe("off"); // no ears in V1

    const out = await pi.tools.get("reachy_say")?.execute("tc", { text: `hello ${SECRET}` });
    expect(out.content[0]?.text).toBe(`say: hello ${SECRET}`);
    const say = store.all.find((e) => e.kind === "reachy.say");
    const playbackId = say?.targetIds?.find((t) => t.startsWith("play_"));
    expect(playbackId).toBeDefined();
    await waitFor(() => log.includes(`say.spoken playback=${playbackId}`), "the playback");

    // The fs audit of everything the sidecar may write (its work dir; the
    // socket is not a file), read AS the sidecar's user.
    const audit = await probe(l, asSidecarUser, true, { listAudio: [l.work] });
    const files = audit.listAudio?.files ?? [];
    // Only the fake player's observation record remains — no speech artifact.
    expect(files.map((f) => f.slice(l.work.length + 1))).toEqual(["player-obs.jsonl"]);
    for (const f of files) expect(AUDIO_EXT.test(f), f).toBe(false);
    if (!asSidecarUser) {
      for (const f of files) {
        const head = readFileSync(f).subarray(0, 4).toString("latin1");
        expect(
          AUDIO_MAGIC.some((m) => head.startsWith(m)),
          f,
        ).toBe(false);
      }
      // What the player was handed WHILE it played: 0600, in a 0700 dir under
      // the work dir, owned by the sidecar's user, a real waveform.
      const obs = JSON.parse(
        must(readFileSync(must(files[0], "the record"), "utf8").trim().split("\n")[0], "a line"),
      );
      expect(obs).toMatchObject({ mode: "0o600", dirMode: "0o700", riff: true, inWorkDir: true });
      expect(obs.uid).toBe(process.getuid?.());
      expect((statSync(l.work).mode & 0o777).toString(8)).toBe("700");
    }
    // Content-free logs: the spoken text never reaches the sidecar's log.
    expect(log).not.toContain(SECRET);
  } finally {
    client.close();
    proc.kill();
  }
}

describe("reachy-voice isolation — deny-default confinement (seatbelt)", () => {
  proof(
    "the shipped profile denies network, child, exec, service and file egress — each control succeeds unconfined",
    seatbeltSkip,
    () => proveConfinement(false),
    60_000,
  );
  proof(
    "the REAL sidecar under the profile round-trips the handshake and a `say` over the authorized socket; no audio remains",
    seatbeltSkip,
    () => proveRoundTrip(false),
    60_000,
  );
});

describe(`reachy-voice isolation — as the separate ${SIDECAR_USER} user`, () => {
  proof(
    `as ${SIDECAR_USER}: the profile denies every egress, each control succeeding unconfined as that user`,
    separateSeatbeltSkip,
    () => proveConfinement(true),
    60_000,
  );
  proof(
    `as ${SIDECAR_USER}: the REAL sidecar round-trips the handshake and a \`say\`; no audio remains`,
    separateSeatbeltSkip,
    () => proveRoundTrip(true),
    60_000,
  );
});

describe("reachy-voice isolation — #180 S1 key-read proof", () => {
  /** Read `path` as the sidecar user. stdout is DISCARDED: if the read ever
   *  succeeded on a secret, its bytes must not reach this process. */
  function readAsSidecar(path: string, keepStdout: boolean) {
    return spawnSync("sudo", ["-n", "-u", SIDECAR_USER, "/bin/cat", path], {
      encoding: "utf8",
      stdio: ["ignore", keepStdout ? "pipe" : "ignore", "pipe"],
    });
  }
  const denied = /Permission denied|Operation not permitted/; // EACCES | EPERM

  proof(
    "fixtures: 0644 control readable, 0600 admin-pass and agent-key DENIED (EACCES/EPERM), both 0600 and agent-owned",
    userSkip,
    () => {
      const dir = mkdtempSync(join(DARWIN ? "/private/tmp" : tmpdir(), "reachy-keyread-"));
      scratch.push(dir);
      // TRAVERSABLE (0711): a 0700 dir would deny traversal and prove nothing
      // about the file modes (round 4 item 5).
      chmodSync(dir, 0o711);
      expect((statSync(dir).mode & 0o777).toString(8)).toBe("711");
      const control = join(dir, "control-0644");
      const adminPass = join(dir, "admin-pass");
      const agentKey = join(dir, "agent-key");
      writeFileSync(control, "fixture-control-not-a-secret\n", { mode: 0o644 });
      writeFileSync(adminPass, "fixture-not-a-real-secret\n", { mode: 0o600 });
      writeFileSync(agentKey, "fixture-not-a-real-key\n", { mode: 0o600 });
      chmodSync(control, 0o644);
      chmodSync(adminPass, 0o600);
      chmodSync(agentKey, 0o600);
      expect((statSync(control).mode & 0o777).toString(8)).toBe("644");
      for (const f of [adminPass, agentKey]) {
        expect((statSync(f).mode & 0o777).toString(8)).toBe("600");
        expect(statSync(f).uid).toBe(process.getuid?.() ?? -1); // the agent owns it
      }
      const ok = readAsSidecar(control, true);
      expect(ok.status, `cat ${control} as ${SIDECAR_USER} should SUCCEED`).toBe(0);
      expect(ok.stdout).toContain("fixture-control-not-a-secret");
      for (const f of [adminPass, agentKey]) {
        const r = readAsSidecar(f, false);
        expect(r.status, `cat ${f} as ${SIDECAR_USER} must fail`).not.toBe(0);
        expect(r.stderr).toMatch(denied);
      }
    },
  );

  proof(
    "the REAL admin-pass and agent key: 0600, agent-owned, and DENIED to the sidecar user (never read here)",
    realKeysSkip,
    () => {
      for (const f of [must(REAL_ADMIN_PASS, "admin-pass"), must(REAL_AGENT_KEY, "agent key")]) {
        const st = statSync(f); // metadata only: this process never opens it
        expect((st.mode & 0o777).toString(8), `${f} mode`).toBe("600");
        expect(st.uid, `${f} owner`).toBe(process.getuid?.() ?? -1);
        const r = readAsSidecar(f, false);
        expect(r.status, `${SIDECAR_USER} must not read ${f}`).not.toBe(0);
        expect(r.stderr).toMatch(denied);
      }
    },
  );
});

// Leave nothing in the scratch roots even when a proof failed mid-way.
afterAll(() => {
  for (const d of scratch) {
    if (existsSync(d)) {
      try {
        for (const e of readdirSync(d)) rmSync(join(d, e), { recursive: true, force: true });
      } catch {
        /* a sidecar-user-owned entry may need the admin; reported by the leak check */
      }
    }
  }
});
