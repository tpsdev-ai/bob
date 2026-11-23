#!/usr/bin/env python3
"""driven-sidecar — a FAKE reachy-voice/1 sidecar for bob#356 V2a tests.

It is a real process on a real UNIX socket, and it has no ears: apart from the
health line it answers `configure` with, the test supplies every line it sends.
After bob connects and sends `configure`, the stub answers with a strict health
line and prints `READY` on stdout. Then it reads one JSON instruction per stdin
line:

    {"send": <object>}      write one JSON line to bob
    {"sleep": <seconds>}    wait (bounded)
    {"close": true}         close the connection and exit

Every command bob writes is printed on stdout as `CMD <json>`, so the test can
wait for a `say` before making the stub echo it.

Usage: driven-sidecar.py SOCKET [VERSION]
"""
import json
import os
import socket
import sys
import threading
import time

PROTOCOL = "reachy-voice/1"


def main() -> int:
    # A bounded 60 s self-exit watchdog, for when the test's cleanup does not
    # close it first (the test files kill it in afterAll/afterEach).
    watchdog = threading.Timer(60, lambda: os._exit(3))
    watchdog.daemon = True
    watchdog.start()

    sock_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/driven-sidecar.sock"
    version = sys.argv[2] if len(sys.argv) > 2 else "fake-voice-1"
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    server.listen(1)
    conn, _ = server.accept()

    current = {}
    configured = threading.Event()
    send_lock = threading.Lock()

    def send(obj) -> None:
        with send_lock:
            conn.sendall((json.dumps(obj) + "\n").encode())

    def health(extra=None):
        line = {
            "type": "health",
            "protocol": PROTOCOL,
            "version": version,
            "profile": current.get("profile"),
            "generation": current.get("generation"),
            "wakeName": current.get("wakeName"),
            "mode": "off",
            "trainedPhrase": None,
            "modelHash": None,
            "muted": False,
            "ok": True,
        }
        if extra:
            line.update(extra)
        return line

    def pump_commands() -> None:
        buf = b""
        while True:
            try:
                chunk = conn.recv(4096)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    cmd = json.loads(line)
                except Exception:
                    continue
                print("CMD " + json.dumps(cmd), flush=True)
                args = cmd.get("args") if isinstance(cmd, dict) else None
                if (
                    isinstance(cmd, dict)
                    and cmd.get("command") == "configure"
                    and isinstance(args, dict)
                    and args.get("protocol") == PROTOCOL
                ):
                    current.update(
                        profile=args.get("profile"),
                        wakeName=args.get("wakeName"),
                        generation=args.get("generation"),
                    )
                    send(health())
                    configured.set()

    threading.Thread(target=pump_commands, daemon=True).start()
    if not configured.wait(timeout=8):
        conn.close()
        server.close()
        return 1
    print("READY", flush=True)

    closed = False
    for raw in sys.stdin:
        if not raw.strip():
            continue
        try:
            instruction = json.loads(raw)
        except Exception:
            continue
        if "send" in instruction:
            send(instruction["send"])
        elif "sleep" in instruction:
            time.sleep(max(0.0, min(float(instruction["sleep"]), 5.0)))
        elif instruction.get("close"):
            closed = True
            break
    if not closed:
        time.sleep(0.05)
    conn.close()
    server.close()
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
