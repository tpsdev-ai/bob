- **A refused hire's rollback leaves a file another writer placed in the new agent directory in
  place, and names it in the refusal (#326).** The rollback removes the scaffold entries `bob init`
  published that are still those entries, then the agent directory only if it is now empty. A
  competing file, an entry replaced by a different file, and a symlink entry are left in place and
  named by their path relative to the agent directory.
  (`test/shell/init-rollback-326.test.ts`)
