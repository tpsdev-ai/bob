- **The release job re-checks the pinned npm version's publish age before publishing.**
  `release-publish.yml` `stage-publish` runs the same
  `scripts/check-npm-pin-release-age.mjs` checker as CI, before the npm
  self-update and before any install or stage/publish step. It fails closed when
  the registry lookup fails, the publish time is missing or malformed, or the
  pin is younger than seven days.
