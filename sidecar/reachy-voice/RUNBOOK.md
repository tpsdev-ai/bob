# reachy-voice sidecar — operator runbook (bob#356 V1, "mouth")

The voice sidecar speaks for a jarvis-class agent through a USB speakerphone. In
V1 it only **speaks**: it has no microphone code, no wake model and no
speech-to-text, and it reports wake mode `off`. It is untrusted (bob#180 §3.2):
it runs as its own unprivileged macOS user, under the deny-default seatbelt
profile `reachy-voice.sb`, and talks to bob only through one UNIX socket. bob
applies its own policy and writes its audit record before any `say` reaches it.

Everything below needs an administrator **once**, at the host. bob never creates
users, edits sudoers or loads launchd jobs.

Files in this directory:

| File | What it is |
| --- | --- |
| `sidecar.py` | The sidecar (Python 3.9+, standard library only). Reports version `0.1.0`. |
| `reachy-voice.sb` | The deny-default seatbelt profile it runs under. |
| `RUNBOOK.md` | This file. |

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

The isolation proofs run two commands **as the sidecar user**: `cat` (the key-read
proof) and `sandbox-exec` (the sidecar and its egress probes under the profile).
This rule lets the agent user run exactly those two, as `jarvis-sidecar` only —
never as root — without a password.

```sh
sudo tee /etc/sudoers.d/bob-reachy-voice-proofs >/dev/null <<EOF
# bob#356 V1 isolation proofs: $AGENT_USER may run ONLY these, ONLY as $SIDECAR_USER.
$AGENT_USER ALL=($SIDECAR_USER) NOPASSWD: /usr/bin/sandbox-exec, /bin/cat
EOF
sudo chmod 0440 /etc/sudoers.d/bob-reachy-voice-proofs
sudo visudo -cf /etc/sudoers.d/bob-reachy-voice-proofs
sudo -u $AGENT_USER sudo -n -u $SIDECAR_USER /bin/cat /dev/null && echo "proof path OK"
```

**Remove this rule before V2 grants the sidecar user the microphone.**
`sandbox-exec` as `jarvis-sidecar` is arbitrary code as that user, which is
harmless while the user holds nothing, and is a way around bob's gates once it
holds the microphone. V2 replaces it with fixed-argument proof commands.

## 3. Install the sidecar and Piper (root-owned, hash-recorded)

The sidecar user can read and run these but never modify them.

```sh
sudo install -d -o root -g wheel -m 0755 $INSTALL $PIPER_DIR
sudo install -o root -g wheel -m 0644 $REPO/sidecar/reachy-voice/sidecar.py $REPO/sidecar/reachy-voice/reachy-voice.sb $INSTALL/
# Piper: the build and voice measured in rocky:~/voice-prep (hash-listed there).
sudo cp -R <piper build dir>/. $PIPER_DIR/
sudo chown -R root:wheel $PIPER_DIR && sudo chmod -R go-w $PIPER_DIR
shasum -a 256 $INSTALL/sidecar.py $INSTALL/reachy-voice.sb $PIPER_DIR/piper <voice>.onnx
```

Record those four hashes in the host's install log. `--piper-model-sha256` below
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

`--device-mute absent` is the operator's statement that **no capture device is
read in V1**: the sidecar then reports `muted: false`. Without it the sidecar
cannot read the speakerphone's hardware mute and reports `muted: true`, and bob
refuses every `say` (unknown is muted). V2 replaces this with the HID mute
reader; a software-only mute does not qualify.

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
in the room: `run` (an operator's run), `cron:<job>`, `discord:<channelId>`,
`mail:<sender>`. Empty means nothing speaks. No shipped role allows
`reachy_say` yet; a role that does is a separate, reviewed change.

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

## 8. The release check

Run on this host, from the reviewed checkout, before the sidecar ships:

```sh
cd $REPO
BOB_ISOLATION_ADMIN_PASS=/Users/$AGENT_USER/.flair/admin-pass \
BOB_ISOLATION_AGENT_KEY=<the agent's Flair key path> \
bun run check:reachy-isolation
```

It runs `test/capabilities/reachy/isolation.test.ts` with
`BOB_REQUIRE_ISOLATION_PROOFS=1`: the deny-default confinement proofs (network,
child, exec, service and file egress denied, each shown to succeed unconfined
first; the real sidecar's handshake and `say` over the authorized socket; no
audio left behind) as this user and as `jarvis-sidecar`, and #180 S1's key-read
proof on fixtures and on the two real files (0600, owned by the agent, and
refused to the sidecar user — the test only `stat`s them; the read attempt runs
as the sidecar user with its output discarded). **A proof that cannot run fails
the check; a skipped proof never passes a release.**
