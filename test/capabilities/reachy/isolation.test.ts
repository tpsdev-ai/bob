// bob#356 V1 — the reachy-voice sidecar's isolation proofs. Each proof carries a
// stable id [P1]…[P8]; scripts/check-reachy-isolation.mjs pins that set, so a
// missing proof fails the release-host check even when nothing was skipped.
//
//   [P1] DENY-DEFAULT CONFINEMENT (macOS seatbelt, the shipped
//        sidecar/reachy-voice/reachy-voice.sb), as this user: TCP over IPv4 and
//        IPv6, UDP, another UNIX socket, the DNS service socket, network-capable
//        mach services, a child process's connect, exec of `/usr/bin/true`,
//        and reads/writes outside the allow-list are refused — each one first
//        shown to SUCCEED unconfined (a mach service name this macOS does not
//        register has no control and is excluded; at least two must have one).
//   [P2] The REAL sidecar under that profile round-trips the reachy-voice/1
//        handshake and a `say` with bob's REAL client over the one authorized
//        socket; the speech artifact is 0600 in a 0700 directory while it plays
//        and gone after; the log carries neither the text nor the playback id.
//   [P3] The same probes are refused when run as the separate `jarvis-sidecar`
//        user under the profile (bob#180 §3.2). Their unconfined controls run as
//        THIS user — the sudo rule allows no unconfined probe (round 2).
//   [P4] [P2] as `jarvis-sidecar` on a SCRATCH socket with the deployed mode
//        and group (0660, jarvis-voice): bob's user connects as a member, and an
//        outsider (`nobody`) is refused by the socket's mode.
//   [P5] #180 S1's key-read proof on fixtures: as `jarvis-sidecar`, opening the
//        admin password and the agent key fails (EACCES/EPERM) while both are
//        0600 and agent-owned, and a 0644 control in the same traversable
//        directory opens — so the denial is the file mode, not the directory.
//   [P6] The same on bob's ACTIVE credentials, DERIVED from the agent's bob.yaml
//        under the pinned agents root (of the account the root-owned
//        deployment record names) and bob's own admin-password path
//        (isolation-credentials.ts) — the release host names the agent, never
//        the files or the account. Every key or token file bob.yaml names must
//        be an absolute (or `~/`) path — a relative one fails — and must exist,
//        as must the admin password; the provider stores are checked when
//        present. Every one present must be a regular file.
//   [P7] The INSTALLED sidecar, profile and proof tooling (at the pinned
//        install root) are the reviewed files (sha256 equal to this checkout's)
//        and root-owned, not writable by anyone else.
//   [P8] The DEPLOYED socket (the pinned state root): 0660, owner
//        jarvis-sidecar, group jarvis-voice, in a 0750 directory of that owner
//        and group; an outsider's connect is refused.
//
// Required release-host separate-user steps use the installed `proof.py` via
// RUNBOOK step 2's sudoers rule. Local fallback checks sudo with `/usr/bin/true`
// and can run a scratch proof copy. No sudo is attempted without the sidecar user.
// Locally [P3]–[P8] can skip; BOB_REQUIRE_ISOLATION_PROOFS=1 makes skips fail
// and pins the install and agents roots.
import { afterAll, describe, expect } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  chainProblems,
  PINNED_DEVELOPER_DIR,
  PINNED_PYTHON,
  releaseTrustProblems,
  treeProblems,
} from "../../../scripts/check-reachy-isolation.mjs";
import {
  type OrgEventStore,
  orgEventRecordId,
  type PiLike,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";
import { must } from "./handshake.js";
import { deriveActiveCredentials } from "./isolation-credentials.js";
import { PINNED_PIPER_DIR, PINNED_STATE_DIR, proof, releaseRoots } from "./isolation-gate.js";
import { assertConfinementProbeKeys, MACH_SERVICES } from "./probe-keys.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const SIDECAR_SRC = join(REPO, "sidecar", "reachy-voice");
const FIXTURES = join(REPO, "test", "fixtures", "reachy-voice");
const REQUIRED = process.env.BOB_REQUIRE_ISOLATION_PROOFS === "1";
// sudo, id and sandbox-exec by ABSOLUTE path, always. In required mode the
// interpreter is PINNED to Apple's /usr/bin/python3 (run -I), so no required
// proof depends on a command lookup (and the release-host check pins PATH).
// Outside required mode it may be BOB_REACHY_VOICE_PYTHON or `python3`.
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SUDO = "/usr/bin/sudo";
const ID = "/usr/bin/id";
const SIDECAR_USER = "jarvis-sidecar";
const VOICE_GROUP = "jarvis-voice";
const OUTSIDER = "nobody";
const DARWIN = process.platform === "darwin";
// The files the release host installs (RUNBOOK step 3), compared by hash.
const INSTALLED_FILES = ["sidecar.py", "reachy-voice.sb", "proof.py", "egress-probe.py"];
// The release-host roots, PINNED in required mode (isolation-gate.ts).
const ROOTS = releaseRoots();
const rootsSkip = ROOTS.skip;
const INSTALL_DIR = ROOTS.installDir;
const DEPLOYED_SOCKET = join(PINNED_STATE_DIR, "run", "voice.sock");
const SIDECAR_VERSION = /^SIDECAR_VERSION = "([^"]+)"$/m.exec(
  readFileSync(join(SIDECAR_SRC, "sidecar.py"), "utf8"),
)?.[1];
const MIN_MACH_CONTROLS = 2;
const AUDIO_MAGIC = ["RIFF", "OggS", "fLaC", "ID3", "FORM"];
const AUDIO_EXT = /\.(wav|wave|ogg|oga|opus|flac|mp3|aif|aiff|caf|m4a|pcm|raw)$/i;
const digest = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

