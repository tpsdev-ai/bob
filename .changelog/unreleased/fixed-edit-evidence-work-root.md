- **Edit evidence from a declared work root (#425).** `bob.yaml` takes an
  optional top-level `work_root`, one absolute existing directory (`~/` is
  expanded); other values are refused at load. When the edit gate is enabled,
  bob scans at most 200 child directories in name order for evidence of a
  content-changing commit or tracked change. Unknown launch captures cannot
  count. New repositories need a content-changing commit action in their
  reflog at or after the launch second. Reflog and committer times use the local
  clock / `GIT_COMMITTER_DATE`; this is not proof against a deliberately forged
  clock. `bob doctor` reports the child directories it would scan and how many
  are work trees now.
