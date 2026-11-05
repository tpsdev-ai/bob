- **The action pin check inventories YAML references.** Bun.YAML finds workflow
  step and reusable-workflow job references and action metadata step references;
  local `./` actions are followed through `action.yml`/`action.yaml`, with cycles
  and scan bounds checked. Job-level local reusable workflows are checked as
  workflow files; duplicate step/job `uses` keys are refused. Missing metadata,
  parse errors and unwalkable shapes are errors. Remote refs require a full 40-hex
  SHA and a full release-tag comment resolving to it; `docker://` refs require `@sha256:<64-hex>`. References outside
  canonical `- uses: <value>` or `uses: <value>` source lines are refused with a
  remedy for the step, reusable-workflow job, local or Docker reference kind.
  YAML aliases are refused with the file, source tokens and the remedy "write the
  step out in full". The checker assumes a checkout no other process is rewriting
  and checks path containment before opening files. The CLI requires
  `GITHUB_TOKEN` for tag lookups and refuses without it before scanning.
