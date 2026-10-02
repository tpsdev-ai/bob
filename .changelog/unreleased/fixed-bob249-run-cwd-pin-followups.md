- **`run` re-checks the workspace root's recorded identity, reports a failed `cwd`
  check by its errno, and states its remaining `cwd` window (bob#249).**
  `resolveCwd` records the workspace root's device and inode, and each re-check
  compares them. This detects a replacement while the original inode remains
  allocated. No descriptor holds the root inode allocated, so inode reuse before
  a re-check can make a replacement indistinguishable. Before, only the workspace's
  path string was kept, so a different root became the pinned directory.
  `resolveCwd` reports a `cwd` it cannot stat as `could not be checked (<errno>)`
  and a stat that returns a non-directory as `is not a directory`, instead of
  reporting every failure as `is not an existing directory`. The `run` tool
  description names the remaining `cwd` window in the same words as the capability
  README. The realpath-failure refusal says whether the directory is still the
  checked canonical path and the directory pinned at open, the phrase used
  elsewhere. (`test/capabilities/work/run.test.ts`,
  `test/capabilities/work/config.test.ts`)
