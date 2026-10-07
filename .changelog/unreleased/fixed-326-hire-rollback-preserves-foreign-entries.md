- **A refused hire uses a publication ledger for agent-directory cleanup (#326).**
  Removal is attempted after recorded device, inode and kind match when checked;
  a substitution before removal can still remove a replacement or traverse a symlink.
  Created entries with unreadable identities are retained and reported.
  Move-back is attempted; failed cleanup and potentially retained quarantine paths
  are reported. A replaced empty move-back placeholder can still be overwritten.
  Leftovers are named when checked; arrivals after listing are not named.
  Failed adoption uses the same ledger cleanup for its marker and override repository.
  (`test/shell/init-rollback-326.test.ts`, `test/shell/init-rollback-boundaries-326.test.ts`)
