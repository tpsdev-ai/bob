- **A refused hire's rollback no longer removes the whole new agent directory; it removes the
  entries the hire recorded publishing (#326).** The rollback moves the agent directory aside with
  one rename, then removes each entry that `bob init`, the binding marker and the override
  repository recorded when they published it, only if it is still that file or directory (same
  device, inode and kind) when it is checked. It never follows a symlink and never removes
  recursively. A file another writer added, an entry replaced since, and the interview's own
  `soul.md` and session files stay, the directory is moved back with them, and the leftovers found
  after the removals are named by their path relative to the agent directory. A failed adoption
  rolls back the marker and override repository entries it created the same way. A process that
  already holds a descriptor or working directory inside the agent directory, or that finds the
  moved directory by listing its parent, can still change entries while the rollback runs,
  including between a check and the removal it allows.
  (`test/shell/init-rollback-326.test.ts`, `test/shell/init-rollback-boundaries-326.test.ts`)
