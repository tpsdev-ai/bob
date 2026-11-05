# Supply-chain controls for installs

Bob's dependency-install commands in CI and the release pipeline, and the
control that bakes each. Action-managed runtime downloads (`oven-sh/setup-bun`,
`actions/setup-node`) are outside this table; the Actions themselves are pinned
by commit SHA in the last section. The 7-day release-age bake is
`bunfig.toml`'s `install.minimumReleaseAge = 604800`.

## Checkouts

| Install path | Where it runs | Control |
| --- | --- | --- |
| `bun install` (resolving) | local development | `bunfig.toml` `install.minimumReleaseAge` makes bun skip versions published in the last 7 days, except the names in `minimumReleaseAgeExcludes`. |
| `sfw bun install --frozen-lockfile` | `ci.yml` `build`, `test`, `leak-check`, `pack`, `audit`; `release-publish.yml` `stage-publish` | A frozen install resolves nothing, so bun applies no `minimumReleaseAge`. `bun --no-install scripts/check-lockfile-release-age.mjs` refuses each registry version in `bun.lock` that is younger than 7 days or whose registry lookup fails; it applies `bunfig.toml`'s `minimumReleaseAgeExcludes` (currently `@types/node` and `typescript`) before the lookup. It is the first `run:` step of those jobs and of `ci.yml` `action-pins`, `release-publish.yml` `github-release`, and `codeql.yml` `release-age`. `release-publish.yml` `verify-ancestry` instead starts with its ancestry guard, and `codeql.yml` `analyze` has no `run:` step and runs after the `release-age` job. `sfw` (Socket Firewall) additionally blocks known-malicious packages. |

## The packed artifact

| Install path | Where it runs | Control |
| --- | --- | --- |
| `npm install --package-lock-only --ignore-scripts <tarball>` then `npm ci` into a scratch directory | `ci.yml` `pack`; the release Preflight | npm resolves the tarball's dependency ranges from the registry, not from `bun.lock`, and does not read `bunfig.toml`. `scripts/verify-pack-install.mjs` resolves with npm's `before` set to `NOW - 7 days`, with `NOW` captured before `npm pack`, then checks every resolved registry `name@version` against the registry's publish time. A missing publish time or a time after the cutoff refuses the install before `npm ci` runs an install script, and the message names each version it refused. ETARGET, ENOVERSIONS and "No matching version" errors get guidance that resolution failed under the cutoff, and a registry metadata lookup failure is reported as its own error. The helper refuses inherited `before`, `min-release-age`, `min-release-age-exclude`, `registry`, `replace-registry-host`, `userconfig`, `globalconfig`, `prefix` and any `@scope:registry` setting; it drops all other inherited `npm_config_*` keys. User and global config point at empty files in the scratch tree, and a `.npmrc` in the scratch install directory or HOME is refused. |

## Release pipeline

| Install path | Where it runs | Control |
| --- | --- | --- |
| `npm install -g npm@11.21.1` | `release-publish.yml` `stage-publish` | `test/release-publish-npm-pin.test.ts` checks that the named upgrade step runs an exact `x.y.z` pin before the first direct `npm stage` / `npm publish` line, and that each such line has an immediately preceding version assertion for the same pin in its run script. |
| `npm stage publish` | `release-publish.yml` `stage-publish` | The immediately preceding runtime assertion requires `npm --version` to succeed and report the upgrade pin before staging. |

## Actions

| Install path | Where it runs | Control |
| --- | --- | --- |
| GitHub Actions `uses:` | every workflow | A full commit SHA, never a tag or branch. |
