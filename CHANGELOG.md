# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- **ONE session factory — bob never spawns pi and never builds a pi command line.** Every session — `bob run`, the persistent runtime, the launcher, the mail consumer, onboarding, alignment, and interactive `bob launch` — comes from a single factory in `src/shell/session.ts`, built on pi's runtime-factory contract, so every `/new`, `/resume`, `/fork`, `/clone` and `/import` goes through it too. The effective tool policy — the role's ceiling intersected with `bob.yaml`, minus `exclude` and the resident exclusions — is what the session is created with, and it is REQUIRED in the type and at runtime. `bob launch` takes AT MOST ONE PROMPT and nothing else: every other argument is refused BY NAME, so no caller-controlled argument reaches the session. (`test/shell/launch.test.ts`, `run-tool-allowlist.test.ts`)
- **A session's resources are built by bob, isolated.** Project trust is off, no configured package is installed, and the only extensions that LOAD are the capabilities declared in `bob.yaml`: pi still enumerates the ambient extension, skill, prompt-template and theme paths while resolving its package sources, and bob's loader flags stop them loading. The global `SYSTEM.md` / `APPEND_SYSTEM.md` are off too, and a reload re-reads exactly the declared sources. **Compatibility note: ambient pi extensions, skills, prompt templates, themes and packages no longer load for bob agents.** Add a capability by declaring it in `bob.yaml` and listing its tools within the role. (`test/shell/session.test.ts`)
- **`role.json` is the ceiling on the tool allowlist, and it is read at session creation.** The role's `tools.allow` ships with bob; `bob.yaml` is agent-writable, so `bob.yaml` may only NARROW it: a name the role does not allow is a load error naming the name and the role. The resident opt-in lives in the role schema as `tools.allowResidentShell` — the coder role sets it `true`, so a persistent builder keeps `bash`/`write`/`edit` while no `bob.yaml` can grant itself a shell its role does not allow. A `bob.yaml` whose `agent.role` is missing or unknown is a load error too. (`test/shell/tool-allowlist.test.ts`, `run-tool-allowlist.test.ts`)
- **The tool audit runs at creation, after the mode binds extensions, and after every reload.** Every name in the effective policy must be active in the session, and no model-callable tool name — one that is allowlisted and not excluded — is provided by two sources (a pi built-in or a declared capability). It runs on the SESSION, after pi has rebuilt its tool list (`session.reload()`) and after `bindExtensions()`: pi's TUI shows a reload error and carries on, so a failure disposes the session and ends the process with the named error rather than leaving one running whose policy no longer holds. A reload or a bind that itself FAILS ends the session the same way and names THAT failure — the session may be half-rebuilt, and a mode that caught the error would otherwise stay open on a tool state nobody audited. (`test/shell/session.test.ts`)
- **Non-interactive prompts are sent as text:** bob's own runner passes `expandPromptTemplates: false`, so no command, prompt-template or skill expansion can interpret a mail body or a task prompt. (`test/shell/session.test.ts`, `run.test.ts`)
- **Onboarding and alignment run under a FIXED setup policy of `read` and `write`**, which may exceed the role's ceiling — they are privileged local setup commands, and the interview's job is to write `soul.md`. Stated exception, in code and here. (`test/shell/onboard.test.ts`, `align.test.ts`)

### Fixed

