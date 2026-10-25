- **The Dependency Audit is clean again: zod resolves 4.6.6 and undici 8.12.2.**
  `bun audit` failed on `main` after advisories were published against the
  previously resolved versions (zod 4.4.3, undici 8.10.2), which blocked every
  pull request. Both are now pinned to the oldest releases that carry the fix,
  and a fresh install of bob needs nothing from an operator.
