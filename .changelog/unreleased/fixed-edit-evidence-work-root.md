- **Declared work root for the completion gate (#425).** `bob.yaml` takes an
  optional top-level `work_root`, one absolute existing directory (`~/` is
  expanded); other values are refused at load. Existing work trees need changed
  tracked content whose tree is absent from launch history, the same repository
  and a launch HEAD ancestor. New or initially empty non-repository children need
  a reflog commit entry at or after the launch second with changed commit content
  (a heuristic). A child that existed at launch, under any later name, retains its
  launch state: unborn repositories, non-empty non-repository children and unknown
  captures never count. All surviving launch children are checked first; new
  children fill remaining slots in the 200-child bound in name order. Qualifying
  trees may be unrelated to the task. Reflog labels and local times can be forged.
  `bob doctor` shows the configured work root.
