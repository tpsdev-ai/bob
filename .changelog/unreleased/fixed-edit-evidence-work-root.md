- **Declared work root for the completion gate (#425).** `bob.yaml` takes an
  optional top-level `work_root`, one absolute existing directory (`~/` is
  expanded); other values are refused at load. Existing work trees need changed
  tracked content whose tree is absent from launch history, the same repository
  and a launch HEAD ancestor. New or initially empty non-repository children need
  a reflog commit entry at or after the launch second with changed commit content
  (a heuristic). Unborn repositories, non-empty non-repository children and unknown
  launch captures never count. Any qualifying tree under the root counts, including
  one unrelated to the task. Reflog labels and local times can be forged.
  `bob doctor` shows the configured work root.
