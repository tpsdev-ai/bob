- **`publish` attempts a requested, authorized pull request (bob#275, S2b).**
  When `pr` is requested and the task binding authorizes it, `publish` attempts
  to create a pull request after a successful push on a supported GitHub HTTPS
  endpoint, refuses unsupported endpoints, and reports `pr_url` only after
  confirming the PR. The intent is journaled
  before creation; recovery verifies repository, head/base, marker, commit and
  author. An uncertain create is `indeterminate` and is never reissued.
  An unauthorized `pr` request refuses as `pr_unsupported`.
  (`test/capabilities/work/publish-pr.test.ts`)
