- **This release workflow revision re-checks the npm pin's publish age.**
  `release-publish.yml` `stage-publish` runs the same
  `scripts/check-npm-pin-release-age.mjs` checker as CI, before the npm
  self-update, dependency-install run steps and staging, with no `if:` on the
  check. It fails closed when the registry lookup fails, the publish time is
  missing or malformed, or the pin is younger than seven days.
