# Supply-chain controls for installs

Bob resolves packages in three places: the checkout's lockfile, a packed
tarball's dependencies, and the npm CLI used to stage a release. The 7-day
release-age bake is `bunfig.toml`'s `install.minimumReleaseAge = 604800`. Every
install path in CI and in the release pipeline, and the control that bakes it:

## Checkouts

| Install path | Where it runs | Control |
| --- | --- | --- |
| `bun install` (resolving) | local development | `bunfig.toml` `install.minimumReleaseAge` makes bun skip versions published in the last 7 days. |
| `sfw bun install --frozen-lockfile` | `ci.yml` `build`, `test`, `leak-check`, `pack`, `audit`; `release-publish.yml` `stage-publish` | A frozen install resolves nothing, so bun applies no `minimumReleaseAge`. `bun --no-install scripts/check-lockfile-release-age.mjs` is the first `run:` step of every job and refuses any registry version in `bun.lock` younger than 7 days, or a registry lookup it cannot complete. `sfw` (Socket Firewall) additionally blocks known-malicious packages. |

## The packed artifact

| Install path | Where it runs | Control |
| --- | --- | --- |
| `npm install --no-save <tarball>` into a scratch directory | `ci.yml` `pack`; the release Preflight | npm resolves the tarball's dependency ranges from the registry, not from `bun.lock`, and does not read `bunfig.toml`. `scripts/verify-pack.mjs` sets `npm_config_before` to `now - 7 days` (ISO) in the install environment, so npm resolves only versions published before that cutoff. The script prints the cutoff and, on an ETARGET resolution failure, fails with a message naming it and the remedy (wait for the bake or pin the dependency). |

## Release pipeline

| Install path | Where it runs | Control |
| --- | --- | --- |
| `npm install -g npm@11.21.1` | `release-publish.yml` `stage-publish` | Exact version, not a range: a range resolves at run time with no bake. 11.21.1 was published 2026-10-15, more than 7 days before this pin. Future bumps are reviewed changes; Renovate's `minimumReleaseAge` holds the dependency updates it proposes for 7 days. |
| `npm stage publish` | `release-publish.yml` `stage-publish` | Publishes the tarball built from the verified checkout; it resolves no dependency for installation. |
| GitHub Actions `uses:` | every workflow | A full commit SHA, never a tag or branch; Renovate's `helpers:pinGitHubActionDigests`. |
