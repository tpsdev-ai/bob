- **A manual release dispatch stages the v<version> tag's commit, not the
  dispatched ref's commit.** The guard refuses, naming the version and the
  reason, when that tag is absent, does not point at a commit, or its commit is
  not on main. On a tag push the version comes from the pushed tag ref, and
  every later job checks out the sha the guard verified.

  Push the v<version> tag on a commit that is on main, then dispatch; the tag,
  not the branch the run started from, decides what is staged.
