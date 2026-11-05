- **Lockfile release-age enforcement in CI.** A frozen
  install resolves nothing, so `bunfig.toml`'s `minimumReleaseAge` did not
  apply to the committed pins. A Bun script now reads the package versions in
  `bun.lock`, reads the bake and `minimumReleaseAgeExcludes` from `bunfig.toml`,
  and fails on each checked registry version younger than the bake or a registry
  lookup it cannot complete. The checker is the first run step of every
  workflow job that runs commands, except the release workflow's ancestry guard
  job, which runs no repository script; an `actions/cache` step whose path
  contains `.bun` or `.npm`, and a `uses:` step with an input named `cache` or
  `install`, may not precede it.
  `minimumReleaseAgeExcludes` is honoured as written.