// The interpreter the sudoers rule names. In required mode it is ONLY
// PINNED_PYTHON (/usr/bin/python3): nothing is looked up on PATH, and a
// BOB_REACHY_VOICE_PYTHON naming another is refused.
function interpreter(): string {
  const configured = process.env.BOB_REACHY_VOICE_PYTHON;
  if (REQUIRED) {
    if (configured !== undefined && configured !== PINNED_PYTHON) {
      throw new Error(`the interpreter is pinned to ${PINNED_PYTHON}`);
    }
    return PINNED_PYTHON;
  }
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("BOB_REACHY_VOICE_PYTHON must be absolute");
    return configured;
  }
  const r = spawnSync(
    "python3",
    ["-I", "-c", "import os,sys;print(os.path.realpath(sys.executable))"],
    {
      encoding: "utf8",
    },
  );
  const py = r.stdout.trim();
  if (r.status !== 0 || !py) throw new Error("python3 is not available");
  return py;
}
const PY = (() => {
  try {
    return interpreter();
  } catch {
    return "";
  }
})();
// What PY RESOLVES to (on macOS /usr/bin/python3 is a shim that execs the
// Command Line Tools interpreter). Anything executed INSIDE the sandbox (the
// stand-in Piper and player) names this one: the profile allows that exec
// under the interpreter's install root, which the shim is not.
const PY_REAL = (() => {
  if (!PY) return "";
  const r = spawnSync(PY, ["-I", "-c", "import os,sys;print(os.path.realpath(sys.executable))"], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : "";
})();

// ── what this host can prove ────────────────────────────────────────────────
const seatbeltSkip = !DARWIN
  ? "sandbox-exec (seatbelt) is macOS-only"
  : !existsSync(SANDBOX_EXEC)
    ? "sandbox-exec is not installed"
    : !PY || !PY_REAL
      ? REQUIRED
        ? `the interpreter is pinned to ${PINNED_PYTHON} (BOB_REACHY_VOICE_PYTHON names another, or it does not run)`
        : "python3 is not available"
      : "";
const hasUser = (() => {
  try {
    execFileSync(ID, ["-u", SIDECAR_USER], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const installed = INSTALLED_FILES.every((f) => existsSync(join(INSTALL_DIR, f)));
const installedSkip =
  rootsSkip || (installed ? "" : `the sidecar is not installed at ${INSTALL_DIR} (RUNBOOK step 3)`);
// The proof command the sudoers rule names: the INSTALLED one where it is
// installed (the release host); elsewhere (CI, whose runner sudo is broad) a
// copy in each proof's world-readable scratch layout.
const runAsUser = (user: string, proofPath: string, args: string[]) =>
  spawnSync(SUDO, ["-n", "-u", user, PY, "-I", proofPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
// sudo is touched ONLY when the user exists: never on a host without it.
const sudoProof =
  hasUser &&
  PY !== "" &&
  (installed
    ? runAsUser(SIDECAR_USER, join(INSTALL_DIR, "proof.py"), ["open", "/dev/null"]).status === 0
    : spawnSync(SUDO, ["-n", "-u", SIDECAR_USER, "/usr/bin/true"], { stdio: "ignore" }).status ===
      0);
const userSkip = !hasUser
  ? `the ${SIDECAR_USER} user is not provisioned (RUNBOOK step 1)`
  : !sudoProof
    ? `the constrained sudo -n proof path to ${SIDECAR_USER} is unavailable (RUNBOOK step 2)`
    : "";
const voiceGid = (() => {
  if (!hasUser || !PY) return undefined;
  const r = spawnSync(
    PY,
    ["-I", "-c", `import grp;print(grp.getgrnam(${JSON.stringify(VOICE_GROUP)}).gr_gid)`],
    {
      encoding: "utf8",
    },
  );
  return r.status === 0 ? Number(r.stdout.trim()) : undefined;
})();
const outsiderOk =
  hasUser &&
  installed &&
  runAsUser(OUTSIDER, join(INSTALL_DIR, "proof.py"), ["connect", "/nonexistent"]).status === 0;
const separateSkip =
  seatbeltSkip ||
  userSkip ||
  installedSkip ||
  (voiceGid === undefined ? `the ${VOICE_GROUP} group is not provisioned (RUNBOOK step 1)` : "");
const outsiderSkip = !outsiderOk
  ? `the outsider (${OUTSIDER}) proof path is unavailable (RUNBOOK step 2)`
  : "";
const scratchSocketSkip = separateSkip || outsiderSkip;
const deployedSocketSkip =
  userSkip ||
  installedSkip ||
  (voiceGid === undefined ? `the ${VOICE_GROUP} group is not provisioned (RUNBOOK step 1)` : "") ||
  (!existsSync(DEPLOYED_SOCKET)
    ? `no deployed socket at ${DEPLOYED_SOCKET} (the launch job, RUNBOOK step 5)`
    : "") ||
  outsiderSkip;
const AGENT = process.env.BOB_ISOLATION_AGENT;
const AGENTS_ROOT = ROOTS.agentsRoot;
const activeSkip =
  rootsSkip ||
  userSkip ||
  (!AGENT ? "the agent whose credentials to check is not named (BOB_ISOLATION_AGENT)" : "");

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
  sd: string; // a copy of the sidecar directory (sidecar, profile, proof tooling)
  tts: string; // the stand-in Piper install: piper, player, model
  side: string; // where the sidecar creates its work dir and socket
  work: string;
  sock: string;
  outside: string; // outside every allow-list
  modelSha: string;
}

/** A fresh layout under /private/tmp/rv-* (a volume that keeps owners, that
 *  another user can traverse, and the only prefix proof.py accepts). With a
 *  `group`, the sidecar's SCRATCH directory belongs to it, mode 0771: members
 *  create, an outsider may traverse to the socket and is refused by the
 *  socket's own 0660 mode. That is NOT the deployed directory (0750, owned by
 *  the sidecar user — checked by [P8]). */
function layout(shared: { group?: number } | false): Layout {
  const base = mkdtempSync(join(DARWIN ? "/private/tmp" : tmpdir(), "rv-"));
  scratch.push(base);
  chmodSync(base, 0o711);
  const sd = join(base, "sd");
  const tts = join(base, "tts");
  const side = join(base, "side");
  const outside = join(base, "outside");
  for (const d of [sd, tts, outside]) {
    mkdirSync(d);
    chmodSync(d, 0o755);
  }
  mkdirSync(side);
  if (shared && shared.group !== undefined) {
    chownSync(side, process.getuid?.() ?? -1, shared.group);
    chmodSync(side, 0o771);
    // Let bob remove sidecar-owned scratch children without privileged cleanup.
    execFileSync("/bin/chmod", [
      "+a",
      `user:${execFileSync(ID, ["-un"], { encoding: "utf8" }).trim()} allow list,search,delete,delete_child,file_inherit,directory_inherit`,
      side,
    ]);
  } else {
    chmodSync(side, shared ? 0o1777 : 0o700);
  }
  if (shared) chmodSync(outside, 0o1777);
  for (const f of INSTALLED_FILES) {
    copyFileSync(join(SIDECAR_SRC, f), join(sd, f));
    chmodSync(join(sd, f), 0o644);
  }
  for (const [name, src] of [
    ["piper", "fake-piper.py"],
    ["player", "fake-player.py"],
  ] as const) {
    const body = readFileSync(join(FIXTURES, src), "utf8");
    writeFileSync(join(tts, name), `#!${PY_REAL} -I\n${body}`);
    chmodSync(join(tts, name), 0o755);
  }
  const model = randomBytes(64);
  writeFileSync(join(tts, "model.onnx"), model);
  chmodSync(join(tts, "model.onnx"), 0o644);
  writeFileSync(join(outside, "control-0644"), "fixture-control-not-a-secret\n");
  chmodSync(join(outside, "control-0644"), 0o644);
  return {
    base,
    sd,
    tts,
    side,
    work: join(side, "work"),
    sock: join(side, "s.sock"),
    outside,
    modelSha: createHash("sha256").update(model).digest("hex"),
  };
}

/** Run proof.py as this user (its layout copy) or as another user (the
 *  installed one, through the exact sudoers rule). */
function proofArgv(l: Layout, as: string | undefined, args: string[]): string[] {
  if (as === undefined) return [PY, "-I", join(l.sd, "proof.py"), ...args];
  return [SUDO, "-n", "-u", as, PY, "-I", join(INSTALL_DIR, "proof.py"), ...args];
}

function run(argv: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(must(argv[0], "a command"), argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
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

/** Confined: proof.py runs the probe under the profile (as `as`, through the
 *  sudo rule, when given). Unconfined — the control — always as THIS user and
 *  without sudo: the sudo rule allows no unconfined probe. */
async function probe(
  l: Layout,
  as: string | undefined,
  confined: boolean,
  spec: Record<string, unknown>,
): Promise<ProbeResults> {
  const r = await run(
    confined
      ? proofArgv(l, as, ["probe", l.tts, l.work, l.sock, JSON.stringify(spec)])
      : [PY, "-I", "-c", readFileSync(join(l.sd, "egress-probe.py"), "utf8"), JSON.stringify(spec)],
  );
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

/** P1/P3 confinement refusals, with unconfined controls as bob. */
async function proveConfinement(as: string | undefined) {
  const l = layout(as === undefined ? false : {});
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
    const control = await probe(l, undefined, false, spec); // this user, no sudo
    const confined = await probe(l, as, true, spec);
    assertConfinementProbeKeys(control, confined);
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
 *  handshake and one `say` over the authorized socket, then the fs audit. As
 *  the sidecar user, the SCRATCH socket gets the deployed mode and group (0660,
 *  jarvis-voice), and an outsider's connect is refused by that mode. */
async function proveRoundTrip(as: string | undefined) {
  const separate = as !== undefined; // the separate user, on the group-shared SCRATCH socket
  const l = layout(separate ? { group: must(voiceGid, "the voice group") } : false);
  const SECRET = `SAYWORD${randomBytes(4).toString("hex")}`;
  const argv = proofArgv(l, as, [
    "sidecar",
    l.tts,
    l.work,
    l.sock,
    l.modelSha,
    separate ? "0660" : "0600",
  ]);
  const proc = spawn(must(argv[0], "a command"), argv.slice(1), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  proc.stderr?.on("data", (b: Buffer) => {
    log += b.toString();
  });
  cleanups.push(() => proc.kill());
  const client = new UnixSocketReachyClient({ socket: l.sock });
  try {
    await waitFor(() => log.includes("listening"), "the sidecar to listen");
    if (separate) {
      const st = statSync(l.sock);
      expect((st.mode & 0o777).toString(8)).toBe("660");
      expect(st.gid).toBe(must(voiceGid, "the voice group"));
      const outsider = await run(proofArgv(l, OUTSIDER, ["connect", l.sock]));
      expect(JSON.parse(outsider.stdout).connect).toMatch(/^(EACCES|EPERM)$/);
    }
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
      readOrigin: () => ({ kind: "run" }),
      log: () => {},
    });
    client.onLine((line) => void wired.handleLine(line));
    await client.connect(); // bob's user, as a member of the socket's group
    await wired.connected();
    await waitFor(() => wired.link().phase === "ready", "the reachy-voice/1 handshake");
    expect(wired.link().health?.version).toBe(SIDECAR_VERSION);
    expect(wired.link().health?.mode).toBe("off"); // no ears in V1

    const out = await must(pi.tools.get("reachy_say"), "reachy_say").execute("tc", {
      text: `hello ${SECRET}`,
    });
    expect(out.content[0]?.text).toBe(`say: hello ${SECRET}`);
    const say = store.all.find((e) => e.kind === "reachy.say");
    const playbackId = must(
      say?.targetIds?.find((t) => t.startsWith("play_")),
      "the playback id",
    );
    await waitFor(() => log.includes(`say.spoken playback=${digest(playbackId)}`), "the playback");

    // The fs audit of everything the sidecar may write (its work dir; the
    // socket is not a file), read AS the sidecar's user, under the profile.
    const audit = await probe(l, as, true, { listAudio: [l.work] });
    const files = audit.listAudio?.files ?? [];
    // Only the stand-in player's observation record remains — no speech artifact.
    expect(files.map((f) => f.slice(l.work.length + 1))).toEqual(["player-obs.jsonl"]);
    for (const f of files) expect(AUDIO_EXT.test(f), f).toBe(false);
    if (!separate) {
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
    // Content-free logs: neither the spoken text nor the playback id appears.
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(playbackId);
  } finally {
    client.close();
    proc.kill();
  }
}

describe("reachy-voice isolation — deny-default confinement (seatbelt)", () => {
  proof(
    "[P1] the shipped profile denies the probed TCP/UDP/mDNS/UNIX connects, a child's TCP connect, an exec, mach lookups and file read/write outside — each control succeeds unconfined",
    seatbeltSkip,
    () => proveConfinement(undefined),
    60_000,
  );
  proof(
    "[P2] the REAL sidecar under the profile round-trips the handshake and a `say` over the authorized socket; no audio, text or id remains",
    seatbeltSkip,
    () => proveRoundTrip(undefined),
    60_000,
  );
});

describe(`reachy-voice isolation — as the separate ${SIDECAR_USER} user`, () => {
  proof(
    `[P3] as ${SIDECAR_USER}: the profile denies the same probed operations (the controls run unconfined as bob's user)`,
    separateSkip,
    () => proveConfinement(SIDECAR_USER),
    60_000,
  );
  proof(
    `[P4] as ${SIDECAR_USER}, on a SCRATCH socket with the deployed mode and group (0660, ${VOICE_GROUP}): bob's user round-trips a \`say\`, an outsider is refused, no audio remains`,
    scratchSocketSkip,
    () => proveRoundTrip(SIDECAR_USER),
    60_000,
  );
});

describe("reachy-voice isolation — #180 S1 key-read proof", () => {
  /** Open each path as the sidecar user (never read): errno per path. */
  function openAs(proofPath: string, paths: string[]): Record<string, string> {
    const r = runAsUser(SIDECAR_USER, proofPath, ["open", ...paths]);
    if (r.status !== 0) throw new Error(`the open proof failed (status ${r.status})`);
    return JSON.parse(r.stdout) as Record<string, string>;
  }
  const DENIED = /^(EACCES|EPERM)$/;
  const uid = process.getuid?.() ?? -1;

  proof(
    "[P5] fixtures: a 0644 control opens; the 0600 admin-pass and agent-key are DENIED (EACCES/EPERM), both agent-owned",
    userSkip,
    () => {
      const dir = mkdtempSync(join(DARWIN ? "/private/tmp" : tmpdir(), "rv-keyread-"));
      scratch.push(dir);
      // TRAVERSABLE (0711): a 0700 dir would deny traversal and prove nothing
      // about the file modes (round 4 item 5).
      chmodSync(dir, 0o711);
      expect((statSync(dir).mode & 0o777).toString(8)).toBe("711");
      const control = join(dir, "control-0644");
      const adminPass = join(dir, "admin-pass");
      const agentKey = join(dir, "agent-key");
      writeFileSync(control, "fixture-control-not-a-secret\n");
      writeFileSync(adminPass, "fixture-not-a-real-secret\n");
      writeFileSync(agentKey, "fixture-not-a-real-key\n");
      chmodSync(control, 0o644);
      chmodSync(adminPass, 0o600);
      chmodSync(agentKey, 0o600);
      for (const f of [adminPass, agentKey]) {
        expect((statSync(f).mode & 0o777).toString(8)).toBe("600");
        expect(statSync(f).uid).toBe(uid); // the agent owns it
      }
      // The proof command: the installed one, or (CI) a world-readable copy.
      let proofPath = join(INSTALL_DIR, "proof.py");
      if (!installed) {
        proofPath = join(dir, "proof.py");
        copyFileSync(join(SIDECAR_SRC, "proof.py"), proofPath);
        chmodSync(proofPath, 0o644);
      }
      const result = openAs(proofPath, [control, adminPass, agentKey]);
      expect(result[control]).toBe("OPENED");
      expect(result[adminPass]).toMatch(DENIED);
      expect(result[agentKey]).toMatch(DENIED);
    },
  );

  proof(
    "[P6] bob's ACTIVE credentials, derived from the agent's bob.yaml: each 0600, agent-owned, and DENIED to the sidecar user (never read)",
    activeSkip,
    () => {
      // HOME was checked against the account database (releaseRoots), so bob's
      // own admin-pass path (homedir-based) is the account's.
      const creds = deriveActiveCredentials({
        name: must(AGENT, "agent"),
        agentsRoot: AGENTS_ROOT,
      });
      expect(creds.adminPass).toBe(join(ROOTS.home, ".flair", "admin-pass"));
      expect(creds.agentKeys.length, "the agent's own key file must exist").toBeGreaterThan(0);
      // every key or token file bob.yaml names must exist (only the provider
      // stores may be absent): a missing one is a misconfigured host, not a pass
      expect(creds.missingKeys, "configured key files that do not exist").toEqual([]);
      // a relative key path is ambiguous (the capability opens it against its
      // own cwd): refused — the host must configure the absolute path
      expect(creds.relativeKeys, "configured key files given as relative paths").toEqual([]);
      // each one present must be a REGULAR file (a 0600 directory is not a key)
      expect(creds.notFiles, "credential paths that are not regular files").toEqual([]);
      expect(existsSync(creds.adminPass), `${creds.adminPass} must exist`).toBe(true);
      for (const f of creds.present) {
        const st = statSync(f); // metadata only: this process never opens it
        expect(st.isFile(), `${f} is a regular file`).toBe(true);
        expect((st.mode & 0o777).toString(8), `${f} mode`).toBe("600");
        expect(st.uid, `${f} owner`).toBe(uid);
      }
      const result = openAs(join(INSTALL_DIR, "proof.py"), creds.present);
      for (const f of creds.present) expect(result[f], f).toMatch(DENIED);
    },
  );

  proof(
    "[P7] the INSTALLED sidecar, profile and proof tooling equal this checkout's; they, the pinned /usr/bin/python3 and what it resolves to (interpreter, base-prefix tree, every sys.path entry), the Piper directory and the deployment record are trusted along their FULL path chains (root-owned, not group/other-writable, no write-granting ACL)",
    installedSkip || userSkip,
    () => {
      for (const f of INSTALLED_FILES) {
        const path = join(INSTALL_DIR, f);
        const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
        expect(sha(path), `${f} is not the reviewed file`).toBe(sha(join(SIDECAR_SRC, f)));
      }
      // What the sudoers path actually runs: the installed proof command
      // reports its own interpreter, as the sidecar user, through the rule.
      expect(PY).toBe(PINNED_PYTHON);
      const proofPy = join(INSTALL_DIR, "proof.py");
      expect(
        execFileSync("/usr/bin/xcode-select", ["-p"], { env: {}, encoding: "utf8" }).trim(),
      ).toBe(PINNED_DEVELOPER_DIR);
      const selected = join(PINNED_DEVELOPER_DIR, "usr/bin/python3");
      expect([
        ...chainProblems(PY),
        ...chainProblems(proofPy),
        ...chainProblems("/var/db/xcode_select_link"),
        ...chainProblems(selected),
        ...treeProblems(dirname(dirname(realpathSync(selected)))),
      ]).toEqual([]);
      const report = runAsUser(SIDECAR_USER, proofPy, ["interp"]);
      expect(report.status, report.stderr).toBe(0);
      const interp = JSON.parse(report.stdout);
      // sudo resets the environment: a caller's DEVELOPER_DIR (which steers the
      // shim) cannot move what the rule runs
      const steered = spawnSync(SUDO, ["-n", "-u", SIDECAR_USER, PY, "-I", proofPy, "interp"], {
        encoding: "utf8",
        env: { ...process.env, DEVELOPER_DIR: "/nonexistent-developer-dir" },
      });
      expect(steered.status, steered.stderr).toBe(0);
      expect(JSON.parse(steered.stdout)).toEqual(interp);
      expect(
        releaseTrustProblems({
          interp,
          installDir: INSTALL_DIR,
          installedFiles: INSTALLED_FILES,
          piperDir: PINNED_PIPER_DIR,
        }),
      ).toEqual([]);
    },
    120_000,
  );
});

describe("reachy-voice isolation — the deployed socket", () => {
  proof(
    `[P8] the DEPLOYED socket: 0660, ${SIDECAR_USER}:${VOICE_GROUP}, in a 0750 directory of that owner and group; an outsider is refused`,
    deployedSocketSkip,
    () => {
      const uidOf = (user: string) =>
        Number(execFileSync(ID, ["-u", user], { encoding: "utf8" }).trim());
      const sidecarUid = uidOf(SIDECAR_USER);
      const gid = must(voiceGid, "the voice group");
      const sock = statSync(DEPLOYED_SOCKET);
      expect(sock.isSocket()).toBe(true);
      expect((sock.mode & 0o777).toString(8)).toBe("660");
      expect(sock.uid).toBe(sidecarUid);
      expect(sock.gid).toBe(gid);
      const dir = statSync(join(PINNED_STATE_DIR, "run"));
      expect((dir.mode & 0o777).toString(8)).toBe("750");
      expect(dir.uid).toBe(sidecarUid);
      expect(dir.gid).toBe(gid);
      // The outsider's connect is refused; it sends nothing either way.
      const r = runAsUser(OUTSIDER, join(INSTALL_DIR, "proof.py"), ["connect", DEPLOYED_SOCKET]);
      expect(JSON.parse(r.stdout).connect).toMatch(/^(EACCES|EPERM)$/);
    },
  );
});
