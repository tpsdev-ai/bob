#!/usr/bin/env python3
"""reachy-voice sidecar, V1 "mouth" (bob#356).

The voice-profile sidecar: it speaks, and it does nothing else. It has NO
microphone code at all — no capture, no wake model, no speech-to-text — so its
health reports mode "off". It is UNTRUSTED by design (bob#180 §3.2): it runs as
its own unprivileged OS user under the deny-default sandbox profile beside it
(reachy-voice.sb), it talks to bob only through one UNIX socket, and bob applies
its own policy and audit before any command reaches it.

Protocol (reachy-voice/1, one JSON object per line, bob -> sidecar commands
{"command": name, "args": {...}}, sidecar -> bob events {"type": ...}):
  1. bob connects and sends `configure` {protocol, profile, wakeName, generation}.
     Until it does, every other command is ignored.
  2. the sidecar answers with a strict health line: its own version and device
     profile (never bob's), the wake name and generation bob pushed, its wake
     mode ("off": no ears), trainedPhrase/modelHash (null), the device mute and ok.
  3. after that: `say` {text, playbackId} speaks one line; `state` and `health`
     answer with the current health line; another `configure` re-configures.

Speech (local text-to-speech with Piper):
  - the text is validated again here (one line, 1-500 characters);
  - Piper writes the waveform into a fresh 0700 directory under --work-dir, to a
    file created 0600 before Piper opens it (and the process umask is 077);
  - the OS player plays that file; the file and its directory are removed
    afterwards, whatever happened. Nothing else is written anywhere.
  - Nothing captured: this process never opens an input device. Leftover
    artifacts from a crash are removed at startup.

Logs are content-free: event names, playback ids and error CLASSES — never the
spoken text, never a path inside an artifact. Core dumps are disabled.

Usage (normally via the operator's launcher; see RUNBOOK.md):
  sidecar.py --socket PATH --work-dir PATH --piper PATH --piper-model PATH
             --piper-model-sha256 HEX --player PATH [--device-mute unknown|absent]
             [--socket-mode 0660]

Python 3.9+, standard library only.
"""

import argparse
import hashlib
import json
import os
import re
import resource
import shutil
import socket
import stat
import subprocess
import sys
import tempfile

SIDECAR_VERSION = "0.1.0"
PROTOCOL = "reachy-voice/1"
PROFILE = "voice"  # the hardware this sidecar drives: a mic + a speaker, no body
MAX_LINE_BYTES = 64 * 1024
WAKE_NAME = re.compile(r"^[a-z]+(?:[ -][a-z]+)*$")
PLAYBACK_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TTS_DIR_PREFIX = "tts-"
SYNTH_TIMEOUT_S = 30
PLAY_TIMEOUT_S = 60
# The environment every child (Piper, the player) gets: nothing inherited.
CHILD_ENV_KEYS = ("LANG",)


