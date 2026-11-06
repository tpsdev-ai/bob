- **Declared work root for the completion gate (#425).** `bob.yaml` takes an
  optional top-level `work_root`, one absolute existing directory (`~/` is
  expanded); other values are refused at load. Existing trees need
  changed tracked content absent from launch history. Unknown launch captures
  cannot count. New children use a content-change and reflog-label heuristic
  at or after the launch second. Children confirmed not a repository at launch
  must have had no entries; unborn repositories must have had no entries other
  than `.git`. Non-empty children in either state cannot count through this path.
  `git update-ref -m` or a crafted log can set the subject label. Reflog and
  committer times use the local clock / `GIT_COMMITTER_DATE`; this is not proof
  against a deliberately forged clock. Any content change in a qualifying tree
  counts, including a tree unrelated to the task; the operator chooses the root.
  The gate refuses a claim with no change at all.
  `bob doctor` shows the configured work root.
