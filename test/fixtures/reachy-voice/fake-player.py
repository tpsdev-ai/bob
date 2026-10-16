# A stand-in for the OS audio player (bob#356 tests): it records what it was
# handed — the artifact's mode, owner, directory mode and header, never its
# audio — as one JSON line in $HOME/player-obs.jsonl ($HOME is the sidecar's
# work directory), then exits 0. When $HOME/sabotage-cleanup exists it makes
# the artifact's directory a regular file, so rmtree fails for every uid.
import json
import os
import stat
import sys

path = sys.argv[1]
st = os.lstat(path)
dst = os.lstat(os.path.dirname(path))
with open(path, "rb") as fh:
    head = fh.read(4)
obs = {
    "mode": oct(stat.S_IMODE(st.st_mode)),
    "dirMode": oct(stat.S_IMODE(dst.st_mode)),
    "uid": st.st_uid,
    "riff": head == b"RIFF",
    "size": st.st_size,
    "inWorkDir": os.path.realpath(path).startswith(os.path.realpath(os.environ["HOME"]) + os.sep),
}
with open(os.path.join(os.environ["HOME"], "player-obs.jsonl"), "a", encoding="utf-8") as out:
    out.write(json.dumps(obs) + "\n")
if os.path.exists(os.path.join(os.environ["HOME"], "sabotage-cleanup")):
    os.unlink(path)
    os.rmdir(os.path.dirname(path))
    with open(os.path.dirname(path), "w", encoding="utf-8"):
        pass
