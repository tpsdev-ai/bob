- **builder-local: edit-or-BLOCKED completion gate (#283).** `bob run` and
  `bob launch <name> <prompt>` apply `require_edit_or_blocked` after the completion
  judge accepts: without verified file-edit-tool evidence or a standalone opening
  `BLOCKED` token, they exit non-zero with `no_edit_no_blocked`.
  Outcome logging is best-effort; `bob doctor` reports the outcome when recorded.
  Mail turns, interactive launch and the persistent runtime keep their completion rules.
