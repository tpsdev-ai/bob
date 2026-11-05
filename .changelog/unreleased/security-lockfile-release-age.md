- **Lockfile release-age enforcement in CI.** A frozen
  install resolves nothing, so `bunfig.toml`'s `minimumReleaseAge` did not
  apply to the committed pins. A Bun script now reads the package versions in
  `bun.lock`, reads the bake and `minimumReleaseAgeExcludes` from `bunfig.toml`,
  and fails on each checked registry version younger than the bake or a registry
  lookup it cannot complete. The checker is the first `run:` step of each
  workflow job with a `run:` step, except release-publish.yml's verify-ancestry
  job. Before the first `run:` step, only `actions/checkout` (`fetch-depth`, `persist-credentials`), `oven-sh/setup-bun` (`bun-version`), `actions/setup-node` (`node-version`), and `socketdev/action` (`mode`) are allowed, with only those inputs.
  `minimumReleaseAgeExcludes` filters entries by exact package name before registry lookup. The checker step allows only the keys `name` and `run`. The `verify-ancestry` job allows only `name`, `runs-on`, `permissions`, and `steps`. Every job that needs `verify-ancestry` directly or transitively allows only `name`, `needs`, `runs-on`, `environment`, `if`, `permissions`, and `steps`; its `if`, when present, contains none of `success(`, `failure(`, `always(`, or `cancelled(` (case-insensitive, allowing whitespace before `(`).
