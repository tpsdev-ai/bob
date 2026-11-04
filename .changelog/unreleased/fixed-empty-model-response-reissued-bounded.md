- **An empty model response is re-issued, bounded, instead of ending the task
  mid-turn.** A provider that answers a request with no content blocks and zero
  output tokens ends a turn with no tool call — pi treats that as the agent
  being finished — and carries no thinking, so bob#256's reasoning-only
  re-prompt never sees it. When no block-start event occurred and the attempt
  did not end in an error or abort, bob re-issues the same request up to three
  times; still empty, the request ends with an error naming the provider and
  the model.
  A one-shot run then fails as `empty_response` and exits 1; when run logging is
  enabled and succeeds, its outcome record names the provider, the model and the
  retries. An admitted persistent turn rejects as a failed turn.
