- **The packaged artifact's npm install is held to the 7-day bake.**
  `scripts/verify-pack.mjs` installs the packed tarball's dependencies with
  npm, which reads neither `bun.lock` nor `bunfig.toml`. It now resolves the
  tarball's dependency tree into a lockfile with npm's `before` config set to
  seven days before `NOW` captured before `npm pack`, then refuses any resolved
  registry version whose
  publish time is missing or after that cutoff, naming each version it refuses,
  before `npm ci` runs an install script. A version npm rejects during
  resolution, before a lock exists, gets the cutoff guidance instead, and a
  registry metadata lookup failure is reported as its own error. Inherited npm
  config that could relax the cutoff is refused by name. The release pipeline's
  npm self-update pins the exact
  version 11.21.1 instead of resolving a range at run time.
  `docs/supply-chain.md` lists Bob's dependency-install commands and the
  control for each.
