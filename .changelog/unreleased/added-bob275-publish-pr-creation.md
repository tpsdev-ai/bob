- **`publish` creates a requested, authorized pull request (bob#275, S2b).**
  When `pr` is requested and the task binding authorizes it, `publish` creates a
  pull request and reports `pr_url` after verification. The intent is journaled
  before creation; recovery verifies repository, head/base, marker, commit and
  author. An uncertain create is `indeterminate` and is never reissued.
  An unauthorized `pr` request refuses as `pr_unsupported`.
  (`test/capabilities/work/publish-pr.test.ts`)
