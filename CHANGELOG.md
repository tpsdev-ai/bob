# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **A `bob run` no longer settles silently after a context compaction** (#145). A one-shot run that hit pi's context threshold could lose its own plan and then finish `done: true, exitCode 0` with the work left uncommitted and no final message — indistinguishable from a clean completion, and for a resident agent the same class reads as silent mid-task abandonment. Now, after every non-aborted compaction the run re-injects one bounded pinned block (the original task, or the persistent runtime's standing contract, plus "what remains" — the last plan the agent stated, or a generated note with `git status --short` and the last few tool calls). The block has a minimum cap (a smaller cap is refused rather than treated as "no cap"), and the block's whole header — the label, the compaction count, the cap number and a bounded form of the compaction reason — is counted against that cap. Within it "what remains" is budgeted first: truncation shrinks the task and then the remains body, never the section headers, so the block always carries "WHAT REMAINS" and never exceeds its cap, whatever the reason says. A one-shot run re-injects the block immediately as a steer, while the persistent runtime attaches it to the NEXT prompt instead (a compaction lands after a turn, once that turn's reply destination is spent, so a new turn would have no reply to route). And a one-shot run ends `exitCode 0` only when its completion contract is met: the final text is exactly the content of the LAST assistant message that ENDED after the last compaction, kept exactly as it ended — whitespace included; only emptiness is judged on the trimmed text — never rebuilt from streamed deltas, and an empty ending, or one whose stop reason is an error or an abort, is no final message; text streamed before a compaction never counts; a transport that ends no assistant message at all falls back, in a run with no compaction, to the session's last assistant message — and it matches an expected final shape, on that verbatim text, when one is declared. A run that settles after a compaction with no final message retries once with an explicit "continue from the state above" turn; if it still settles without meeting the contract it exits non-zero with a named reason (`settled_after_compaction`, `no_final_message` or `final_shape_mismatch`) and prints the dirty paths instead of reporting success. And a re-injection that FAILS is no longer only logged: a compaction whose pinned block could not be re-injected leaves the agent running without its task, so its final text — however complete it reads — is no evidence of completion. Such a run exits non-zero with the named reason `reinjection_failed`, prints the dirty paths, and is NOT retried: a continue turn does not resend the task. A PERSISTENT runtime cannot refuse a run — it has no exit code to go red — so the same failure stops it instead: a resident agent whose standing contract could not be attached keeps accepting inbound prompts with the contract silently gone, and bob now disposes that session and exits non-zero with the named reason `reinjection_failed`, so no later Discord reply, mail or scheduled fire runs on it; its supervisor restarts it with a fresh session whose standing contract is intact from the start. A rejection that arrives late from an older compaction cannot stop a runtime whose newest attach succeeded.

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
