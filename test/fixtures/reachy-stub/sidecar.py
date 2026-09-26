#!/usr/bin/env python3
"""reachy-stub — the S3 STUB sidecar (bob#180 §5 S3).

Replays a scripted JSON-line event file over a UNIX socket, then answers
commands with a canned JSON line. It is UNTRUSTED (spec §3.2): bob applies
policy to everything it emits. No hardware, no model, no network. It reads no
key material — it is run as its own unprivileged user in the key-read proof.
"""
import json
import os
import socket
import sys
import threading
import time

def main() -> int:
    sock_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/reachy-stub.sock"
    events_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "events.jsonl")
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    server.listen(1)
    conn, _ = server.accept()

    def pump_commands() -> None:
        buf = b""
        while True:
            chunk = conn.recv(4096)
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
                # The stub answers every command with one canned line.
                conn.sendall((json.dumps({"type": "health", "ok": True, "ack": cmd.get("command")}) + "\n").encode())

    threading.Thread(target=pump_commands, daemon=True).start()

    with open(events_path, "r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                conn.sendall(line.encode() if line.endswith("\n") else (line + "\n").encode())
                time.sleep(0.01)
    time.sleep(0.05)
    conn.close()
    server.close()
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
