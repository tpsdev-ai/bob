- **The action pin check refuses duplicate mapping keys in workflow and action
  files, not only duplicate `uses` keys (bob#402).** A duplicate key in a block
  or flow mapping is reported with the file, the key and both line numbers;
  siblings may reuse the same child keys, and block-scalar bodies are not
  scanned as mappings. The existing `uses` remedy is kept.
  (`scripts/check-action-pins.mjs`, `test/check-action-pins.test.ts`)
