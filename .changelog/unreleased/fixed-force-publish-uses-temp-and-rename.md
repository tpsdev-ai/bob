- **A mode-less `bob init --force` publish no longer writes the destination in place.** It writes a
  sibling temp file and renames it over the destination, so a destination symlink is replaced
  instead of followed. A `.<name>-<uuid>.tmp` a killed run left behind is removed by the next
  `init` in that directory; an entry that does not match init's temp-name shape is left alone.
  (`test/shell/init-force-atomic-332.test.ts`)
