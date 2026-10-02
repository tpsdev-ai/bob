- **`apply_patch` refuses a state root inside the checkout, and enforces apply
  mode's pinned tree (Refs #275).** The tool now runs the two checks `run` runs
  before it writes under its own state root: a state root inside the workspace or
  the task's repository refuses with `storage_failed`, because the candidate
  record and the scratch index there would be stray files in the caller's
  checkout, and the root must be a plain, owner-only directory of this user (a
  symlink, a file, another account's directory or any group or world permission
  bit refuses too). Apply mode also compares the written tree with
  `expected_tree_oid` and refuses with `tree_mismatch` when they differ.
