- **An empty model response is re-issued, bounded.** When no block-start event
  occurred and the attempt ends with no content blocks, zero output tokens, and
  neither an error nor an abort, bob re-issues the same request up to three
  times; still empty, the request ends with an error naming the provider and
  the model.
  A one-shot run then fails as `empty_response` and exits 1; when run logging is
  enabled and succeeds, its outcome record names the provider, the model and the
  retries. An admitted persistent turn rejects as a failed turn.
