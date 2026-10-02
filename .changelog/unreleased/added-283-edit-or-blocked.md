- **builder-local: a one-shot run edits, or it reports BLOCKED (#283).** With the role's
  `require_edit_or_blocked` opt-in, a `bob run` that made no verified file edit must end with a
  final message that begins with BLOCKED, or it exits non-zero with the outcome
  `no_edit_no_blocked`, recorded in the run log; `bob doctor`'s last-run line names it and its fix.
  A verified edit is a write-class file-edit tool that ended without an error and without a refusal,
  with the tool's own success evidence (`edit-evidence.ts`, the one place this rule lives). Mail
  turns and the persistent runtime keep their own completion rules.
