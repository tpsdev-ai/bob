- **Declared work root for the completion gate (#425).** `bob.yaml` takes an
  optional top-level `work_root`, one absolute existing directory (`~/` is
  expanded); other values are refused at load. When the edit gate is enabled,
  bob scans at most 200 child directories in name order. Existing trees need
  changed tracked content absent from launch history. Unknown launch captures
  cannot count. New repositories use a content-change and reflog-label heuristic
  at or after the launch second: `git update-ref -m` or a crafted log can set the
  subject label. Reflog and committer times use the local clock /
  `GIT_COMMITTER_DATE`; this is not proof against a deliberately forged clock.
  `bob doctor` reports the root, its child directories, how many are work trees
  now, and discovery unknowns.
