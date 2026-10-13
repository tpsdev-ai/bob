- **Bob declares the bun version its lockfile is written with, and `bob doctor` reports a host mismatch.** `package.json` gains `packageManager: "bun@1.3.10"`, and CI's
  setup-bun pin is checked to match it. A bun other than that version may fail
  `bun install --frozen-lockfile`; `bob doctor` reports the differing bun with the
  `npx -y bun@<version> install --frozen-lockfile` remedy.
