- **`publish` supports PR requests (bob#275, S2b).**
  When `pr` is requested, `publish` may create the authorized PR after a successful
  push; it reports `pr_url` only after confirmation, otherwise a refusal or
  indeterminate result names the reason.
  (`test/capabilities/work/publish-pr.test.ts`)
