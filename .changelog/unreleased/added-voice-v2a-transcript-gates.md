- **bob submits sidecar transcripts for admission through the voice gates.**
  Under the `voice` profile, an eligible addressed transcript from the sidecar
  is submitted for admission as a voice-origin turn. An admitted one runs in a
  fresh, in-memory session without the resident history, the Flair bootstrap or
  prior-round memory, and may speak only through `reachy_say`, and only when the
  agent's own tool policy allows that tool. Until speaker authentication exists
  (V3), a voice transcript is never eligible for a memory write, even when the
  sidecar-supplied speakerId matches bob's enrolment. A malformed, muted or
  un-addressed transcript, or one the echo guard matches to bob's recent speech,
  is dropped before admission.
