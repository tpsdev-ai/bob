- **Runtime launch loads Flair's bootstrap context for flair-configured agents.**
  When the agent's resolved capabilities include `flair`, the runtime session
  paths (`bob run` one-shot, the mail turn, the interactive launch, and the
  persistent runtime) call Flair's `POST /BootstrapMemories` and append the
  returned context after `soul.md`, under the heading
  `## Context from Flair (loaded at session start)`. Bob bounds the appended
  block, heading included, by `flair.bootstrap_tokens` (default 2000, estimated
  at about 4 characters per token). On a request, response, timeout or budget
  failure the session still starts, with one line saying the context could not
  be loaded; a blank context appends nothing. A web session appends no
  bootstrap.
