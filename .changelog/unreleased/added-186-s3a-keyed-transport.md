- **A generic keyed OpenAI-compatible transport now serves every operator keyed row.** Custody
  implementations are keyed by API flavour (one, `openai-completions`) and the built-in `openrouter`
  row is pinned, while an operator `bob/env` row declares no variable: bob derives
  `BOB_PROVIDER_<ID>_KEY`. The key is read once, deleted from the environment and injected only at
  the transport, which sends solely to the row's canonical HTTPS endpoint and refuses
  redirects, credential-bearing headers and deferred requests.

  `bob init` (including `--force`), `bob hire` and `bob models` now run the reserved-name check
  over both pi files before their first write and refuse a file that carries a bob-owned keyed
  entry or cannot be proven free of one. A keyed-row init creates only absent pi files, each through
  an exclusive temp file and rename with mode 0600 set before the rename; the plain write path is
  unchanged for non-keyed rows. Refs #186.
