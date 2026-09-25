# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- **`role.json` is the ceiling on the tool allowlist, and it is read at session creation.** The role's `tools.allow` ships with bob; `bob.yaml` is agent-writable, so `bob.yaml` may now only NARROW it: a name the role does not allow is a load error naming the name and the role. The resident opt-in moved into the role schema as `tools.allowResidentShell` — the coder role sets it `true`, so a persistent builder keeps `bash`/`write`/`edit` while no `bob.yaml` can grant itself a shell its role does not allow. A `bob.yaml` whose `agent.role` is missing or unknown is a load error too: a session cannot apply a ceiling it cannot read.

### Fixed

- **Every launch path now enforces the tool policy.** The generated `bin/<name>` launcher used to `exec pi --provider … --model …` itself, onboard and align spawned the `pi` binary directly, and the mail consumer reached pi through the launcher — so every path outside `bob run` started a session with pi's defaults, whatever the role said. The launcher now hands off to `bob launch`, which resolves the agent's policy (`role.json` + `bob.yaml`) and starts pi with it; onboard and align resolve the same policy and pass it as pi's own flags; the mail consumer reaches it through the launcher. No path starts an agent session without the resolved allowlist.
- **A missing or unparseable tool policy is a load error, not pi's defaults.** An absent `tools:` block, a `tools:` block with no `allow:`, and the inline form (`tools: {…}`, now refused outright) all used to end up as "pi's defaults", which is the absence of a policy rather than one. An explicit empty list (`allow:` with no items) is still valid and means no tools — and reaches pi as `--no-tools`, never as an empty `--tools` value. `bob doctor` reports a missing policy as FAIL with the fix.
- **An allowlisted tool the session does not actually have is now a load error naming it.** pi enables only what the loaded capabilities register and IGNORES an unknown tool name silently, so a role allowlist naming a capability tool (e.g. the EA role's `discord_reply`) on an agent that does not declare that capability produced a session quietly missing the tool its role asked for. A tool named in `tools.allow` that is not active after the capabilities load — and that no `tools.exclude:` removed — now fails the session, naming it and the capability that would provide it.

- **Every role's tool allowlist now actually binds the agent session.** `bob init` stamped role.json's `tools.allow` into bob.yaml, but nothing read the block back: every agent came up with pi's defaults (`read`, `bash`, `edit`, `write`) plus its capability tools whatever its role said, and the shipped roles carried names (`Bash`, `Read`, `WebFetch`, `mcp__plugin_discord_discord__reply`) that pi's registry does not know — which pi ignores silently, so the allowlist was inert twice over. `tools:` is now read with a schema (an unknown key is refused; a declared `exclude:` is honored), every name is resolved against the tools that can actually exist — pi's built-ins plus the tools the blessed capabilities register — and a name that maps to nothing is a load error naming the offender and its replacement instead of a silent drop. The resolved allowlist and denylist reach the session as `createAgentSession({ tools, excludeTools })`. A `resident: true` agent (or any agent under the persistent runtime) also drops `bash`, `write`, `edit` and `powershell` unless its role opts back in with `tools.allowResidentShell: true`, and `bob doctor` reports an unmapped name with the fix, plus a resident agent whose allowlist asks for a tool the resident policy drops.

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
