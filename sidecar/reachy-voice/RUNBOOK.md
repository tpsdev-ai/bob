# reachy-voice sidecar — operator runbook (bob#356 V1, "mouth")

The voice sidecar speaks for a jarvis-class agent through a USB speakerphone. In
V1 it only **speaks**: it has no microphone code, no wake model and no
speech-to-text, and it reports wake mode `off`. It is untrusted (bob#180 §3.2):
it runs as its own unprivileged macOS user, under the deny-default seatbelt
profile `reachy-voice.sb`, and listens on one UNIX socket. For every `say` bob
SENDS, bob applies its policy and writes its audit record first; a process that
reaches the socket directly bypasses both (see "What bob's audit covers").

Everything below needs an administrator **once**, at the host. bob never creates
users, edits sudoers or loads launchd jobs.

Files in this directory:

| File | What it is |
| --- | --- |
| `sidecar.py` | The sidecar (Python 3.9+, standard library only). Reports version `0.1.0`. |
| `reachy-voice.sb` | The deny-default seatbelt profile it runs under. |
| `proof.py` | The ONE command the isolation proofs run as another user (step 2). |
| `egress-probe.py` | The egress probe `proof.py` runs, confined and unconfined. |
| `RUNBOOK.md` | This file. |

**What bob's audit covers.** bob audits every `say` it sends. The socket below
is 0660, owner `jarvis-sidecar`, group `jarvis-voice`: any process with access
to it — bob's own OS user, or another member of that group — can make the
sidecar speak without bob's policy or audit. Keep that group to bob's user.

## 0. Set the names once

Run every block below in one admin shell (`zsh`) after setting these. The agent
user is the macOS account the jarvis-class bob runs as.

```sh
AGENT_USER=<the macOS user bob runs as>   # e.g. rocky
SIDECAR_USER=jarvis-sidecar
VOICE_GROUP=jarvis-voice
REPO=<a checkout of the reviewed bob commit>
INSTALL=/usr/local/libexec/bob/reachy-voice
PIPER_DIR=/usr/local/libexec/bob/piper
STATE=/usr/local/var/bob/reachy-voice
PYTHON=$(python3 -c 'import os,sys;print(os.path.realpath(sys.executable))')
PYTHON_PREFIX=$(python3 -c 'import os,sys;e=os.path.realpath(sys.executable);print(os.path.commonpath([e,os.path.realpath(sys.base_prefix)]))')
```

## 1. Create the sidecar user and the socket group

A hidden service account with no login shell, no home and no password, and a
group whose members may connect to the sidecar's socket.

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

The isolation proofs run ONE command as another user: the installed `proof.py`
under the pinned interpreter (step 3 installs it root-owned). Its subcommands
are bounded — `open` reports whether a path OPENS (it never reads), `connect`
reports whether a socket accepts, and `probe`/`sidecar`/`clean` act only on a
proof's scratch layout under `/private/tmp/rv-`, with the installed profile and
sidecar. No other command, and never root:

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

The `nobody` line is the OUTSIDER: the proof shows a user outside
`jarvis-voice` cannot connect to the deployed socket.

**Re-review this rule before V2 grants `jarvis-sidecar` the microphone.** The
`probe` and `sidecar` subcommands run a proof's stand-in programs as that user
(confined by the profile); once that user holds the microphone, that is a
capture path around bob's gates.

## 3. Install the sidecar and Piper (root-owned, hash-recorded)

The sidecar user can read and run these but never modify them.

```sh
sudo install -d -o root -g wheel -m 0755 $INSTALL $PIPER_DIR
sudo install -o root -g wheel -m 0644 $REPO/sidecar/reachy-voice/sidecar.py \
  $REPO/sidecar/reachy-voice/reachy-voice.sb $REPO/sidecar/reachy-voice/proof.py \
  $REPO/sidecar/reachy-voice/egress-probe.py $INSTALL/
# Piper: the build and voice measured in rocky:~/voice-prep (hash-listed there).
sudo cp -R <piper build dir>/. $PIPER_DIR/
sudo chown -R root:wheel $PIPER_DIR && sudo chmod -R go-w $PIPER_DIR
shasum -a 256 $INSTALL/* $PIPER_DIR/piper <voice>.onnx
```

Record those hashes in the host's install log. The release check (step 8)
verifies the installed `sidecar.py`, `reachy-voice.sb`, `proof.py` and
`egress-probe.py` are byte-identical to the reviewed checkout and root-owned. `--piper-model-sha256` below
is the voice model's: the sidecar refuses to start when the model differs.

## 4. State directories

The work directory holds only ephemeral 0600 speech files while they play; the
socket directory lets the `jarvis-voice` group reach the socket.

```sh
sudo install -d -o root -g wheel -m 0755 $STATE
sudo install -d -o $SIDECAR_USER -g staff -m 0700 $STATE/work
sudo install -d -o $SIDECAR_USER -g $VOICE_GROUP -m 0750 $STATE/run
sudo install -d -o $SIDECAR_USER -g staff -m 0700 $STATE/log
```

## 5. The launch job

A LaunchDaemon running the sidecar as `jarvis-sidecar`, under the profile, with
every path resolved (seatbelt matches real paths: `/tmp` is `/private/tmp`).

```sh
MODEL=$PIPER_DIR/<voice>.onnx
MODEL_SHA=$(shasum -a 256 $MODEL | cut -d' ' -f1)
sudo tee /Library/LaunchDaemons/dev.tps.reachy-voice.plist >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.tps.reachy-voice</string>
  <key>UserName</key><string>$SIDECAR_USER</string>
  <key>GroupName</key><string>$VOICE_GROUP</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/sandbox-exec</string>
    <string>-f</string><string>$INSTALL/reachy-voice.sb</string>
    <string>-D</string><string>PYTHON_PREFIX=$PYTHON_PREFIX</string>
    <string>-D</string><string>SIDECAR_DIR=$INSTALL</string>
    <string>-D</string><string>TTS_DIR=$PIPER_DIR</string>
    <string>-D</string><string>PLAYER=/usr/bin/afplay</string>
    <string>-D</string><string>WORK_DIR=$STATE/work</string>
    <string>-D</string><string>SOCKET=$STATE/run/voice.sock</string>
    <string>$PYTHON</string><string>-I</string><string>$INSTALL/sidecar.py</string>
    <string>--socket</string><string>$STATE/run/voice.sock</string>
    <string>--work-dir</string><string>$STATE/work</string>
    <string>--piper</string><string>$PIPER_DIR/piper</string>
    <string>--piper-model</string><string>$MODEL</string>
    <string>--piper-model-sha256</string><string>$MODEL_SHA</string>
    <string>--player</string><string>/usr/bin/afplay</string>
    <string>--device-mute</string><string>absent</string>
    <string>--socket-mode</string><string>0660</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$STATE/log/sidecar.log</string>
</dict></plist>
EOF
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
one cannot be removed, and after a removal fails it stops speaking and reports
`ok: false` (bob refuses the link and raises one alarm) until it is restarted
cleanly. Its log names a digest of each playback id, never the id itself.

The log is content-free (event names, playback ids, error classes — never the
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
`discord:<channelId>`, `mail:<sender>`. Empty means bob speaks for nothing. A
call bound to no admitted turn (a persistent prompt outside admission, a mail
turn) never speaks. No shipped role allows `reachy_say` yet; a role that does
is a separate, reviewed change — and the socket's group (above) can still make
the sidecar speak directly, without bob.

## 7. TCC and the launcher (record; V1 needs no grant)

V1 only plays audio, which needs no privacy (TCC) grant. Record the responsible
binary of the launch job now, for V2's microphone grant:

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

**The measurement V1 owes V2** (rev 2.1, strongest objection): whether the
separate `jarvis-sidecar` user can obtain a microphone grant at all, since it
has no desktop session. Measure it with the speakerphone attached and Nathan at
the screen; if it cannot, V2 is blocked until a reviewed capture design exists.

Also measure, from the running LaunchDaemon: that one `say` plays on the
speakerphone (the job's default output device), not another output.

## 8. The release-host check (manual prerequisite)

No CI workflow runs this (CI is Linux; the seatbelt proofs are macOS-only). Run
it on this host, from the reviewed checkout, before the sidecar ships. Name the
AGENT only — the credential files are derived from its own `bob.yaml`:

```sh
cd $REPO
BOB_ISOLATION_AGENT=<the agent's name> \
BOB_REACHY_VOICE_PYTHON=$PYTHON \
bun run check:reachy-isolation
```

It runs `test/capabilities/reachy/isolation.test.ts` with
`BOB_REQUIRE_ISOLATION_PROOFS=1` and requires all seven pinned proofs to pass:
[P1]/[P3] deny-default confinement (network, child, exec, service and file
egress denied, each probed denial shown to succeed unconfined first) as this
user and as `jarvis-sidecar`; [P2]/[P4] the real sidecar's handshake and `say`
over the authorized socket with no audio left — [P4] on the DEPLOYED 0660
`jarvis-voice` socket, with an outsider refused; [P5] #180 S1's key-read proof
on fixtures; [P6] the same on bob's active credentials (the provider stores
and every key file the agent's `bob.yaml` names, plus bob's admin-password
path): each 0600, owned by the agent, and refused to the sidecar user — this
process only `stat`s them, and the sidecar user's attempt only opens; [P7] the
installed files match the checkout. **A proof that is skipped, fails or is
missing fails the check.**
