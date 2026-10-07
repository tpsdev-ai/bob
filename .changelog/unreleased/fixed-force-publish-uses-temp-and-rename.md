- **A mode-less `bob init --force` publish no longer writes the destination in place.** It writes a
  sibling temp file and renames it over the destination, so a destination symlink is replaced
  instead of followed.
  (`test/shell/init-force-atomic-332.test.ts`)
