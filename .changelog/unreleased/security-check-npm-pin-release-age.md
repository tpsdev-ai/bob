- **CI checks the release pipeline's pinned npm version against the 7-day bake.**
  `ci.yml`'s `action-pins` job runs `scripts/check-npm-pin-release-age.mjs`,
  which reads the exact `npm@x.y.z` pin from `release-publish.yml` and refuses
  it when the registry has no valid publish time in `YYYY-MM-DDTHH:mm:ss[.sss]Z` format for that version or published it
  less than seven days ago. The registry lookup is tested offline against a
  loopback registry.
