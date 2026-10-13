- **Voice V1, the mouth: a `voice` profile, the versioned `reachy-voice/1` handshake, room speech by caller, and a confined local-TTS sidecar (#356).** The `reachy`
  capability takes a bob-owned `profile` (`voice`, the default, registers only
  `reachy_say` and `reachy_state`; `reachy` adds `reachy_look` and
  `reachy_frame`; any other value is refused when `bob.yaml` loads), and an
  allowlist naming a tool the configured profile does not register is refused by
  name before any session; under `voice`, body proposals refuse and a `presence`
  line is a content-free `reachy.malformed`. The wake name comes only from the
  agent's `voice.wakeName` (default `jarvis`); a `reachy:` block that sets one is
  refused. Every sidecar connection starts with bob's `configure` (protocol,
  profile, wake name, a fresh generation) and a strict health line that must
  repeat them and carry the exact pinned `sidecarVersion`, with the sidecar's
  wake mode (`off`: no ears in V1), trained phrase, model hash, device mute and
  status; until then only control/status traffic moves, and a mismatch, a
  legacy health line or any other line disconnects with one bounded
  `reachy.link.refused` alarm, retried on a doubling backoff with a fresh
  handshake each time. `reachy_say` from an authenticated turn speaks without a
  transcript only when `reachy.roomSpeechOrigins` grants that exact origin
  (`run`, `cron:<job>`, `discord:<channelId>`, `mail:<sender>`; empty by
  default); a voice-origin call, an ungranted turn and every sidecar proposal
  are refused, and a room transcript authorizes no speech. All speech needs a
  ready, unmuted link (bob mute, the device mute or no link all mute it), one
  line of at most 500 characters with no memory reference, and a successful
  audit before the send, re-checked after it. The `voice` turn origin is in the
  origin union, its validation, projection and label, and is not admitted
  until V2. The new sidecar (`sidecar/reachy-voice/`) speaks with local Piper
  through an ephemeral 0600 file in a 0700 directory, removed after playback,
  under a deny-default seatbelt profile as its own `jarvis-sidecar` user, with a
  runbook of the one-time admin steps; `bun run check:reachy-isolation` fails
  the release on any skipped isolation proof. Refs #356.
  (`test/capabilities/reachy/voice-v1.test.ts`,
  `test/capabilities/reachy/isolation.test.ts`,
  `test/capabilities/reachy/voice-sidecar.test.ts`,
  `test/shell/voice-origin-356.test.ts`)
