#!/usr/bin/env python3
"""reachy-stub — the STUB sidecar (bob#180 §5 S3; bob#356 V1 handshake).

Speaks the reachy-voice/1 handshake, then replays a scripted JSON-line event
file over a UNIX socket. It is UNTRUSTED (spec §3.2): bob applies policy to
everything it emits. No hardware, no model, no network, no key material.

Protocol (bob#356 V1):
  1. bob connects and sends ONE control command:
       {"command":"configure","args":{"protocol":"reachy-voice/1","profile":…,
        "wakeName":…,"generation":n}}
  2. the stub answers with a strict reachy-voice/1 health line repeating the
     protocol, profile, wake name and generation, plus its own version;
  3. only then does it replay the event file. A replayed line whose string
     value is exactly "$version", "$profile", "$wakeName" or "$generation" gets
     the current value, so a fixture can carry a valid status line (or, with a
     literal value, a deliberately mismatched one);
  4. it ends with the explicit end-of-replay marker (a health line with
     "replayEnd": true) and closes.
It answers `state` with its current health line; action commands get no reply.

Usage: sidecar.py SOCKET [EVENTS] [VERSION]
"""
import json
import os
import socket
import sys
import threading
import time

PROTOCOL = "reachy-voice/1"


def main() -> int:
    # A fixture never outlives its test: whatever happens, exit after 60 s.
    watchdog = threading.Timer(60, lambda: os._exit(3))
    watchdog.daemon = True  # never keeps a finished stub alive
    watchdog.start()
    sock_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/reachy-stub.sock"
    events_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "events.jsonl")
    version = sys.argv[3] if len(sys.argv) > 3 else "reachy-stub-1"
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
            "profile": current["profile"],
            "generation": current["generation"],
            "wakeName": current["wakeName"],
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
                name = cmd.get("command") if isinstance(cmd, dict) else None
                args = cmd.get("args") if isinstance(cmd, dict) else None
                if name == "configure" and isinstance(args, dict) and args.get("protocol") == PROTOCOL:
                    current.update(
                        profile=args.get("profile"),
                        wakeName=args.get("wakeName"),
                        generation=args.get("generation"),
                    )
                    send(health())
                    configured.set()
                elif name == "state" and configured.is_set():
                    send(health())

    threading.Thread(target=pump_commands, daemon=True).start()
    if not configured.wait(timeout=8):
        conn.close()
        server.close()
        return 1

    def fill(value):
        if isinstance(value, str) and value.startswith("$") and value[1:] in ("version", "profile", "wakeName", "generation"):
            return version if value == "$version" else current[value[1:]]
        return value

    with open(events_path, "r", encoding="utf-8") as fh:
        for raw in fh:
            if not raw.strip():
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                obj = None
            if isinstance(obj, dict) and obj.get("type") == "health":
                send({k: fill(v) for k, v in obj.items()})
            else:
                with send_lock:
                    conn.sendall(raw.encode() if raw.endswith("\n") else (raw + "\n").encode())
            time.sleep(0.01)
    # An EXPLICIT end-of-replay marker, so a consumer can tell a complete replay
    # from a truncated one without counting the fixture's own lines (round 4).
    send(health({"replayEnd": True}))
    time.sleep(0.05)
    conn.close()
    server.close()
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
