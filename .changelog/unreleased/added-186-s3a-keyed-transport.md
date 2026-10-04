- **A generic keyed OpenAI-compatible transport.** Custody
  implementations are keyed by API flavour (one, `openai-completions`) and the built-in `openrouter`
  row is pinned, while an operator `bob/env` row declares no variable: bob derives
  `BOB_PROVIDER_<ID>_KEY`. A factory caches the key after reading and deleting its variable.

  `bob init` (including `--force`), `bob hire` and `bob models` now run the reserved-name check
  over both pi files before their first write and refuse a file that carries a bob-owned keyed
  entry or cannot be proven free of one. A keyed-row init skips pi files present at its existence check and publishes through
  an exclusive temp file and rename with mode 0600 set before the rename. Refs #186.
