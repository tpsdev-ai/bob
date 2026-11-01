- **An empty model response is re-issued, bounded, instead of ending the run
  mid-task.** A provider that answers a request with no content blocks and zero
  output tokens used to end the run silently: such a turn carries no tool call,
  so pi treats it as the agent being finished, and it carries no thinking, so
  bob#256's reasoning-only re-prompt never sees it. bob now re-issues the same
  request (the same context, with no message added) up to three times; still
  empty, the run ends with the named `empty_response` failure, whose outcome
  record names the provider, the model and the retries, and the run exits 1.
