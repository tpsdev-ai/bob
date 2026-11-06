- **The release workflow's npm pin gate is pinned by structure tests.**
  In `stage-publish`, exactly checkout, setup-bun and the lockfile checker
  must precede the npm pin release-age step, in that order. The action steps
  allow only `name`, `uses` and `with`; the lockfile checker and pin step
  allow only `name` and `run`. In `test/npm-pin-release-age.test.ts`,
  a registry lookup that is refused, answers 5xx, or answers a non-JSON body
  exits non-zero without reporting the pin as old enough.
