# Bob

> Moldable office-agent shell. One shape, any role — identity, memory, mail, and channels wired; soul is yours.

Bob is the shell our office agents share. Ember, Reed, Quill all use the same pattern today — launcher script, `.pi-agent/` config, work dir, Flair identity, TPS mail inbox, Discord channel binding. Bob makes that pattern explicit and reusable so spinning up a new agent for a new role is a 30-second `bob onboard`, not a 150-line launcher rewrite.

## Status

**Pre-1.0, design phase.** Initial scaffolding (this PR). First production deployment will be Pulse-EA on a fresh tps-pulse VM.

Design spec: see `docs/DESIGN.md` (lives in `~/ops/specs/BOB-SHELL-DESIGN.md` until imported).

## What Bob owns

- Launcher script generator (`bob onboard <name> --role <role>`)
- Mail consumer loop (poll inbox → dispatch session → drain DONE)
- Flair identity pairing (Ed25519 keys, Agent record registration, federation)
- Discord channel binding (read configured channels, reply via bot)
- Cron scheduler glue (briefings, sweeps, recurring work)
- Branch-office join (`bob office join`)

## What Bob does NOT own

- **Soul / persona** — lives in `~/agents/<name>/soul.md` (and synced to Flair).
- **Tool allowlist** — per-role config; Bob just plumbs it through to pi-coding-agent.
- **Memory** — that's Flair.
- **LLM provider** — `bob.yaml` picks; vendor-neutral.

## Build (once scaffolding lands)

```sh
bun install
bun run build
# Try it:
./packages/cli/bin/bob onboard testbot --role ea --provider ollama-cloud --model kimi-k2.6
```

## Repo layout

```
packages/
  shell/          # the shell — runtime + integrations (library)
  cli/            # `bob` command (uses shell)
examples/
  roles/
    ea/           # Pulse-EA role template (first one)
```

## License

Apache-2.0 — matches the rest of `tpsdev-ai`.
