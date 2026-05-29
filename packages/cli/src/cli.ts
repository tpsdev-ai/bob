#!/usr/bin/env node
// Bob CLI — bob <subcommand> [args]
//
// PR-1 ships the surface stubs. Each subcommand prints what it WILL do
// in PR-2+ and exits 0. This is intentional: it gates K&S review on
// the type surface + role-template structure before we hand-roll the
// runtime.

import {
  type BobRole,
  formatReport,
  initAgent,
  loadRole,
  MailConsumer,
  runAgent,
  runAlign,
  runDoctor,
  runOnboard,
  startDiscordListener,
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
  serve <name>        Run mail watcher (+ optional Discord listener) as a daemon
                      Flags: --discord --discord-token-file <path>
                             --discord-channels <id1,id2> [--discord-dispatch-all]
                             [--discord-model <model>]
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

async function serve(name: string, flags: Record<string, string | boolean>): Promise<void> {
  const consumer = new MailConsumer({ name });
  consumer.start();
  console.log(`[bob serve] mail consumer running for ${name}`);
  console.log(`  inbox:    ~/.tps/mail/${name}/`);
  console.log(`  launcher: ~/agents/${name}/bin/${name}`);
  console.log(`  poll:     2s · processed:0 failed:0`);

  // Optional Discord listener — when --discord flag is set, also start
  // a gateway connection and dispatch incoming messages through runAgent.
  // Requires --discord-token-file and --discord-channels.
  let discordBridge: { stop: () => Promise<void>; stats: object } | undefined;
  if (flags.discord === true) {
    const tokenFile = String(flags["discord-token-file"] ?? "");
    const channels = String(flags["discord-channels"] ?? "");
    if (!tokenFile || !channels) {
      console.error("[bob serve] --discord requires --discord-token-file and --discord-channels");
      consumer.stop();
      process.exit(2);
    }
    discordBridge = await startDiscordOrExit({
      agentName: name,
      tokenFile,
      channelsCsv: channels,
      dispatchAll: flags["discord-dispatch-all"] === true,
      model:
        flags["discord-model"] !== undefined && flags["discord-model"] !== true
          ? String(flags["discord-model"])
          : undefined,
    });
    console.log(`[bob serve] discord listener running`);
    console.log(`  channels: ${channels}`);
    console.log(
      `  filter:   ${flags["discord-dispatch-all"] === true ? "all messages" : "mentions only"}`,
    );
  }

  console.log(`\nCtrl-C to stop.`);

  // Keep the event loop alive
  const shutdown = async () => {
    console.log(
      `\n[bob serve] stopping; mail stats: ${JSON.stringify(consumer.stats)}${
        discordBridge ? `; discord stats: ${JSON.stringify(discordBridge.stats)}` : ""
      }`,
    );
    consumer.stop();
    if (discordBridge) await discordBridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

// Pulled out as a helper so serve() stays linear-readable and the
// dynamic import + error handling lives in one place.
async function startDiscordOrExit(args: {
  agentName: string;
  tokenFile: string;
  channelsCsv: string;
  dispatchAll: boolean;
  model: string | undefined;
}): Promise<{ stop: () => Promise<void>; stats: object }> {
  const fs = await import("node:fs");
  if (!fs.existsSync(args.tokenFile)) {
    console.error(`[bob serve] discord token file not found: ${args.tokenFile}`);
    process.exit(3);
  }
  const token = fs.readFileSync(args.tokenFile, "utf8").trim();
  if (!token) {
    console.error(`[bob serve] discord token file is empty: ${args.tokenFile}`);
    process.exit(3);
  }
  const listenChannelIds = args.channelsCsv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (listenChannelIds.length === 0) {
    console.error(`[bob serve] --discord-channels parsed to zero channels`);
    process.exit(3);
  }
  // discord-js binding lives in @tpsdev-ai/bob-discord — import dynamically
  // so callers without Discord don't have to install discord.js (~30MB).
  const { DiscordJsClient } = await import("@tpsdev-ai/bob-discord");
  const client = new DiscordJsClient({ token });
  return startDiscordListener({
    agentName: args.agentName,
    listenChannelIds,
    client,
    dispatchAll: args.dispatchAll,
    model: args.model,
  });
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
