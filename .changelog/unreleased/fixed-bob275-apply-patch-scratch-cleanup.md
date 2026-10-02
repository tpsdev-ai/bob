- **`apply_patch` checks scratch cleanup before storing a candidate.** Removal
  failure returns `storage_failed` with the scratch path and cleanup detail.
