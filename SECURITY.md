# Security Policy

## Reporting a vulnerability

Email **security@tps.dev** with details. Please do not open public GitHub issues for security reports.

We aim to respond within 48 hours.

## Scope

Bob is a moldable office-agent shell. Security-sensitive surfaces include:

- **Identity** — Ed25519 keypair generation (`src/shell/flair-pair.ts`) and Flair registration. Compromise of an agent's private key compromises that agent's signed dispatches.
- **Filesystem** — `bob onboard` writes the agent's directory tree under `~/agents/<name>/`. The regex `[a-z0-9-]+` guards prevent path-traversal via agent or role name.
- **Tokens** — Discord bot tokens, GitHub PATs, LLM provider API keys live in OS-level secret files (`~/.tps/secrets/`, `~/.flair/admin-pass`, etc.). Bob reads them on demand at session-start time; bob never logs token values.
- **Launcher** — the generated `bin/<name>` shell script uses `/bin/sh` (not `/bin/zsh`) to avoid re-sourcing user shell rc files that clobber env-prefix invocations.
- **Mail consumer** — single-instance lockfile with PID-based stale-lock recovery. Cross-instance contention is detected.
- **Discord bridge** — only listens on explicitly-configured channel IDs; `mentionsBot` filter on by default.

## Out of scope

- Third-party LLM provider security (Anthropic, OpenAI, Ollama Cloud, etc.)
- Pi-coding-agent (`@earendil-works/pi-coding-agent`) — report upstream.
- Discord.js internals — report upstream.
- The Flair memory layer — see `tpsdev-ai/flair`'s `SECURITY.md`.

## Supported versions

Bob is pre-1.0. Only `main` is supported. Vulnerabilities in older tags will not be patched.
