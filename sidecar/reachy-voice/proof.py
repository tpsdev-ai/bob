#!/usr/bin/env python3
"""reachy-voice isolation proof entry point (bob#356 V1, round 1).

The ONE command the agent user may run as another user for the isolation
proofs, through a sudoers rule that names exactly this file and interpreter
(RUNBOOK step 2). Installed root-owned beside the sidecar and its profile, so
what it does is fixed by the reviewed commit; the release check verifies the
installed copy's sha256 against the checkout. Each subcommand is bounded:

  open <path>...            try to OPEN each path for reading and report the
                            errno (or OPENED); nothing is ever read.
  connect <socket>          try to connect to a UNIX socket; report the errno.
  probe confined|open <tts_dir> <work_dir> <socket> <spec-json>
                            run THIS directory's egress probe, under THIS
                            directory's profile (confined) or not (open: the
                            unconfined control), as the calling user.
  sidecar <tts_dir> <work_dir> <socket> <model_sha256> <socket_mode>
                            run THIS directory's sidecar under THIS directory's
                            profile with a test's stand-in Piper and player.
  clean <work_dir>          remove a proof's work directory (the sidecar
                            user's own files).

Every path argument must resolve under /private/tmp/rv- (a proof's scratch
layout), so the proof can never be pointed at the deployed state directory.
The interpreter prefix and the sidecar directory are derived here, never taken
as arguments. Output: one JSON object on stdout.

Python 3.9+, standard library only.
"""

import json
import os
import socket
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
SCRATCH = "/private/tmp/rv-"


def scratch_path(value):
    real = os.path.realpath(value)
    if not real.startswith(SCRATCH):
        raise SystemExit(f"proof: {value!r} is not under {SCRATCH}")
    return real


def python_prefix():
    exe = os.path.realpath(sys.executable)
    return os.path.commonpath([exe, os.path.realpath(sys.base_prefix)])


def profile_args(tts_dir, work_dir, sock):
    return [
        SANDBOX_EXEC,
        "-f",
        os.path.join(HERE, "reachy-voice.sb"),
        "-D",
        f"PYTHON_PREFIX={python_prefix()}",
        "-D",
        f"SIDECAR_DIR={HERE}",
        "-D",
        f"TTS_DIR={tts_dir}",
        "-D",
        f"PLAYER={os.path.join(tts_dir, 'player')}",
        "-D",
        f"WORK_DIR={work_dir}",
        "-D",
        f"SOCKET={sock}",
    ]


def cmd_open(paths):
    out = {}
    for p in paths:
        try:
            fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError as err:
            import errno as errno_mod

            out[p] = errno_mod.errorcode.get(err.errno, str(err.errno))
            continue
        os.close(fd)  # opened, never read
        out[p] = "OPENED"
    print(json.dumps(out))


def cmd_connect(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3)
    try:
        s.connect(path)
        result = "CONNECTED"
    except OSError as err:
        import errno as errno_mod

        result = errno_mod.errorcode.get(err.errno, str(err.errno))
    finally:
        s.close()
    print(json.dumps({"connect": result}))


def cmd_probe(mode, tts_dir, work_dir, sock, spec):
    json.loads(spec)  # must be JSON
    tts_dir, work_dir, sock = scratch_path(tts_dir), scratch_path(work_dir), scratch_path(sock)
    with open(os.path.join(HERE, "egress-probe.py"), encoding="utf-8") as fh:
        source = fh.read()
    argv = [os.path.realpath(sys.executable), "-I", "-c", source, spec]
    if mode == "confined":
        argv = profile_args(tts_dir, work_dir, sock) + argv
    elif mode != "open":
        raise SystemExit("proof: probe mode is confined or open")
    os.execv(argv[0], argv)


def cmd_sidecar(tts_dir, work_dir, sock, model_sha, socket_mode):
    tts_dir, work_dir, sock = scratch_path(tts_dir), scratch_path(work_dir), scratch_path(sock)
    if socket_mode not in ("0600", "0660"):
        raise SystemExit("proof: socket mode is 0600 or 0660")
    argv = profile_args(tts_dir, work_dir, sock) + [
        os.path.realpath(sys.executable),
        "-I",
        os.path.join(HERE, "sidecar.py"),
        "--socket",
        sock,
        "--work-dir",
        work_dir,
        "--piper",
        os.path.join(tts_dir, "piper"),
        "--piper-model",
        os.path.join(tts_dir, "model.onnx"),
        "--piper-model-sha256",
        model_sha,
        "--player",
        os.path.join(tts_dir, "player"),
        "--device-mute",
        "absent",
        "--socket-mode",
        socket_mode,
    ]
    os.execv(argv[0], argv)


def cmd_clean(work_dir):
    import shutil

    shutil.rmtree(scratch_path(work_dir), ignore_errors=True)
    print(json.dumps({"clean": not os.path.lexists(work_dir)}))


def main(argv):
    if not argv:
        raise SystemExit(__doc__)
    cmd, rest = argv[0], argv[1:]
    if cmd == "open" and rest:
        cmd_open(rest)
    elif cmd == "connect" and len(rest) == 1:
        cmd_connect(rest[0])
    elif cmd == "probe" and len(rest) == 5:
        cmd_probe(*rest)
    elif cmd == "sidecar" and len(rest) == 5:
        cmd_sidecar(*rest)
    elif cmd == "clean" and len(rest) == 1:
        cmd_clean(rest[0])
    else:
        raise SystemExit("proof: unknown subcommand or arguments")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
