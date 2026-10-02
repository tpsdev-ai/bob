- **`apply_patch` checks candidate storage identities.** It checks the candidate
  and staging directories and the written source before rename, then checks the
  published file against the written descriptor. Storage failures refuse and
  attempt cleanup.
