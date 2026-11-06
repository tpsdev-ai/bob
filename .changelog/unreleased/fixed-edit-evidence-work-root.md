- **Edit evidence from a declared work root (#425).** `bob.yaml` now takes an
  optional top-level `work_root`, one absolute directory (`~/` is expanded).
  With it set, the completion gate also counts a commit or tracked diff in a
  git work tree directly under that directory, measured against the tree's
  state at launch; a work tree created during the run counts when it holds a
  commit made after launch. `bob doctor` names the root and the number of work
  trees it watches. A relative path, a missing directory or a non-directory is
  refused at load.
