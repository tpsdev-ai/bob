- **Lockfile release-age enforcement in the Dependency Audit job.** A frozen
  install resolves nothing, so `bunfig.toml`'s `minimumReleaseAge` did not
  apply to the committed pins. A node script now reads the package versions in
  `bun.lock`, reads the bake and `minimumReleaseAgeExcludes` from `bunfig.toml`,
  and fails on a version younger than the bake or a registry lookup it cannot
  complete. It runs as a step in the existing Dependency Audit job.
