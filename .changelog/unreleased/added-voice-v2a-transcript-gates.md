- **bob submits sidecar transcripts for admission through the voice gates.**
  Under the `voice` profile, an addressed transcript that passes the echo guard
  is submitted for admission as a voice-origin turn. A voice turn that starts
  runs in a fresh, in-memory session without the resident history, the Flair
  bootstrap or prior-round memory; its one tool is `reachy_say`, which the
  agent's own tool policy must allow. A voice transcript is not eligible for a
  memory write (speaker authentication is V3). A malformed, muted or
  un-addressed transcript, or one that matches the echo guard, is dropped
  before admission.
