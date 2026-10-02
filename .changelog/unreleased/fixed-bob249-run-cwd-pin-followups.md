- **`run` refuses a replaced workspace root, reports a failed `cwd` check by its
  errno, and states its remaining `cwd` window (bob#249).** The workspace root's
  device and inode are pinned when `cwd` is resolved and re-checked with the pin,
  so a workspace root replaced by another directory at the same path between the
  resolution and the pin is refused by name; before, only the workspace's path
  string was kept, so such a replacement became the pinned directory.
  `resolveCwd` reports a `cwd` it cannot stat as `could not be checked (<errno>)`
  and a stat that returns a non-directory as `is not a directory`, instead of
  reporting every failure as `is not an existing directory`. The `run` tool
  description names the remaining `cwd` window in the same words as the capability
  README. The realpath-failure refusal says whether the directory is still the
  checked canonical path and the directory pinned at open, the phrase used
  elsewhere. (`test/capabilities/work/run.test.ts`,
  `test/capabilities/work/config.test.ts`)
