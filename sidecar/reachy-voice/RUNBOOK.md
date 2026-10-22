# reachy-voice sidecar — operator runbook (bob#356 V1, "mouth")

The voice sidecar speaks for a jarvis-class agent; its intended output is a USB
speakerphone, which is unverified until the step 7 playback check passes. In
V1 it only **speaks**: it has no microphone code, no wake model and no
speech-to-text, and it reports wake mode `off`. It is untrusted (bob#180 §3.2):
it runs as its own unprivileged macOS user, under the deny-default seatbelt
profile `reachy-voice.sb`, and listens on one UNIX socket. For every `say` bob
SENDS, bob applies its policy and writes its audit record first; a process that
reaches the socket directly bypasses both (see "What bob's audit covers").

Steps 1–7 need an administrator **once**, at the host; step 8 runs as bob.

Files in this directory:

| File | What it is |
| --- | --- |
| `sidecar.py` | The sidecar (Python 3.9+, standard library only). Reports version `0.1.0`. |
| `reachy-voice.sb` | The deny-default seatbelt profile it runs under. |
| `launch.py` | Fixed LaunchDaemon derivation and deployed-plist check. |
| `piper-entry.py` | Installed as `$PIPER_DIR/piper`: runs piper-tts's CLI under the sidecar's interpreter (step 3). |
| `piper-requirements.txt` | The pinned wheel set piper-tts is installed from, with a sha256 per wheel (step 3). |
| `proof.py` | The installed command for release-host separate-user proofs (step 2). |
| `egress-probe.py` | Confined via `proof.py`; the test runs its source directly as bob with `PY -I -c <source> <spec-json>` for the unconfined control. |
| `RUNBOOK.md` | This file. |

**What bob's audit covers.** bob audits every `say` it sends. The socket below
is 0660, owner `jarvis-sidecar`, group `jarvis-voice`: any process with access
to it — bob's own OS user, or another member of that group — can make the
sidecar speak without bob's policy or audit. Keep that group to bob's user.

## 0. Set the names once

Run steps 1–7 in one admin shell (`zsh`) after setting these. Step 8 (the
release-host check) is the exception: it runs in bob's own account session,
never as root. The agent user is the macOS account the jarvis-class bob runs as.

```sh
AGENT_USER=<the macOS user bob runs as>   # e.g. rocky
SIDECAR_USER=jarvis-sidecar
VOICE_GROUP=jarvis-voice
REPO=<a checkout of the reviewed bob commit>
INSTALL=/usr/local/libexec/bob/reachy-voice
PIPER_DIR=/usr/local/libexec/bob/piper
STATE=/usr/local/var/bob/reachy-voice
PYTHON=/usr/bin/python3   # PINNED: Apple's system python3, always run -I
```

The interpreter is pinned to `/usr/bin/python3`, run with `-I` (ignores `PYTHON*`
variables; no user site or script directory on `sys.path`); no Homebrew or
user-installed Python. On macOS it is the Command Line Tools shim: install them
(`xcode-select --install`) and select them (`xcode-select -p` must print
`/Library/Developer/CommandLineTools`; an Xcode.app under `/Applications` fails
[P7], since `/Applications` is admin-group-writable). The fixed derivation in
`launch.py` resolves the interpreter and path parameters
with a fixed environment. [P7] checks the installed plist against that derivation,
and verifies the interpreter, import trees and deployed plist's full path chains.

## 1. Create the sidecar user and the socket group

A hidden service account with no login shell or password, a non-writable home
at `/var/empty`, and a group whose members may connect to the sidecar's socket.

```sh
SIDECAR_UID=$(dscl . -list /Users UniqueID | awk '$2>=400 && $2<500 {print $2}' | sort -n | tail -1)
SIDECAR_UID=$(( ${SIDECAR_UID:-400} + 1 ))
sudo dscl . -create /Users/$SIDECAR_USER
sudo dscl . -create /Users/$SIDECAR_USER UniqueID $SIDECAR_UID
sudo dscl . -create /Users/$SIDECAR_USER PrimaryGroupID 20
sudo dscl . -create /Users/$SIDECAR_USER UserShell /usr/bin/false
sudo dscl . -create /Users/$SIDECAR_USER NFSHomeDirectory /var/empty
sudo dscl . -create /Users/$SIDECAR_USER RealName "jarvis sidecar"
sudo dscl . -create /Users/$SIDECAR_USER Password '*'
sudo dscl . -create /Users/$SIDECAR_USER IsHidden 1
sudo dseditgroup -o create -r "jarvis voice socket" $VOICE_GROUP
sudo dseditgroup -o edit -a $SIDECAR_USER -t user $VOICE_GROUP
sudo dseditgroup -o edit -a $AGENT_USER -t user $VOICE_GROUP
id $SIDECAR_USER            # check: the uid, and the jarvis-voice group
```

## 2. The constrained `sudo -n` proof path

Required release-host isolation proofs run the installed `proof.py` as another user
under the pinned interpreter (step 3 installs it root-owned). Nothing it runs
as that user is unconfined and caller-chosen: `open` reports whether a path
OPENS (it never reads), `connect` reports whether a socket accepts (and sends
nothing), `probe` runs the installed egress probe ONLY under the installed
profile with every spec field checked against a fixed whitelist (the one
executable is `/usr/bin/true`); `probe`/`sidecar` paths are checked for a
`/private/tmp/rv-` resolved prefix before launch, without pinning ancestors.
The unconfined controls run as bob's
own user, without sudo. No other command, and never root:

```sh
sudo tee /etc/sudoers.d/bob-reachy-voice-proofs >/dev/null <<EOF
# bob#356 V1 isolation proofs: $AGENT_USER may run ONLY the installed proof command.
$AGENT_USER ALL=($SIDECAR_USER) NOPASSWD: $PYTHON -I $INSTALL/proof.py *
$AGENT_USER ALL=(nobody) NOPASSWD: $PYTHON -I $INSTALL/proof.py connect *
EOF
sudo chmod 0440 /etc/sudoers.d/bob-reachy-voice-proofs
sudo visudo -cf /etc/sudoers.d/bob-reachy-voice-proofs
sudo -u $AGENT_USER sudo -n -u $SIDECAR_USER $PYTHON -I $INSTALL/proof.py open /dev/null
```

Add no `env_keep` for this rule: sudo's default `env_reset` is what keeps a
caller's `DEVELOPER_DIR` from steering the shim ([P7] checks that it does not).

The `nobody` line is the OUTSIDER: the proof shows a user outside
`jarvis-voice` cannot connect to the socket ([P4] on a scratch socket with the
deployed mode and group, [P8] on the deployed one).

**Re-review this rule before V2 grants `jarvis-sidecar` the microphone.** The
`sidecar` subcommand runs a proof's stand-in Piper and player as that user,
confined by the profile — which allows
the audio HAL; once that user holds the microphone, that is a capture path
around bob's gates.

## 3. Install the sidecar and Piper (root-owned, hash-recorded)

Once P7 establishes trusted ancestors and ACLs, the sidecar user cannot modify these files.
On a host where the launch job is already loaded, boot it out before re-running
this step and bootstrap it again with step 5.

```sh
sudo install -d -o root -g wheel -m 0755 $INSTALL $PIPER_DIR
sudo install -o root -g wheel -m 0644 $REPO/sidecar/reachy-voice/sidecar.py \
  $REPO/sidecar/reachy-voice/reachy-voice.sb $REPO/sidecar/reachy-voice/proof.py \
  $REPO/sidecar/reachy-voice/egress-probe.py $REPO/sidecar/reachy-voice/launch.py $INSTALL/
# Piper: piper-tts and its dependencies from the pinned wheel set, installed
# into a fresh $PIPER_DIR/lib.new (wheels only, no dependency resolution), plus
# the entry script the sidecar runs under its own interpreter. PIPER_INSTALL
# records the outcome; the install commands after this block run only when it
# is "ok". A failed swap attempts to move the old lib back and reports a failed
# restore; it does not delete the only copy.
sudo rm -rf "${PIPER_DIR:?}/lib.new"
PIPER_INSTALL=failed
if sudo test -e "$PIPER_DIR/lib.new" || sudo test -L "$PIPER_DIR/lib.new" ||
  sudo test -e "$PIPER_DIR/lib.old" || sudo test -L "$PIPER_DIR/lib.old"; then
  PIPER_INSTALL=swap-dir-present
elif sudo /usr/bin/python3 -I -m pip install --no-deps --only-binary=:all: --require-hashes \
  --target "$PIPER_DIR/lib.new" -r $REPO/sidecar/reachy-voice/piper-requirements.txt; then
  PIPER_INSTALL=ok
  # Absent is fine; any other inspection failure is a distinct state and stops.
  PIPER_LIB_STATE=$(sudo /usr/bin/python3 -I -c '
import os, sys
try:
    os.lstat(sys.argv[1])
except FileNotFoundError:
    print("absent")
except OSError:
    print("cannot-inspect")
else:
    print("directory" if os.path.isdir(sys.argv[1]) else "cannot-inspect")
' "$PIPER_DIR/lib") || PIPER_LIB_STATE=cannot-inspect
  if [ "$PIPER_LIB_STATE" = directory ]; then
    if ! sudo /usr/bin/python3 -I -c 'import os,sys; os.rename(sys.argv[1], sys.argv[2])' \
      "$PIPER_DIR/lib" "$PIPER_DIR/lib.old"; then
      PIPER_INSTALL=move-failed
    fi
  elif [ "$PIPER_LIB_STATE" != absent ]; then
    PIPER_INSTALL=inspect-failed
  fi
  # os.rename(2) refuses an occupied target instead of nesting a directory.
  if [ "$PIPER_INSTALL" = ok ] && ! sudo /usr/bin/python3 -I -c 'import os,sys; os.rename(sys.argv[1], sys.argv[2])' \
    "$PIPER_DIR/lib.new" "$PIPER_DIR/lib"; then
    PIPER_INSTALL=swap-failed
    if [ "$PIPER_LIB_STATE" = directory ] && sudo test -d "$PIPER_DIR/lib.old"; then
      if ! sudo /usr/bin/python3 -I -c 'import os,sys; os.rename(sys.argv[1], sys.argv[2])' \
        "$PIPER_DIR/lib.old" "$PIPER_DIR/lib"; then
        PIPER_INSTALL=restore-failed
      fi
    fi
  fi
  if [ "$PIPER_INSTALL" = ok ]; then
    sudo rm -rf "${PIPER_DIR:?}/lib.old"
  fi
fi
if [ "$PIPER_INSTALL" = ok ]; then
  sudo install -o root -g wheel -m 0644 \
    $REPO/sidecar/reachy-voice/piper-entry.py $PIPER_DIR/piper
  sudo chown -R root:wheel $PIPER_DIR && sudo chmod -R go-w $PIPER_DIR
  sudo cp <voice>.onnx $PIPER_DIR/voice.onnx
  sudo cp <voice>.onnx.json $PIPER_DIR/voice.onnx.json
  sudo chown root:wheel $PIPER_DIR/voice.onnx* && sudo chmod 0644 $PIPER_DIR/voice.onnx*
fi
if [ "$PIPER_INSTALL" = swap-dir-present ]; then
  echo "reachy-voice: $PIPER_DIR/lib.new or $PIPER_DIR/lib.old exists after the cleanup step; refusing to start the swap. Remove or inspect it and rerun this step." >&2
elif [ "$PIPER_INSTALL" = restore-failed ]; then
  echo "reachy-voice: the swap failed and the previous $PIPER_DIR/lib could not be moved back from $PIPER_DIR/lib.old (PIPER_INSTALL=restore-failed). $PIPER_DIR/lib may be missing. Stop here: inspect both directories and move the good one to $PIPER_DIR/lib by hand before rerunning this step; the entry install did not run." >&2
elif [ "$PIPER_INSTALL" != ok ]; then
  echo "reachy-voice: the Piper install did not complete ($PIPER_INSTALL). Stop here and rerun this step; the entry install did not run." >&2
fi
shasum -a 256 $INSTALL/* $PIPER_DIR/piper $PIPER_DIR/voice.onnx
```

Record those hashes in the host's install log. The release check (step 8)
verifies the installed `sidecar.py`, `reachy-voice.sb`, `proof.py`,
`egress-probe.py` and `launch.py` are byte-identical to the reviewed checkout
and root-owned, and that `$PIPER_DIR/piper` is byte-identical to
`sidecar/reachy-voice/piper-entry.py` and root-owned. Under `$PIPER_DIR/lib` it
parses every `<name>-<version>.dist-info`, requires its METADATA `Name` and
`Version` to match the directory name and the pin in `piper-requirements.txt`,
requires the pinned set and no other distribution, and compares each hashed
`RECORD` entry that resolves inside `lib` with its file. A hashless `RECORD`
line is accepted only for the distribution's own `RECORD` and for a `.pyc` under
`__pycache__` that pip recompiled at install (its bytes can differ from the
wheel's copy, so a path listed both ways is not compared). A file `RECORD` does
not list is not enumerated. `--piper-model-sha256`
is the voice model's: the sidecar refuses to start when the model differs, and
when `--work-dir` is not an absolute path.

## 4. State directories

The sidecar's speech files go in the work directory: each is 0600, removed
after playback, and any it left behind (named `tts-*`) is removed at startup —
or the sidecar refuses to start. The sidecar enforces nothing about other
files there; keep the directory to the sidecar user. The socket directory
lets the `jarvis-voice` group reach the socket.

```sh
sudo install -d -o root -g wheel -m 0755 $STATE
sudo install -d -o $SIDECAR_USER -g staff -m 0700 $STATE/work
sudo install -d -o $SIDECAR_USER -g $VOICE_GROUP -m 0750 $STATE/run
sudo install -d -o $SIDECAR_USER -g staff -m 0700 $STATE/log
# The deployment record: bob's account, root-owned. The release check (step 8)
# binds to the account this names, never to one its caller names.
printf '%s\n' "$AGENT_USER" | sudo tee $STATE/agent-user >/dev/null
sudo chown root:wheel $STATE/agent-user && sudo chmod 0644 $STATE/agent-user
```

The record is trusted only while it and every directory above it
(`$STATE`, `/usr/local/var/bob`, `/usr/local/var`, `/usr/local`, `/usr`, `/`) are
root-owned, not group- or other-writable, and without write-granting ACLs; on a host where any is not (for
example an Intel Homebrew `/usr/local/var`), step 8 fails until it is.

## 5. The launch job

A LaunchDaemon running the sidecar as `jarvis-sidecar`, under the profile, with
real paths for the profile parameters and sidecar arguments.

```sh
/usr/bin/env -i DEVELOPER_DIR=/Library/Developer/CommandLineTools /usr/bin/python3 -I \
  /usr/local/libexec/bob/reachy-voice/launch.py | \
  /usr/bin/plutil -convert xml1 -o - - | \
  sudo tee /Library/LaunchDaemons/dev.tps.reachy-voice.plist >/dev/null
sudo chmod 0644 /Library/LaunchDaemons/dev.tps.reachy-voice.plist
sudo plutil -lint /Library/LaunchDaemons/dev.tps.reachy-voice.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.tps.reachy-voice.plist
```

The mute bob sees is the **sidecar-reported mute**. V1's sidecar does not read
the speakerphone's hardware switch: `--device-mute absent` is the operator's
statement that no capture device is read in V1, and the sidecar then reports
`muted: false`. Without it the sidecar reports `muted: true` (unknown is muted)
and bob refuses every `say`. V2 replaces this with the HID mute reader; a
software-only mute does not qualify.

The sidecar fails closed on its speech files: it refuses to start while a stale
one cannot be removed. After a playback cleanup failure, dirty state refuses
later speech until a clean restart. It attempts an immediate `ok: false` health
update on a live connection; a broken socket makes it fail. Its log names a
digest of each playback id, never the id itself.

The log is content-free (including event names, playback-id digests, error classes — never the
spoken text). Core dumps are disabled in the process.

## 6. The agent's bob.yaml

```yaml
capabilities:
  - reachy

voice:
  wakeName: jarvis          # bob-owned; pushed to the sidecar (V1 has no ears)

reachy:
  socket: /usr/local/var/bob/reachy-voice/run/voice.sock
  sidecarVersion: 0.1.0     # must equal the sidecar's reported version
  profile: voice            # the default; `reachy` adds the body tools
  roomSpeechOrigins: [discord:<channel id>, cron:<job name>]
```

`roomSpeechOrigins` names the authenticated turns whose `reachy_say` may speak
in the room: `run` (an operator's one-shot `bob run`), `cron:<job>`,
`discord:<channelId>`. Mail speech is V2; V1 mail has no bound origin.
Empty means bob speaks for nothing. A call bound to no admitted turn (a persistent prompt outside admission, a mail
turn) never speaks. No shipped role allows `reachy_say` yet; a role that does
is a separate, reviewed change — and the socket's group (above) can still make
the sidecar speak directly, without bob.

## 7. TCC and the launcher (record; V1 needs no grant)

V1 only plays audio, which needs no privacy (TCC) grant. List and hash candidate
binaries for V2's microphone grant:

```sh
ls -l /usr/bin/sandbox-exec "$PYTHON"
shasum -a 256 /usr/bin/sandbox-exec "$PYTHON"
```

macOS refuses to prompt for a platform binary (`/usr/bin/sandbox-exec` is one),
and a grant to an interpreter covers every script it runs. So V2's capture needs
its own launcher binary — the `voice-launcher` that holds the GUI-session grant
on rocky today — installed root-owned under `/usr/local/libexec/bob/` with its
path and sha256 recorded here, and any capture-helper redesign goes back to
review.

**The measurement V1 owes V2** (rev 2.1, strongest objection): TCC attribution
and whether the separate `jarvis-sidecar` user can obtain a microphone grant at all, since it
has no desktop session. Measure it with the speakerphone attached and Nathan at
the screen; if it cannot, V2 is blocked until a reviewed capture design exists.

Also measure, from the running LaunchDaemon: that one `say` plays on the
speakerphone (the job's default output device), not another output.

## 8. The release-host check (manual prerequisite)

Scratch cleanup runs as bob (`rmSync(base, { recursive: true, force: true })`),
without sudo. P4 grants bob inherited cleanup ACLs on its scratch directory;
bob's OS permissions still apply outside scratch.

No CI workflow runs this (CI is Linux; the seatbelt proofs are macOS-only). Run
it on this host, from the reviewed checkout, before the sidecar ships, in bob's
account session ($AGENT_USER logged in, with its own HOME; never as root and
never from the admin shell). **Stop bob's reachy capability first**: [P9] speaks
to the sidecar, which serves one connection at a time, and a link that is still
up consumes the answer. The admin shell's variables do not carry over: set
`REPO` again in this session. The interpreter is pinned to `/usr/bin/python3 -I`,
as in step 2's sudoers rule. Name the agent — the account comes from the deployment record (step 4), and the
credential files are derived from the agent's own `bob.yaml`:

```sh
# in bob's own session ($AGENT_USER), not the admin shell
REPO=<the reviewed bob checkout, readable by this account>
cd "$REPO"
BOB_ISOLATION_AGENT=<the agent's name> \
bun run check:reachy-isolation
```

It runs `test/capabilities/reachy/isolation.test.ts` with
`BOB_REQUIRE_ISOLATION_PROOFS=1`, with a minimal environment: PATH is pinned
(`/usr/bin:/bin:/usr/sbin:/sbin`; wherever a proof calls `sudo`, `id` or
`sandbox-exec`, it calls it by absolute path), and HOME is bob's home as the OS account
database records it (`id -P`), never the inherited one. It refuses to start
as root, when the inherited HOME differs from the running account's home, or
when `BOB_REACHY_VOICE_DIR` or `BOB_ISOLATION_AGENTS_ROOT` is set. Every proof
that reads bob's tree FAILS unless the deployment record (step 4) is trusted,
names a non-root account, and that account is the one running (same uid in the
account database); the agents root is `<that account's home>/agents`. It requires all nine pinned proofs to pass:
[P1]/[P3] deny-default confinement, as this user and as `jarvis-sidecar`: the
probed operations are each denied — TCP (IPv4, IPv6), UDP, mDNS and
other-UNIX-socket connects, a forked child's TCP connect, an exec of
`/usr/bin/true`, the probed mach service lookups, and a file read and a write
outside the sidecar's directories (the profile allows fork and its named exec
paths, so a child is not itself denied; its network call is) — each probed denial shown
to succeed unconfined first — as THIS user, since the sudo rule allows no
unconfined probe; [P2]/[P4] the real sidecar's handshake and `say` over the
authorized socket with no speech artifact left in the work directory — [P4] as `jarvis-sidecar` on a SCRATCH
socket with the deployed mode and group (0660, `jarvis-voice`), with an
outsider refused; [P5] #180 S1's key-read proof
on fixtures; [P6] the same on bob's active credentials: every key or token
file the agent's `bob.yaml` names must be an ABSOLUTE path (or `~/`; a relative
one fails the proof, since the capability opens it against its own working
directory) and must EXIST, as must bob's admin-password path (a missing one
fails the proof), and those plus whichever provider stores exist
are each a regular file, 0600, owned by the agent, and refused to the sidecar user — this
process only `stat`s them, and the sidecar user's attempt only opens; [P7] the
installed files at the pinned install root match the checkout; [P8] the
DEPLOYED socket at `/usr/local/var/bob/reachy-voice/run/voice.sock` is 0660
`jarvis-sidecar:jarvis-voice` in a 0750 directory of that owner and group, and
an outsider's connect is refused; [P9] the socket the agent's `bob.yaml` names
(`reachy.socket`) completes the `reachy-voice/1` handshake, its first line judged
by bob's own handshake rules, as bob's own account — it fails by name when
nothing accepts the connect, when no line arrives within the limit, or when the
reply is one bob refuses. **A proof that is skipped, fails or is
missing fails the check.**
