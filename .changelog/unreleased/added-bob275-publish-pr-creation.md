- **`publish` creates the authorized pull request (bob#275, S2b).** When the task
  binding authorizes PR creation, `publish` accepts `pr { title, body }`, creates
  one pull request in the authorized repository with the authorized head/base
  pair and a publication marker, and reports `pr_url` once the PR is confirmed.
  The creation intent is journaled before the request; a retry or recovery
  reconciles an existing PR by repository, head/base and marker (open, closed or
  merged) and reuses its URL only on a verified match. An uncertain create is
  `indeterminate` and is never reissued. A `pr` request on a binding that does
  not authorize it still refuses as `pr_unsupported`.
  (`test/capabilities/work/publish-pr.test.ts`)
