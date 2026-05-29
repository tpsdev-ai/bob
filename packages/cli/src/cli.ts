#!/usr/bin/env node
// Bob CLI — bob <subcommand> [args]
//
// PR-1 ships the surface stubs. Each subcommand prints what it WILL do
// in PR-2+ and exits 0. This is intentional: it gates K&S review on
// the type surface + role-template structure before we hand-roll the
// runtime.

import {
  type BobRole,
  down,
  formatReport,
  initAgent,
  installService,
  loadRole,
  plistPath,
  restart,
  runAgent,
  runAlign,
  runDoctor,
  runOnboard,
  runPersistent,
  up,
} from "@tpsdev-ai/bob-shell";

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
  console.log(`Bob — moldable office-agent shell.

Usage: bob <command> [args]

Commands:
  onboard <name>      Hire a new Bob-shaped agent and form them into a role
                      Flags: --role <r> --provider <p> --model <m>
                             --dry-run --force --no-interactive
  align <name>        Recurring check-in to refine an existing agent
                      Flags: --provider <p> --model <m> --agent-dir <dir>
  run <name> <prompt> Run one short-lived task for the named agent (embeds pi
                      via its SDK — fresh session, one prompt, exit)
                      Flags: --model <m>  (--interactive: coming in a later PR)
  serve <name>        Run the agent PERSISTENTLY — one warm pi session that stays
                      up, loading the agent's bob.yaml capabilities (incl. discord).
                      This is what the launchd unit runs. Flags: --model <m>
  install-service <n> Write the agent's launchd unit (KeepAlive + RunAtLoad) so it
                      self-runs. Flags: --bob-bin <abs path> --model <m>
  up <name>           Load + start the agent's launchd unit
  down <name>         Stop + unload the agent's launchd unit
  restart <name>      Graceful restart (SIGTERM → clean session dispose → relaunch)
  doctor <name>       Health check (identity, mail, channels, provider auth)
  office join <name>  Join an existing branch office
  help                Show this help

Roles: ea | writer | reviewer | coder | qa | custom`);
}

async function onboard(name: string, flags: Record<string, string | boolean>): Promise<void> {
  const role = (flags.role ?? "custom") as BobRole;
  const provider = String(flags.provider ?? "ollama-cloud");
  const model = String(flags.model ?? "kimi-k2.6");
  const dryRun = flags["dry-run"] === true;
  const force = flags.force === true;
  const noInteractive = flags["no-interactive"] === true;

  if (dryRun) {
    const template = loadRole(role);
    console.log(`[bob onboard] PLAN (--dry-run):
  agent.id        = ${name}
  agent.role      = ${role}
  provider.name   = ${provider}
  provider.model  = ${model}
  soul (from template, ${template.soul.length} chars) → ~/agents/${name}/soul.md
  tools.allow     = ${template.tools.allow.join(", ")}
  bin/launcher    → ~/agents/${name}/bin/${name}
  bob.yaml        → ~/agents/${name}/bob.yaml
  interview       = ${noInteractive ? "SKIPPED (--no-interactive)" : "interactive pi session"}`);
    return;
  }

  const result = initAgent({ name, role, provider, model, noClobber: !force });
  console.log(
    `[bob onboard] scaffolded ${name} — wrote ${result.files.length} files into ${result.agentDir}`,
  );
  for (const f of result.files) console.log(`  ${f}`);

  if (noInteractive) {
    console.log(`\nSkipped interview (--no-interactive). Edit ~/agents/${name}/soul.md by hand,`);
    console.log(`or run 'bob align ${name}' later to shape the persona conversationally.`);
    return;
  }

  console.log(`\n[bob onboard] starting hiring interview — pi session in ${result.agentDir}/work`);
  console.log(`When you're done, tell ${name} to ship it and exit the session (Ctrl-D).`);
  console.log("─".repeat(60));

  const outcome = await runOnboard({
    name,
    role,
    agentDir: result.agentDir,
    provider,
    model,
  });

  console.log("─".repeat(60));
  if (outcome.exitCode !== 0) {
    console.error(`[bob onboard] pi session exited with code ${outcome.exitCode}`);
  }
  if (outcome.soulUpdated) {
    console.log(`[bob onboard] persona updated — ${outcome.soulPath} rewritten`);
  } else {
    console.log(`[bob onboard] persona unchanged — ${outcome.soulPath} still the seed template.`);
    console.log(`Run 'bob align ${name}' to try the interview again.`);
  }
}

async function align(name: string, flags: Record<string, string | boolean>): Promise<void> {
  const provider = String(flags.provider ?? "ollama-cloud");
  const model = String(flags.model ?? "kimi-k2.6");
  const agentDir = String(flags["agent-dir"] ?? `${process.env.HOME}/agents/${name}`);

  console.log(`[bob align ${name}] starting alignment check — pi session in ${agentDir}/work`);
  console.log(`Tell ${name} to ship it when the persona update looks right, then exit (Ctrl-D).`);
  console.log("─".repeat(60));

  const outcome = await runAlign({ name, agentDir, provider, model });

  console.log("─".repeat(60));
  if (outcome.exitCode !== 0) {
    console.error(`[bob align] pi session exited with code ${outcome.exitCode}`);
  }
  if (outcome.soulUpdated) {
    console.log(`[bob align] persona updated — ${outcome.soulPath} rewritten`);
  } else {
    console.log(`[bob align] no drift surfaced — persona unchanged`);
  }
}

