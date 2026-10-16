"""Fixed V1 LaunchDaemon derivation; run with /usr/bin/python3 -I and a fixed env."""

import hashlib
import json
import os
import plistlib
import sys

INSTALL = "/usr/local/libexec/bob/reachy-voice"
PIPER_DIR = "/usr/local/libexec/bob/piper"
STATE = "/usr/local/var/bob/reachy-voice"
PLIST = "/Library/LaunchDaemons/dev.tps.reachy-voice.plist"


def launch_spec():
    real = os.path.realpath
    python = real("/Library/Developer/CommandLineTools/usr/bin/python3")
    if real(sys.executable) != python or sys.flags.isolated != 1:
        raise ValueError("launch derivation requires the isolated Command Line Tools interpreter")
    prefix = os.path.commonpath([python, real(sys.base_prefix)])
    install, piper, state = real(INSTALL), real(PIPER_DIR), real(STATE)
    player = real("/usr/bin/afplay")
    work, socket = real(state + "/work"), real(state + "/run/voice.sock")
    model = real(piper + "/voice.onnx")
    with open(model, "rb") as source:
        model_sha = hashlib.sha256(source.read()).hexdigest()
    args = ["/usr/bin/sandbox-exec", "-f", real(install + "/reachy-voice.sb")]
    for name, value in [
        ("PYTHON_PREFIX", prefix),
        ("SIDECAR_DIR", install),
        ("TTS_DIR", piper),
        ("PLAYER", player),
        ("WORK_DIR", work),
        ("SOCKET", socket),
    ]:
        args.extend(["-D", name + "=" + value])
    args.extend([
        python, "-I", real(install + "/sidecar.py"),
        "--socket", socket, "--work-dir", work,
        "--piper", real(piper + "/piper"), "--piper-model", model,
        "--piper-model-sha256", model_sha, "--player", player,
        "--device-mute", "absent", "--socket-mode", "0660",
    ])
    return {
        "Label": "dev.tps.reachy-voice",
        "UserName": "jarvis-sidecar",
        "GroupName": "jarvis-voice",
        "ProgramArguments": args,
        "KeepAlive": True,
        "RunAtLoad": True,
        "StandardErrorPath": real(state + "/log/sidecar.log"),
    }


def check_job(path):
    expected = launch_spec()
    with open(path, "rb") as source:
        deployed = plistlib.load(source)
    args = deployed.get("ProgramArguments")
    index = expected["ProgramArguments"].index("-I") - 1
    interpreter = None
    if isinstance(args, list) and len(args) > index and isinstance(args[index], str):
        interpreter = args[index]
        args[index] = os.path.realpath(interpreter)
    if deployed != expected:
        raise ValueError("deployed LaunchDaemon differs from the fixed V1 launch specification")
    return interpreter


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        json.dump({"interpreter": check_job(PLIST)}, sys.stdout)
    elif not sys.argv[1:]:
        json.dump(launch_spec(), sys.stdout)
    else:
        raise SystemExit("usage: launch.py [--check]")
