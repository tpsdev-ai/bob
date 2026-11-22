- **bob admits sidecar transcripts through the voice gates.** Under the `voice`
  profile, an addressed transcript from the sidecar becomes a voice-origin turn
  in a fresh session (no resident history, no private bootstrap context) that may
  think and speak, with no body tool and no grant tool. Until speaker
  authentication exists (V3), a voice transcript is never eligible for a memory
  write, even when the sidecar-supplied speakerId matches bob's enrolment. A
  malformed, muted, un-addressed or self-echoed transcript is dropped before
  admission.
