- **An operator provider registry file gives every row an explicit auth mode.** `bob` reads
  `~/.config/bob/providers.yaml` (or the built-in rows when it is absent) through a real YAML
  parser; a row must declare `auth` as `bob/env(<VAR>)`, `bob/none`, `bob/vm`, `pi/disk` or
  `pi/login`, and the obsolete `gateway`/`envKey` flags refuse at load.

  A `bob/env` row loads only when its runtime has an implemented custody descriptor (`openrouter`
  today); operator data cannot assert that custody. The disk-refusal set is derived from the keyed
  rows (each id, alias and runtime), and `provider.base_url` eligibility comes from each keyless
  row's override policy. Refs #186.
