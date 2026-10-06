- **A generic keyed OpenAI-compatible transport.** Custody
  implementations are keyed by API flavour (one, `openai-completions`) and the built-in `openrouter`
  row is pinned, while an operator `bob/env` row declares no variable: bob derives
  `BOB_PROVIDER_<ID>_KEY`. A factory caches the key after reading and deleting its variable.

  `bob init` (including `--force`), `bob hire` and `bob models` now run the reserved-name check
  over both pi files before their first write and refuse a file that carries a bob-owned keyed
  entry or cannot be proven free of one. A keyed-row init skips pi files present at its existence check
  (a check that fails with anything but ENOENT stops the init) and publishes the others from an exclusive
  temp file with mode 0600 through `link(2)`: an entry that appears at the path between the check and
  the publication is left unchanged and the init refuses (#322). Refs #186.
