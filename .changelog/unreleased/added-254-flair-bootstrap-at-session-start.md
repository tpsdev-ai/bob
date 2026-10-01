- **Session start loads Flair's bootstrap context for flair-configured agents.**
  When `bob.yaml` declares the `flair` capability, the agent's runtime session
  paths (`bob run` one-shot, the mail turn, the interactive launch, and the
  persistent runtime) call Flair's `POST /BootstrapMemories` and append the
  returned context after `soul.md`, under a `## Context from Flair` heading, so
  an agent sees the skills Flair assigns it and Flair's view of its context.
  The budget is `flair.bootstrap_tokens` (default 2000). A non-2xx, an
  unreadable body or a body with no `context` is an error, never an empty
  context: the session still starts, with one line saying the context could not
  be loaded. A web session appends none.
