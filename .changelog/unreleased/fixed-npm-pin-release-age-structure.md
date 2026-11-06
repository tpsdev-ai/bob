- **The release workflow's npm pin gate is pinned by structure tests.**
  `test/check-lockfile-release-age-ci.test.ts` refuses a `stage-publish` step
  that runs `npm ci`, `npm install`, `bun install`, `pnpm install` or
  `yarn install` before the npm pin release-age step, and refuses any key on
  that step other than `name` and `run`. In `test/npm-pin-release-age.test.ts`,
  a registry lookup that is refused, answers 5xx, or answers a non-JSON body
  exits non-zero without reporting the pin as old enough.
