#!/usr/bin/env node
// Milton CLI — milton <subcommand> [args]
//
// PR-1 ships the surface stubs. Each subcommand prints what it WILL do
// in PR-2+ and exits 0. This is intentional: it gates K&S review on
// the type surface + role-template structure before we hand-roll the
// runtime.

import { loadRole, type MiltonRole } from "@tpsdev-ai/milton-shell";

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(tok);
    }
  }
  return { command, positional, flags };
}

function help(): void {
  console.log(`Milton — moldable office-agent shell.

Usage: milton <command> [args]

Commands:
  init <name>         Bootstrap a new Milton-shaped agent
                      Flags: --role <r> --provider <p> --model <m>
  run <name> [prompt] Run one session for the named agent
  serve <name>        Run mail watcher + cron loop as a daemon
  doctor <name>       Health check (identity, mail, channels, provider auth)
  office join <name>  Join an existing branch office
  help                Show this help

Roles: ea | writer | reviewer | coder | qa | custom`);
}

function init(name: string, flags: Record<string, string | boolean>): void {
  const role = (flags.role ?? "custom") as MiltonRole;
  const provider = flags.provider ?? "ollama-cloud";
  const model = flags.model ?? "kimi-k2.6";
  // Validate role exists before we promise the user a working init
  const template = loadRole(role);
  console.log(`[milton init] PLAN (PR-1 stub — actual writes ship in PR-2):
  agent.id        = ${name}
  agent.role      = ${role}
  provider.name   = ${provider}
  provider.model  = ${model}
  soul (from template, ${template.soul.length} chars) → ~/agents/${name}/soul.md
  tools.allow     = ${template.tools.allow.join(", ")}
  bin/launcher    → ~/agents/${name}/bin/${name}
  milton.yaml     → ~/agents/${name}/milton.yaml
  Flair pair      → register Ed25519 key + Agent record
  TPS mail inbox  → ~/.tps/mail/${name}/`);
}

function run(name: string, prompt?: string): void {
  console.log(`[milton run] PR-1 stub — would invoke pi-coding-agent for ${name}${prompt ? ` with prompt: ${prompt}` : " (interactive)"}`);
}

function serve(name: string): void {
  console.log(`[milton serve] PR-1 stub — would start mail watcher + cron loop for ${name}`);
}

function doctor(name: string): void {
  console.log(`[milton doctor] PR-1 stub — would check identity, mail, channels, provider auth for ${name}`);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
      case "init": {
        const name = args.positional[0];
        if (!name) { console.error("milton init: missing <name>"); return 2; }
        init(name, args.flags);
        return 0;
      }
      case "run":
        if (!args.positional[0]) { console.error("milton run: missing <name>"); return 2; }
        run(args.positional[0], args.positional.slice(1).join(" ") || undefined);
        return 0;
      case "serve":
        if (!args.positional[0]) { console.error("milton serve: missing <name>"); return 2; }
        serve(args.positional[0]);
        return 0;
      case "doctor":
        if (!args.positional[0]) { console.error("milton doctor: missing <name>"); return 2; }
        doctor(args.positional[0]);
        return 0;
      case "help":
      case "--help":
      case "-h":
        help();
        return 0;
      default:
        console.error(`milton: unknown command '${args.command}'. Run 'milton help'.`);
        return 2;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`milton: ${msg}`);
    return 1;
  }
}

process.exit(main());
