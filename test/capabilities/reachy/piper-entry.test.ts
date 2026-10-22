// bob#356 Piper packaging — the entry script installed as $PIPER_DIR/piper and
// the sidecar's synthesis call. Linux-runnable: a stub `piper` package stands in
// for piper-tts on the entry's own sys.path, and a recording stand-in for the
// entry stands in for Piper in the sidecar test.
import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const ENTRY = join(REPO, "sidecar", "reachy-voice", "piper-entry.py");
const SIDECAR = join(REPO, "sidecar", "reachy-voice", "sidecar.py");

const scratch: string[] = [];
const procs: ChildProcess[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function python(): string {
  return spawnSync(
    "python3",
    ["-I", "-c", "import os,sys;print(os.path.realpath(sys.executable))"],
    { encoding: "utf8" },
  ).stdout.trim();
}

/** The stub piper-tts package: it records what the entry handed it — argv, cwd,
 *  `sys.path[0]`, the isolated flag and the output file's mode/owner/type
 *  before and after writing — in $PIPER_OBS, and reads the text from stdin. It
 *  writes through the EXISTING file (r+b). */
const STUB = `
import json, os, stat, sys

# Recorded at import, before main() runs: the entry must have changed directory
# before importing piper.
IMPORT_CWD = os.getcwd()

def main():
    args = sys.argv[1:]
    out = args[args.index("-f") + 1]
    before = os.lstat(out)
    text = sys.stdin.buffer.read().decode("utf-8")
    with open(out, "r+b") as fh:
        fh.truncate(0)
        fh.write(b"RIFF" + text.encode("utf-8"))
    after = os.lstat(out)
    def seen(st):
        return {"mode": oct(stat.S_IMODE(st.st_mode)), "uid": st.st_uid,
                "regular": stat.S_ISREG(st.st_mode)}
    with open(os.environ["PIPER_OBS"], "w", encoding="utf-8") as obs:
        json.dump({
            "argv": args,
            "cwd": os.getcwd(),
            "import_cwd": IMPORT_CWD,
            "isolated": sys.flags.isolated,
            "executable": os.path.realpath(sys.executable),
            "path0": sys.path[0],
            "before": seen(before),
            "after": seen(after),
            "text": text,
        }, obs)
    if os.environ.get("PIPER_STUB_EXIT"):
        sys.exit(int(os.environ["PIPER_STUB_EXIT"]))
`;

function layout() {
  const base = mkdtempSync(join(tmpdir(), "rv-piper-"));
  scratch.push(base);
  // The entry runs from its install directory, beside the lib it puts on
  // sys.path: a copy here, as RUNBOOK step 3 installs it at $PIPER_DIR/piper.
  copyFileSync(ENTRY, join(base, "piper"));
  mkdirSync(join(base, "lib", "piper"), { recursive: true });
  writeFileSync(join(base, "lib", "piper", "__init__.py"), "");
  writeFileSync(join(base, "lib", "piper", "__main__.py"), STUB);
  const work = join(base, "work");
  mkdirSync(work, { mode: 0o700 });
  chmodSync(work, 0o700);
  const out = join(work, "speech.wav");
  writeFileSync(out, "", { mode: 0o600 });
  return { base, entry: join(base, "piper"), work, out, obs: join(base, "obs.json") };
}

function runEntry(
  entry: string,
  args: string[],
  env: Record<string, string> = {},
  input = "hello",
) {
  return spawnSync(python(), ["-I", entry, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** Runs the entry in this process, under an isolated interpreter, and prints
 *  its cwd before and after main, then exits with the entry's status. */
const IN_PROCESS = `
import os, sys
path = sys.argv[1]
ns = {"__name__": "entry", "__file__": path}
with open(path, "rb") as fh:
    exec(compile(fh.read(), path, "exec"), ns)
before = os.getcwd()
status = ns["main"](sys.argv[2:])
sys.stdout.write(before + "\\n" + os.getcwd() + "\\n")
raise SystemExit(status)
`;

function runEntryInProcess(
  entry: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) {
  return spawnSync(python(), ["-I", "-c", IN_PROCESS, entry, ...args], {
    cwd,
    input: "hello",
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const SHAPES = [
  [],
  ["--model", "voice.onnx"],
  ["--model", "voice.onnx", "--output_file"],
  ["--output_file", "speech.wav", "--model", "voice.onnx"],
  ["--model", "voice.onnx", "--output_file", "speech.wav", "extra"],
  ["--model=voice.onnx", "--output_file=speech.wav"],
  ["--Model", "voice.onnx", "--output_file", "speech.wav"],
];

describe("bob#356 — the installed Piper entry script", () => {
  it("accepts exactly --model M --output_file W: piper gets -m/-f, from the output's directory, with lib first on sys.path", () => {
    const { base, entry, work, out, obs } = layout();
    const model = join(base, "voice.onnx");
    const r = runEntry(entry, ["--model", model, "--output_file", out], { PIPER_OBS: obs });
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(readFileSync(obs, "utf8"));
    expect(seen.argv).toEqual(["-m", model, "-f", out]);
    // Compare the reported cwd with the resolved work directory.
    expect(seen.cwd).toBe(realpathSync(work));
    // Recorded when the stub was imported, so the chdir precedes the import.
    expect(seen.import_cwd).toBe(realpathSync(work));
    // The entry puts its own realpath's lib on sys.path, so this is resolved too.
    expect(seen.path0).toBe(join(realpathSync(base), "lib"));
    expect(seen.isolated).toBe(1);
    expect(seen.executable).toBe(python());
    expect(seen.text).toBe("hello");
    // The pre-created file keeps its mode, owner and type through Piper's write.
    expect(seen.before).toEqual({ mode: "0o600", uid: process.getuid?.(), regular: true });
    expect(seen.after).toEqual(seen.before);
    // The final state, read first and stat'd last.
    expect(readFileSync(out, "utf8")).toBe("RIFFhello");
    const st = lstatSync(out);
    expect(st.isFile()).toBe(true);
    expect((st.mode & 0o777).toString(8)).toBe("600");
    expect(st.uid).toBe(process.getuid?.());
  }, 30_000);

  it("returns Piper's exit status", () => {
    const { base, entry, out, obs } = layout();
    const r = runEntry(entry, ["--model", join(base, "voice.onnx"), "--output_file", out], {
      PIPER_OBS: obs,
      PIPER_STUB_EXIT: "7",
    });
    expect(r.status).toBe(7);
  }, 30_000);

  it.each(SHAPES.map((argv) => [argv]))(
    "refuses %j without running piper",
    (argv) => {
      const { entry, obs } = layout();
      const r = runEntry(entry, [...argv], { PIPER_OBS: obs });
      expect(r.status).not.toBe(0);
      expect(existsSync(obs)).toBe(false);
      expect(r.stderr).toContain("usage: piper --model MODEL --output_file OUTPUT");
    },
    30_000,
  );

  it.each([
    ["an abbreviated flag", (m: string, o: string) => ["--mod", m, "--output_file", o]],
    ["the = form", (m: string, o: string) => [`--model=${m}`, "--output_file", o]],
    [
      "an extra trailing argument",
      (m: string, o: string) => ["--model", m, "--output_file", o, "extra"],
    ],
    ["reversed flags", (m: string, o: string) => ["--output_file", o, "--model", m]],
    ["a duplicated flag", (m: string, o: string) => ["--model", m, "--model", m]],
    ["a missing value", (m: string, o: string) => ["--model", m, "--output_file"]],
  ])(
    "refuses %s: exit 2, no piper call, cwd unchanged",
    (_, argv) => {
      const { base, entry, out, obs } = layout();
      const r = runEntryInProcess(entry, argv(join(base, "voice.onnx"), out), base, {
        PIPER_OBS: obs,
      });
      expect(r.status, r.stderr).toBe(2);
      expect(existsSync(obs)).toBe(false);
      const [before, after] = r.stdout.trim().split("\n");
      expect(before).toBe(realpathSync(base));
      expect(after).toBe(before);
    },
    30_000,
  );

  it("refuses a relative --model path without calling piper or changing cwd", () => {
    const { base, entry, out, obs } = layout();
    const r = runEntryInProcess(entry, ["--model", "voice.onnx", "--output_file", out], base, {
      PIPER_OBS: obs,
    });
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain("must be absolute paths");
    expect(existsSync(obs)).toBe(false);
    const [before, after] = r.stdout.trim().split("\n");
    expect(before).toBe(realpathSync(base));
    expect(after).toBe(before);
  }, 30_000);

  it("refuses a relative --output_file path without calling piper or changing cwd", () => {
    const { base, entry, obs } = layout();
    const r = runEntryInProcess(
      entry,
      ["--model", join(base, "voice.onnx"), "--output_file", join("work", "speech.wav")],
      base,
      { PIPER_OBS: obs },
    );
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain("must be absolute paths");
    expect(existsSync(obs)).toBe(false);
    const [before, after] = r.stdout.trim().split("\n");
    expect(before).toBe(realpathSync(base));
    expect(after).toBe(before);
  }, 30_000);
});

/** A stand-in for the entry as the sidecar runs it: it records the argv, cwd,
 *  isolated flag and interpreter in $HOME/piper-obs.json, and writes a short
 *  silent WAV into the pre-created --output_file. */
const SYNTH = `
import json, os, sys, wave
args = sys.argv[1:]
out = args[args.index("--output_file") + 1]
text = sys.stdin.buffer.read().decode("utf-8")
with open(out, "r+b") as fh:
    fh.truncate(0)
    with wave.open(fh, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\\x00\\x00" * (160 * max(1, len(text))))
with open(os.path.join(os.environ["HOME"], "piper-obs.json"), "w", encoding="utf-8") as obs:
    json.dump({
        "argv": args,
        "cwd": os.getcwd(),
        "isolated": sys.flags.isolated,
        "executable": os.path.realpath(sys.executable),
    }, obs)
`;

describe("bob#356 — the sidecar's synthesis call", () => {
  it("runs the entry under its own interpreter, with the model/output argv, from the speech file's directory", async () => {
    const py = python();
    const base = mkdtempSync(join(tmpdir(), "rv-piper-sidecar-"));
    scratch.push(base);
    const tts = join(base, "tts");
    mkdirSync(tts, { mode: 0o755 });
    // The entry is installed 0644 and is not executable: the sidecar reads it.
    writeFileSync(join(tts, "piper"), SYNTH);
    writeFileSync(join(tts, "player"), `#!${py} -I\nimport sys\nsys.exit(0)\n`, { mode: 0o755 });
    const model = randomBytes(64);
    writeFileSync(join(tts, "model.onnx"), model);
    const work = join(base, "work");
    mkdirSync(work, { mode: 0o700 });
    chmodSync(work, 0o700);
    const sock = join(base, "s.sock");
    const proc = spawn(
      py,
      [
        "-I",
        SIDECAR,
        "--socket",
        sock,
        "--work-dir",
        work,
        "--piper",
        join(tts, "piper"),
        "--piper-model",
        join(tts, "model.onnx"),
        "--piper-model-sha256",
        createHash("sha256").update(model).digest("hex"),
        "--player",
        join(tts, "player"),
        "--device-mute",
        "absent",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    procs.push(proc);
    let log = "";
    proc.stderr?.on("data", (b: Buffer) => {
      log += b.toString();
    });
    const until = Date.now() + 10_000;
    while (!log.includes("listening")) {
      if (Date.now() > until) throw new Error(`the sidecar never listened: ${log}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    const conn = createConnection(sock);
    await new Promise<void>((resolve, reject) => {
      conn.once("error", reject);
      conn.once("connect", resolve);
    });
    conn.write(
      `${JSON.stringify({ command: "configure", args: { protocol: "reachy-voice/1", wakeName: "jarvis", generation: 1 } })}\n`,
    );
    conn.write(
      `${JSON.stringify({ command: "say", args: { text: "hello", playbackId: "play_1" } })}\n`,
    );
    const spoken = Date.now() + 10_000;
    while (!log.includes("say.spoken")) {
      if (Date.now() > spoken) throw new Error(`no playback: ${log}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    conn.destroy();
    const seen = JSON.parse(readFileSync(join(work, "piper-obs.json"), "utf8"));
    expect(seen.argv.slice(0, 2)).toEqual(["--model", join(tts, "model.onnx")]);
    expect(seen.argv[2]).toBe("--output_file");
    const resolvedWork = realpathSync(work);
    expect(seen.cwd.startsWith(`${resolvedWork}/tts-`)).toBe(true);
    // The speech file sits in the cwd's directory, which is work/tts-*: name it
    // from the unresolved work dir, since the child reports cwd resolved.
    expect(seen.argv[3]).toBe(join(work, basename(seen.cwd), "speech.wav"));
    expect(seen.isolated).toBe(1);
    expect(seen.executable).toBe(py);
  }, 30_000);
});