- **Every launch path enforces the tool policy.** The generated `bin/<name>` launcher used to start a session of its own, onboard and align started one directly, and the mail consumer reached the session through the launcher — so every path outside `bob run` came up on whatever pi defaults to, whatever the role said. The launcher now hands off to `bob launch`, which resolves the agent's policy (`role.json` + `bob.yaml`) and starts the session through the ONE factory; onboard, align and the mail consumer go through that same factory. No path starts an agent session without the resolved allowlist. (`test/shell/launch.test.ts`, `init.test.ts`, `onboard.test.ts`, `align.test.ts`)
- **A missing or unparseable tool policy is a load error, not pi's defaults.** An absent `tools:` block, a `tools:` block with no `allow:`, and the inline form (`tools: {…}`, refused outright) all used to end up as "pi's defaults", which is the absence of a policy rather than one. An explicit empty list (`allow:` with no items) is still valid and means no tools, and the resolved allowlist and denylist reach the session as the factory's `tools`/`excludeTools`. `bob doctor` reports a missing policy as FAIL with the fix. (`test/shell/tool-allowlist.test.ts`, `doctor.test.ts`)
- **An allowlisted tool the session does not actually have is a load error naming it.** pi enables only what the loaded capabilities register and IGNORES an unknown tool name silently, so a role allowlist naming a capability tool (e.g. the EA role's `discord_reply`) on an agent that does not declare that capability produced a session quietly missing the tool its role asked for. A tool named in `tools.allow` that is not active after the capabilities load — and that no `tools.exclude:` removed — fails the session, naming the tool and pointing at `capabilities:` in `bob.yaml`: what registers a tool is the capability's extension, which has already loaded by then, so the message names the tool rather than the capability that would provide it. `bob doctor` reports the same condition before any session runs, and it works from the agent's DECLARATION: it flags an allowlisted capability tool whose capability `bob.yaml` does not declare. (`test/shell/run-tool-allowlist.test.ts`, `doctor.test.ts`)
- **`bob doctor` no longer suggests a fix that would fail.** A resident agent whose allowlist names a tool the resident policy drops used to be told to set `tools.allowResidentShell: true` in `bob.yaml` — which the role ceiling refuses at load, because `bob.yaml` may only narrow the role. The hint now names `roles/<role>/role.json`, where the grant actually lives, and names the `tools.allowResidentShell: false` denial in `bob.yaml` when that is what holds the tools down. (`test/shell/doctor.test.ts`)
- **`bob doctor` reports the FAILURE when an agent trips both of its tool checks.** A resident agent whose allowlist carried a dropped shell tool AND a tool of an undeclared capability used to get only the resident warning; the missing capability now fails first, because that is what would stop the session. The capability check also skips names the denylist removes, matching the session's audit. (`test/shell/doctor.test.ts`)
- **`bob init` stamps a policy that loads for every role:** the role's ceiling intersected with the tools that can exist for that agent (pi's built-ins plus the tools of the capabilities bob stamps). A fresh agent no longer carries a name nothing can register. (`test/shell/init.test.ts`)
- **The refused inline `tools:` form has a dedicated test.** `tools: {allow: [read]}` reads as an empty block — and empty is one step away from pi's defaults — so it is refused outright, naming the block shape to use. (`test/shell/tool-allowlist.test.ts`)

## [0.2.0] - 2026-05-23

Intel-gathering ergonomics for Bob agents. The launcher template now wires up GitHub-authenticated reads by default — no hand-patching when a Bob agent needs to poll releases.atom or hit the REST API.

### Added