def log(event, **fields):
    """One content-free log line on stderr."""
    parts = [event] + [f"{k}={v}" for k, v in sorted(fields.items())]
    sys.stderr.write("reachy-voice: " + " ".join(parts) + "\n")
    sys.stderr.flush()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def private_dir(path):
    """Create (or check) a 0700 directory owned by this user."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise SystemExit(f"reachy-voice: --work-dir must be a 0700 directory owned by uid {os.getuid()}")


class Mouth:
    """Piper -> an ephemeral 0600 waveform -> the OS player -> removed."""

    def __init__(self, work_dir, piper, model, player):
        self.work_dir = work_dir
        self.piper = piper
        self.model = model
        self.player = player
        self.env = {k: os.environ[k] for k in CHILD_ENV_KEYS if k in os.environ}
        self.env["PATH"] = "/usr/bin:/bin"
        self.env["HOME"] = work_dir

    def sweep(self):
        """Remove artifacts a crash left behind: speech is never kept."""
        for name in os.listdir(self.work_dir):
            if name.startswith(TTS_DIR_PREFIX):
                shutil.rmtree(os.path.join(self.work_dir, name), ignore_errors=True)

    def speak(self, text, playback_id):
        tts_dir = tempfile.mkdtemp(prefix=TTS_DIR_PREFIX, dir=self.work_dir)
        try:
            os.chmod(tts_dir, 0o700)
            wav = os.path.join(tts_dir, "speech.wav")
            fd = os.open(wav, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
            os.close(fd)
            synth = subprocess.run(
                [self.piper, "--model", self.model, "--output_file", wav],
                input=text.encode("utf-8"),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=self.env,
                timeout=SYNTH_TIMEOUT_S,
                check=False,
            )
            if synth.returncode != 0:
                log("say.synth_failed", playback=playback_id, rc=synth.returncode)
                return False
            st = os.lstat(wav)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o600:
                log("say.artifact_refused", playback=playback_id)
                return False
            if st.st_size == 0:
                log("say.synth_empty", playback=playback_id)
                return False
            play = subprocess.run(
                [self.player, wav],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=self.env,
                timeout=PLAY_TIMEOUT_S,
                check=False,
            )
            if play.returncode != 0:
                log("say.play_failed", playback=playback_id, rc=play.returncode)
                return False
            log("say.spoken", playback=playback_id)
            return True
        except subprocess.TimeoutExpired:
            log("say.timeout", playback=playback_id)
            return False
        except OSError as err:
            log("say.error", playback=playback_id, error=type(err).__name__)
            return False
        finally:
            shutil.rmtree(tts_dir, ignore_errors=True)


class Session:
    """One bob connection: the handshake, then commands."""

    def __init__(self, conn, mouth, device_muted):
        self.conn = conn
        self.mouth = mouth
        self.device_muted = device_muted
        self.configured = None  # {wakeName, generation} once bob configured us

    def send(self, obj):
        self.conn.sendall((json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8"))

    def health(self):
        return {
            "type": "health",
            "protocol": PROTOCOL,
            "version": SIDECAR_VERSION,
            "profile": PROFILE,
            "generation": self.configured["generation"],
            "wakeName": self.configured["wakeName"],
            "mode": "off",
            "trainedPhrase": None,
            "modelHash": None,
            "muted": self.device_muted,
            "ok": True,
        }

    def handle(self, cmd):
        if not isinstance(cmd, dict):
            return
        name = cmd.get("command")
        args = cmd.get("args")
        if not isinstance(args, dict):
            args = {}
        if name == "configure":
            gen = args.get("generation")
            wake = args.get("wakeName")
            if (
                args.get("protocol") == PROTOCOL
                and isinstance(gen, int)
                and not isinstance(gen, bool)
                and gen >= 1
                and isinstance(wake, str)
                and 2 <= len(wake) <= 32
                and WAKE_NAME.match(wake)
            ):
                # The profile bob asked for is NOT adopted: the health line
                # reports this sidecar's own hardware, and bob compares.
                self.configured = {"wakeName": wake, "generation": gen}
                log("configured", generation=gen)
                self.send(self.health())
            else:
                log("configure.refused")
            return
        if self.configured is None:
            log("command.before_configure")
            return
        if name in ("state", "health"):
            self.send(self.health())
            return
        if name == "say":
            text = args.get("text")
            playback_id = args.get("playbackId")
            if set(args.keys()) != {"text", "playbackId"}:
                log("say.refused", reason="fields")
                return
            if not isinstance(playback_id, str) or not PLAYBACK_ID.match(playback_id):
                log("say.refused", reason="playbackId")
                return
            if (
                not isinstance(text, str)
                or not (1 <= len(text) <= 500)
                or "\r" in text
                or "\n" in text
            ):
                log("say.refused", playback=playback_id, reason="text")
                return
            if self.device_muted:
                log("say.muted", playback=playback_id)
                return
            self.mouth.speak(text, playback_id)
            return
        log("command.unsupported")

    def serve(self):
        buf = b""
        discarding = False
        while True:
            try:
                chunk = self.conn.recv(4096)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while True:
                nl = buf.find(b"\n")
                if nl == -1:
                    if len(buf) > MAX_LINE_BYTES:
                        buf = b""
                        discarding = True
                    break
                line, buf = buf[:nl], buf[nl + 1 :]
                if discarding:
                    discarding = False
                    continue
                if len(line) > MAX_LINE_BYTES or not line.strip():
                    continue
                try:
                    cmd = json.loads(line)
                except ValueError:
                    log("command.malformed")
                    continue
                try:
                    self.handle(cmd)
                except OSError as err:
                    log("send.failed", error=type(err).__name__)
                    return


def main(argv=None):
    ap = argparse.ArgumentParser(description="reachy-voice V1 mouth sidecar")
    ap.add_argument("--socket", required=True)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--piper", required=True)
    ap.add_argument("--piper-model", required=True)
    ap.add_argument("--piper-model-sha256", required=True)
    ap.add_argument("--player", required=True)
    ap.add_argument(
        "--device-mute",
        choices=("unknown", "absent"),
        default="unknown",
        help="unknown: the hardware mute cannot be read, so report muted (fail closed); "
        "absent: the operator declares no capture device is attached (V1 mouth only)",
    )
    ap.add_argument("--socket-mode", default="0660")
    opts = ap.parse_args(argv)

    # No core dumps: a crash must not write process memory (speech text) to disk.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # A bounded descriptor table: the sidecar needs a handful, and an inherited
    # "unlimited" soft limit makes every child spawn walk it.
    _soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    limit = 256 if hard == resource.RLIM_INFINITY else min(256, hard)
    resource.setrlimit(resource.RLIMIT_NOFILE, (limit, hard))
    os.umask(0o077)

    if not SHA256.match(opts.piper_model_sha256):
        raise SystemExit("reachy-voice: --piper-model-sha256 must be 64 lowercase hex characters")
    for path in (opts.piper, opts.player):
        if not (os.path.isfile(path) and os.access(path, os.X_OK)):
            raise SystemExit("reachy-voice: --piper and --player must be executable files")
    if sha256_file(opts.piper_model) != opts.piper_model_sha256:
        raise SystemExit("reachy-voice: the Piper model does not match its pinned sha256")
    private_dir(opts.work_dir)

    mouth = Mouth(opts.work_dir, opts.piper, opts.piper_model, opts.player)
    mouth.sweep()
    device_muted = opts.device_mute != "absent"

    if os.path.lexists(opts.socket):
        os.unlink(opts.socket)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(opts.socket)
    os.chmod(opts.socket, int(opts.socket_mode, 8))
    server.listen(1)
    log("listening", version=SIDECAR_VERSION, profile=PROFILE, muted=device_muted)
    try:
        while True:
            conn, _ = server.accept()
            log("connected")
            try:
                Session(conn, mouth, device_muted).serve()
            finally:
                conn.close()
                log("disconnected")
    except KeyboardInterrupt:
        return 0
    finally:
        server.close()
        try:
            os.unlink(opts.socket)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
