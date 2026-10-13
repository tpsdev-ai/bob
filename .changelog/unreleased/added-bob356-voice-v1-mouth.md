- **Voice V1, the mouth: a `voice` profile, the versioned `reachy-voice/1` handshake, room speech by bound caller, and a confined local-TTS sidecar (#356).** The `reachy`
  capability takes a bob-owned `profile` (`voice`, the default, registers only
  `reachy_say` and `reachy_state`; `reachy` adds `reachy_look` and
  `reachy_frame`; any other value is refused when `bob.yaml` loads), and an
  allowlist naming a tool the configured profile does not register is refused by
  name before any session; under `voice`, body proposals refuse and a `presence`
  line is a content-free `reachy.malformed`. The wake name comes only from the
  agent's `voice.wakeName` (default `jarvis`); a `reachy:` block that sets one is
  refused. Every sidecar connection starts with bob's `configure` (protocol,
  profile, wake name, a fresh generation), and nothing is judged until that
  write succeeded; the sidecar's strict health line must repeat them, carry the
  exact pinned `sidecarVersion`, and report its wake mode with a consistent
  trained-artifact pair (`off`: none; `gate-only`: none for this name;
  `trained`: this name's), its mute and its status. Until then only
  control/status traffic moves, and a mismatch, a legacy health line or any
  other line disconnects with one bounded `reachy.link.refused` alarm, retried
  on a doubling backoff with a fresh handshake each time; the link is released
  when pi shuts the session down. `reachy_say` speaks without a transcript only
  for the origin the runtime binds the call to — the admitted turn it runs in,
  or the `run` an operator's one-shot `bob run` declares — and only when
  `reachy.roomSpeechOrigins` grants that exact origin (`run`, `cron:<job>`,
  `discord:<channelId>`, `mail:<sender>`; empty by default); a call bound to
  nothing, a voice-origin call, an ungranted turn and every sidecar proposal are
  refused, and a room transcript authorizes no speech. All speech bob sends
  needs a ready, unmuted link (bob mute, the sidecar-reported mute — V1 does not
  read the hardware switch — or no link all mute it), one line of at most 500
  characters with no memory reference, and a successful audit before the send,
  re-checked after it (a reconnect or any mute transition refuses it); a failed
  socket write is a refusal. bob audits what it sends: a process with access to
  the sidecar's 0660 `jarvis-voice` socket can make it speak without bob. The
  `voice` turn origin is in the origin union, its validation, projection and
  label, and is not admitted until V2. The new sidecar (`sidecar/reachy-voice/`)
  speaks with local Piper through an ephemeral 0600 file in a 0700 directory
  that it removes after playback (a failed removal leaves it on disk and the
  sidecar fails closed), under a deny-default seatbelt profile as its own
  `jarvis-sidecar` user; it refuses to start when a stale speech file cannot be
  removed, stops speaking and reports `ok: false` when a removal fails, and logs
  only a truncated digest of each playback id. Its runbook gives the one-time admin steps,
  including a sudoers rule that names one installed proof command, and
  `bun run check:reachy-isolation` — a manual release-host prerequisite no CI
  workflow runs — fails on any skipped, failed or missing pinned isolation
  proof, checking bob's active credentials derived from the agent's `bob.yaml`.
  Refs #356. (`test/capabilities/reachy/voice-v1.test.ts`,
  `test/capabilities/reachy/voice-session.test.ts`,
  `test/capabilities/reachy/handshake-socket.test.ts`,
  `test/capabilities/reachy/isolation.test.ts`,
  `test/capabilities/reachy/voice-sidecar.test.ts`,
  `test/capabilities/reachy/proof-tool.test.ts`,
  `test/shell/voice-origin-356.test.ts`)