- **GitHub PAT sourcing in the launcher template** (PR-26). `bob init` now emits an opt-in block that sources `$HOME/.tps/secrets/<name>-github-pat` into `GH_TOKEN` at startup. Lifts the GitHub rate-limit ceiling from ~60/hr (anonymous, shared exit IP) to 5000/hr (authenticated). Silent no-op when the file is missing — agent still runs on the anonymous limit. Per-agent PAT identity (not a shared bot) so a leak rotates one identity, not the org. The companion [@tpsdev-ai/skills/intel-gathering](https://github.com/tpsdev-ai/skills/tree/main/intel-gathering) skill pack documents the full pattern (PAT scope, verified-working vendor feeds, polling cadence, ETag caching).

### Changed

- **README polish** (PR-24). Three fixes from Nathan's review pass: provider-name corrections + clearer composition story.
- **`bob onboard` interview prompt** (PR-25). "What would you say... ya do here?" Office Space callback shipped + "Bring On Board" backronym added to the README.

### Notes

No breaking changes. Existing Bob agents continue to work; the new launcher block only matters at next `bob init` (or when an agent has a PAT file under `~/.tps/secrets/<name>-github-pat`, which never auto-magically appears — you have to drop it).

[0.2.0]: https://github.com/tpsdev-ai/bob/releases/tag/v0.2.0

## [0.1.0] - 2026-05-21

First publishable release. Bob is functional end-to-end: scaffold an agent with `bob onboard`, shape its persona through conversation, run it via `bob run`, keep it listening on Discord via `bob serve --discord`, and health-check it with `bob doctor`.

### Added

- **`bob onboard <name> --role <role>`** — scaffolds the per-agent directory layout (soul.md, bob.yaml, Ed25519 keypair, executable launcher, pi-agent config) and drops into an interactive hiring interview where the agent writes its own persona via conversation with the human. `--no-interactive` skips the interview for CI/dry runs. `--dry-run` previews the plan.
- **`bob align <name>`** — recurring drift-check counterpart. Spawns an alignment conversation; agent rewrites soul.md with the deltas surfaced.
- **`bob run <name> [prompt]`** — invoke an agent's launcher with optional `--model X` per-call override (lightweight dynamic routing) and `--interactive` for a TUI session.
- **`bob serve <name>`** — daemon mode. Mail consumer always-on. Add `--discord --discord-token-file <p> --discord-channels <ids> [--discord-dispatch-all] [--discord-model <m>]` to attach a Discord listener that dispatches @-mentions (or all messages in dispatchAll mode) through `runAgent` and posts the captured stdout back to Discord.
- **`bob doctor <name>`** — health check that walks the expected layout and reports per-check status (OK / WARN / FAIL / SKIP) with actionable `fix:` hints. Exit 1 on any FAIL. Read-only — never modifies state.
- **Five role templates** ship in `packages/shell/roles/`: `ea`, `writer`, `reviewer`, `coder`, `qa`, plus a blank-slate `custom` stub. Each role has a seed `soul.md` (What you own / Don't own / Personality / Tone / Failure modes) and a `role.json` with a sensible tool allowlist and provider/model defaults.
- **Launcher generation** writes a per-agent `~/.pi-agent/auth.json` (placeholder API key) and `models.json` (gateway baseUrl override) when provider is `exe-dev-gateway`, and appends `--append-system-prompt "$(cat $AGENT_DIR/soul.md)"` so the agent loads its persona on every invocation.
- **Identity** via Ed25519 keypair generation + Flair Agent record registration.
- **Discord bridge abstraction** (shell) + discord.js binding (separate `@tpsdev-ai/bob-discord` package so callers without Discord don't pay the ~30MB discord.js install cost).
- **stdout capture** in `runAgent` so the Discord listener can post the agent's reply.
- **Path-traversal + prompt-injection defense** at the entry of every agent-name-accepting function: `runOnboard`, `runAlign`, `runAgent`, `runDoctor`. AGENT_NAME = `/^[a-z0-9-]+$/`.

### Architecture

Bob is a thin TypeScript shell on top of [pi-coding-agent](https://github.com/earendil-works/pi). Pi owns the agent loop, tools, and LLM provider abstraction. Bob adds the office plumbing — identity, mailbox, channels, scheduling — that turns one terminal agent into a named office hire.

### Packages

- `@tpsdev-ai/bob` — the `bob` CLI command
- `@tpsdev-ai/bob-shell` — runtime + role templates + integrations (mail, Discord bridge abstraction, init, run, onboard/align, doctor)
- `@tpsdev-ai/bob-discord` — discord.js binding for `bob-shell`'s `DiscordClient` interface

### Status

`0.1.0` is the first publishable release. First production deployment is **Pulse-EA** on a fresh `tps-pulse` VM. The interactive onboard flow, real `bob run`, Discord listener with auto-reply, doctor, role templates, and per-agent pi config seeding all landed in PR-15 through PR-22.

Known caveats:
- Federation pair (Bob agents reading/writing Flair memory across hosts) requires the same setup as Reed Phase 2; not packaged into `bob office join` yet.
- Branch-office docs (`bob office join`) are stubbed pending the productization recipe from `~/ops/specs/`.

[0.1.0]: https://github.com/tpsdev-ai/bob/releases/tag/v0.1.0
