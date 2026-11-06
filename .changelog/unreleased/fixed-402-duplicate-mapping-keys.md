- **The action pin check restricts YAML syntax before checking block mapping
  keys for duplicates (bob#402).** It accepts block mappings and indented block
  sequences, plain keys matching `[A-Za-z0-9_./-]+` whose spelling Bun.YAML
  preserves, one-line plain/quoted scalars, `|`/`>` block scalars with optional
  chomping/indent indicators, and flat one-line flow sequences of scalars.
  It refuses quoted/explicit keys, flow mappings, multiline plain/quoted scalars,
  nested/multiline flow collections, anchors, aliases, merge keys, tags, directives,
  tab indentation and additional document markers (one opening `---` and closing
  `...` are allowed). Refusals name the file, line and rewrite; duplicate keys
  name both lines and are compared byte-for-byte within their block mapping.
  (`scripts/check-action-pins.mjs`, `test/check-action-pins.test.ts`)
