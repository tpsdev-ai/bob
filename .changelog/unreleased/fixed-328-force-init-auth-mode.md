- **`bob init --force` publishes non-env-provider `auth.json` with no group/other bits from creation and mode 0600 after publication (bob#328).**
  The launcher's final mode is 0755. Existing env-provider pi files are skipped. `bob models` replaces `.pi-agent/models.json` with the merged document; its help says so.
