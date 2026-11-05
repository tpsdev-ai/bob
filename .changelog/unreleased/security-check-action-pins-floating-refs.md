- **The action pin check inventories YAML references.** Bun.YAML finds workflow
  step and reusable-workflow job references and action metadata step references;
  local `./` actions are followed through `action.yml`/`action.yaml`, with cycles
  and scan bounds checked. Missing metadata, parse errors and unwalkable shapes
  are errors. Remote refs require a full 40-hex SHA and a full release-tag comment
  resolving to it; `docker://` refs require `@sha256:<64-hex>`. References outside
  canonical `- uses: <value>` or `uses: <value>` lines are refused with the remedy
  `- uses: owner/repo@<40-hex> # vX.Y.Z`. The CLI requires `GITHUB_TOKEN` for tag
  lookups and refuses without it before scanning.
