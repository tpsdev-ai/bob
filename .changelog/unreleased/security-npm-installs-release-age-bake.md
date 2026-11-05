- **npm installs that resolve from the registry are held to the 7-day bake.**
  `scripts/verify-pack.mjs` installs the packed tarball's dependencies with
  npm, which reads neither `bun.lock` nor `bunfig.toml`. Its install
  environment now sets npm's `before` config to seven days before the run, so
  npm resolves only versions published before that cutoff; the script prints
  the cutoff and, on an ETARGET resolution failure, names it with the remedy
  (wait for the bake or pin). The release pipeline's npm self-update installs
  the exact version 11.21.1 (published 2026-10-15) instead of resolving a
  range at run time. `docs/supply-chain.md` lists every install path in CI and
  release and the control that bakes it.