async function run(
  name: string,
  prompt: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const model = flags.model !== undefined && flags.model !== true ? String(flags.model) : undefined;
  // PR1 migrated `bob run` to pi's embedded SDK for the non-interactive prompt
  // path only. The interactive REPL on the SDK lands in a later phase-1 PR.
  if (flags.interactive === true) {
    console.error(
      "bob run: --interactive is not yet supported on the embedded-SDK path (use a prompt for now)",
    );
    return 2;
  }
  if (prompt === undefined) {
    console.error('bob run: a prompt is required, e.g. `bob run <name> "summarize my inbox"`');
    return 2;
  }
  const result = await runAgent({ name, prompt, model });
  return result.exitCode;
}

// `bob serve <name>` — run the agent PERSISTENTLY. ONE warm pi AgentSession that
// stays up, loading the agent's bob.yaml `capabilities:` (incl. discord, whose
// gateway listener feeds inbound messages via pi.sendUserMessage and routes
// replies back to the originating channel). This is the entrypoint the launchd
// unit runs. Discord is no longer a CLI flag — it's a declared capability.
//
// Blocks until SIGTERM/SIGINT, which runPersistent handles gracefully (await
// in-flight turn → session.dispose() → exit 0). KeepAlive relaunches it.
async function serve(name: string, flags: Record<string, string | boolean>): Promise<void> {
  const model = flags.model !== undefined && flags.model !== true ? String(flags.model) : undefined;
  await runPersistent({ name, model });
}

// `bob install-service <name>` — write the agent's launchd plist so it self-runs
// (KeepAlive + RunAtLoad). Does NOT start it — that's `bob up`. The plist runs
// `bob serve <name>`; it embeds NO secrets (the discord token is read from the
// file path in bob.yaml at runtime).
function installServiceCmd(name: string, flags: Record<string, string | boolean>): number {
  // launchd uses a minimal PATH, so the unit needs an absolute path to `bob`.
  // Default to the current executable's path when not overridden.
  const bobBin =
    flags["bob-bin"] !== undefined && flags["bob-bin"] !== true
      ? String(flags["bob-bin"])
      : process.argv[1] || "bob";
  const model = flags.model !== undefined && flags.model !== true ? String(flags.model) : undefined;
  const { plistPath: written } = installService({ name, bobBin, model });
  console.log(`[bob install-service] wrote ${written}`);
  console.log(`  runs:    ${bobBin} serve ${name}`);
  console.log(`  next:    bob up ${name}   (load + start)`);
  if (bobBin === "bob") {
    console.error(
      "[bob install-service] WARNING: could not resolve an absolute bob path; launchd needs one.",
    );
    console.error("  Re-run with --bob-bin <absolute path to bob>.");
  }
  return 0;
}

async function upCmd(name: string): Promise<number> {
  await up({ name });
  console.log(`[bob up] loaded ${plistPath(name)} — agent ${name} is running`);
  return 0;
}

async function downCmd(name: string): Promise<number> {
  await down({ name });
  console.log(`[bob down] unloaded ${name}`);
  return 0;
}

async function restartCmd(name: string): Promise<number> {
  await restart({ name });
  console.log(`[bob restart] graceful restart sent to ${name} (SIGTERM → dispose → relaunch)`);
  return 0;
}

function doctor(name: string): number {
  const report = runDoctor({ name });
  console.log(formatReport(report));
  return report.summary.fail > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
      case "onboard": {
        const name = args.positional[0];
        if (!name) {
          console.error("bob onboard: missing <name>");
          return 2;
        }
        await onboard(name, args.flags);
        return 0;
      }
      case "align": {
        const name = args.positional[0];
        if (!name) {
          console.error("bob align: missing <name>");
          return 2;
        }
        await align(name, args.flags);
        return 0;
      }
      case "init": {
        const name = args.positional[0];
        if (!name) {
          console.error("bob init: missing <name> (note: `bob init` is now `bob onboard`)");
          return 2;
        }
        console.error("bob init: renamed to `bob onboard`. Forwarding…");
        await onboard(name, args.flags);
        return 0;
      }
      case "run": {
        if (!args.positional[0]) {
          console.error("bob run: missing <name>");
          return 2;
        }
        const prompt = args.positional.slice(1).join(" ") || undefined;
        return await run(args.positional[0], prompt, args.flags);
      }
      case "serve":
        if (!args.positional[0]) {
          console.error("bob serve: missing <name>");
          return 2;
        }
        await serve(args.positional[0], args.flags);
        return 0;
      case "install-service":
        if (!args.positional[0]) {
          console.error("bob install-service: missing <name>");
          return 2;
        }
        return installServiceCmd(args.positional[0], args.flags);
      case "up":
        if (!args.positional[0]) {
          console.error("bob up: missing <name>");
          return 2;
        }
        return await upCmd(args.positional[0]);
      case "down":
        if (!args.positional[0]) {
          console.error("bob down: missing <name>");
          return 2;
        }
        return await downCmd(args.positional[0]);
      case "restart":
        if (!args.positional[0]) {
          console.error("bob restart: missing <name>");
          return 2;
        }
        return await restartCmd(args.positional[0]);
      case "doctor":
        if (!args.positional[0]) {
          console.error("bob doctor: missing <name>");
          return 2;
        }
        return doctor(args.positional[0]);
      case "help":
      case "--help":
      case "-h":
        help();
        return 0;
      default:
        console.error(`bob: unknown command '${args.command}'. Run 'bob help'.`);
        return 2;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`bob: ${msg}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
