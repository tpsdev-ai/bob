# The egress probe for the reachy-voice isolation proofs (bob#356 V1).
#
# Run as `python -I -c "<this source>" '<json spec>'` — passed as an argument,
# so the sandboxed interpreter never needs to READ this file — once WITHOUT the
# sandbox, as the CALLER's own user (the control), and once UNDER the shipped
# profile (proof.py probe, which first checks every spec field against a fixed
# whitelist). The caller supplies the targets: loopback ports, scratch paths,
# fixed mach names and the DNS service socket. A mach name this macOS does not
# register has no working control and proves nothing, so the proofs exclude it.
# Prints one JSON object: {probe: {"ok": bool, "err": str}}. TCP/UDP probes
# target loopback; UNIX probes target named socket paths. Mach probes only
# LOOK UP a service name.
import ctypes
import json
import os
import resource
import socket
import subprocess
import sys

spec = json.loads(sys.argv[1])
results = {}
# A bounded descriptor table, as the sidecar sets one (an inherited unlimited
# soft limit makes every child spawn slow), so the probe measures the profile.
_soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)
resource.setrlimit(
    resource.RLIMIT_NOFILE, (256 if _hard == resource.RLIM_INFINITY else min(256, _hard), _hard)
)


def record(name, fn):
    try:
        fn()
        results[name] = {"ok": True, "err": ""}
    except Exception as err:  # noqa: BLE001 — the class is the evidence
        results[name] = {"ok": False, "err": f"{type(err).__name__}: {err}"}


def tcp(family, host, port):
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(3)
    try:
        s.connect((host, port))
    finally:
        s.close()


def udp(host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.sendto(b"probe", (host, port))
    finally:
        s.close()


def unix(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3)
    try:
        s.connect(path)
    finally:
        s.close()


def mach(name):
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    bootstrap_port = ctypes.c_uint.in_dll(libc, "bootstrap_port").value
    look_up = libc.bootstrap_look_up
    look_up.argtypes = [ctypes.c_uint, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint)]
    look_up.restype = ctypes.c_int
    port = ctypes.c_uint(0)
    rc = look_up(bootstrap_port, name.encode(), ctypes.byref(port))
    if rc != 0:
        raise PermissionError(f"bootstrap_look_up rc={rc}")


def child_connect(port):
    code = (
        "import socket,sys\n"
        "s=socket.socket(); s.settimeout(3)\n"
        "try:\n s.connect(('127.0.0.1', int(sys.argv[1])))\n"
        "except PermissionError:\n sys.exit(3)\n"
        "except OSError:\n sys.exit(4)\n"
    )
    r = subprocess.run([sys.executable, "-I", "-c", code, str(port)], timeout=20, check=False)
    if r.returncode != 0:
        raise PermissionError(f"child exit {r.returncode}")


def run_exec(path):
    subprocess.run([path], timeout=20, check=True, stdin=subprocess.DEVNULL)


def read_file(path):
    with open(path, "rb") as fh:
        fh.read(1)


def write_file(path):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    os.unlink(path)


if "tcp4" in spec:
    record("tcp4", lambda: tcp(socket.AF_INET, "127.0.0.1", spec["tcp4"]))
if "tcp6" in spec:
    record("tcp6", lambda: tcp(socket.AF_INET6, "::1", spec["tcp6"]))
if "udp4" in spec:
    record("udp4", lambda: udp("127.0.0.1", spec["udp4"]))
if "unixOther" in spec:
    record("unixOther", lambda: unix(spec["unixOther"]))
if "mdns" in spec:
    record("mdns", lambda: unix(spec["mdns"]))
for name in spec.get("mach", []):
    record(f"mach:{name}", lambda n=name: mach(n))
if "childTcp4" in spec:
    record("childTcp4", lambda: child_connect(spec["childTcp4"]))
if "exec" in spec:
    record("exec", lambda: run_exec(spec["exec"]))
if "readOutside" in spec:
    record("readOutside", lambda: read_file(spec["readOutside"]))
if "writeOutside" in spec:
    record("writeOutside", lambda: write_file(spec["writeOutside"]))
if "listAudio" in spec:
    # The fs audit, as the sidecar user: every file left under the given roots.
    found = []
    for root in spec["listAudio"]:
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                found.append(os.path.join(dirpath, f))
    results["listAudio"] = {"ok": True, "err": "", "files": found}

print(json.dumps(results))
