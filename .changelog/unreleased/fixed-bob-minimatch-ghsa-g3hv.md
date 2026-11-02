- **The Dependency Audit is clean again: `minimatch` resolves 11.0.3 through an override, clearing GHSA-g3hv-75wg-m249.**
  pi-coding-agent 0.84.3 pins minimatch 10.2.5, and there is no fixed 10.x;
  the fixed releases are 11.x. `overrides` now pins minimatch 11.0.3, whose
  named `minimatch(p, pattern, options)` export is the one pi imports, and
  `bun audit` is clean. Every fixed release was younger than the 7-day install
  gate when this landed, so `bunfig.toml` exempts minimatch and the matcher
  package it adds, as the Renovate note describes for an urgent fresh fix.
