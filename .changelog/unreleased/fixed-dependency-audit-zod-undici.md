- **The Dependency Audit is clean again: in `bun.lock`, zod resolves 4.6.6 and undici 8.12.2.**
  `bun audit` reported advisories against the versions the lockfile resolved
  before (zod 4.4.3, undici 8.10.2), which failed the required Dependency Audit
  check on pull requests. Both are now pinned, in `dependencies` and in
  `overrides`. A frozen Bun install of this repository's lockfile passes
  `bun audit`, which is what the CI Dependency Audit runs.
