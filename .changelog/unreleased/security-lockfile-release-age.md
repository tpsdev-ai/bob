- **Lockfile release-age enforcement in CI.** A frozen
  install resolves nothing, so `bunfig.toml`'s `minimumReleaseAge` did not
  apply to the committed pins. A Bun script now reads the package versions in
  `bun.lock`, reads the bake and `minimumReleaseAgeExcludes` from `bunfig.toml`,
  and fails on each checked registry version younger than the bake or a registry
  lookup it cannot complete. The checker is the first `run:` step of each
  workflow job with a `run:` step, except release-publish.yml's verify-ancestry
  job. Before the first `run:` step, only `actions/checkout` (`fetch-depth`, `persist-credentials`), `oven-sh/setup-bun` (`bun-version`), `actions/setup-node` (`node-version`), and `socketdev/action` (`mode`) are allowed, with only those inputs.
  `minimumReleaseAgeExcludes` filters entries by exact package name before registry lookup.
  the test pins the structure of ci.yml, codeql.yml, socket.yml and release-publish.yml: every workflow, job and step key is from a fixed allow set, no job or step condition uses a status-check function, and the checker and the ancestry guard have fixed shapes; an edit outside these sets fails the test until the sets are deliberately changed in review. It does not inspect the contents of the actions those steps use.
