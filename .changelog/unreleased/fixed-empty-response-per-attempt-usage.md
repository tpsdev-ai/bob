- **Each empty-response attempt's usage is recorded.** Each attempt the
  empty-response wrapper drops is reported to the run log as its own
  `requestUsage` record when run logging is enabled and succeeds, and an
  exhausted request's error carries the provider's usage for its final attempt.
