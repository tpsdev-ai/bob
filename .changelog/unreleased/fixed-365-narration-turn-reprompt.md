- **A narrating turn no longer ends a builder run that declares final markers (#365).** A one-shot run ended
  when the model returned a turn with text and no tool call, even when that text announced a next step
  ("Let me fix lines 282-284:") instead of reporting. A role may now declare `final_markers` in its
  `role.json` (a run may pass `finalMarkers`, which overrides the role's), and `builder-local` declares
  `["DONE", "BLOCKED"]`. With markers declared, a turn that ends with text and no tool call whose trimmed
  text does not start with a marker (a case-sensitive prefix test) is re-prompted in the same session
  with the fixed `You announced a step but made no tool call. Continue the task; end only with your final
  message.`, up to three re-prompts (`DEFAULT_MAX_NARRATION_REPROMPTS`, its own budget, one per run, the
  compaction retry included). A turn still narrating after that fails the run with the named outcome
  `narration_only` (exit 1, `failed`), and its outcome record carries the reason and the re-prompt count,
  no model text. A run that declares no markers is unchanged, mail turns are exempt, and the
  reasoning-only re-prompt (#256) keeps its own budget and behaviour. A malformed marker list is refused
  when the role loads or before the session starts. (`test/shell/narration-turn.test.ts`)
