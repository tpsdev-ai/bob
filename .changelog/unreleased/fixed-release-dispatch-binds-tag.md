- **A manual release dispatch stages the v<version> tag's commit, not the
  dispatched ref's commit.** The guard refuses when that tag is absent or its
  commit is not on main, and every later job checks out the sha it verified.

  Push the v<version> tag on a commit that is on main, then dispatch; the tag,
  not the branch the run started from, decides what is staged.
