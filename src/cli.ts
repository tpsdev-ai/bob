#!/usr/bin/env node
// Bob CLI — bob <subcommand> [args]
//
// PR-1 ships the surface stubs. Each subcommand prints what it WILL do
// in PR-2+ and exits 0. This is intentional: it gates K&S review on
// the type surface + role-template structure before we hand-roll the
// runtime.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Args,
  adoptAgent,
  type BobRole,
  boolFlag,
  DEFAULT_FLAIR_URL,
  describeProvisioning,
  down,
  formatReport,
  hireAgent,
  type InitResult,
  initAgent,
  installService,
  LaunchArgError,
  loadRole,
  MAIL_TURN_ENV,
  MAIL_TURN_PARENT_ENV,
  mailTurnParentPid,
  operatorSelectedFlairUrl,
  parseArgs,
  parseLaunchArgs,
  positionDiff,
  provisionFlairIdentity,
  readBlock,
  readMailTurnInput,
  restart,
  runAgent,
  runAlign,
  runDoctor,
  runLaunch,
  runLogin,
  runLogout,
  runMailTurnLaunch,
  runOnboard,
  runPersistent,
  servicePath,
  stringFlag,
  syncFlairSoul,
  takeFlairAdminPassFromEnv,
  UsageError,
  up,
  watchParent,
} from "./shell/index.js";

function help(): void {
  console.log(`Bob — moldable office-agent shell.

Usage: bob <command> [args]

Commands:
  onboard <name>      Hire a new Bob-shaped agent and form them into a role.
                      Registers the Flair Agent record and writes the persona
                      into the agent's Flair soul.
                      Flags: --context-window <tokens> (required: the model's
                             context window as the server enforces it)
                             --role <r> --provider <p> --model <m>
                             --flair-url <u> --no-flair
                             --admin-pass-file <path> --admin-user <user>
                             --dry-run --force --no-interactive
  align <name>        Recurring check-in to refine an existing agent. The session
                      runs on the agent's own bob.yaml provider + model (the same
                      pair 'bob run' uses); --provider / --model override just the
                      field each names. A --model needs its own window under
                      provider.models in bob.yaml, and bob.yaml declares windows
                      for its own provider only, so a --provider naming another
                      provider is refused. Mirrors the revised persona into Flair.
                      Flags: --provider <p> --model <m> --agent-dir <dir>
                             --flair-url <u> (required for Flair sync)
                             --admin-pass-file <path> --admin-user <user>
                             --no-flair
  run <name>          Run the agent PERSISTENTLY (on-duty) — one warm pi session
                      that stays up, loading bob.yaml capabilities (discord
                      gateway, cron). This is what the service unit runs.
  run <name> <prompt> Run ONE short-lived task (claude -p style) — minimal +
                      ephemeral, no gateway. Prints the response, exits.
                      Flags: --model <m>
  install-service <n> Write the agent's service unit (launchd on macOS / systemd
                      user unit on Linux) so it self-runs. Flags: --bob-bin <abs path> --model <m>
  up <name>           Load + start the agent's service unit
  down <name>         Stop + unload the agent's service unit
  restart <name>      Graceful restart (SIGTERM → clean session dispose → relaunch)
  doctor <name>       Health check of the agent's setup — prints each check
  login <name> [prov] Sign the agent in to a subscription provider (pi's
                      interactive /login) with the token kept in the agent's own
                      store. Run it in a terminal. Flags: --agents-root <dir>
  logout <name> [prov] The matching removal (pi's interactive /logout).
                      Flags: --agents-root <dir>
  hire <name>         Hire a NEW agent from a packaged position.
                      Flags: --as <position> --context-window <tokens> (required)
                             --provider <p> --model <m> --no-flair
  position adopt <n>  Bind an EXISTING agent to a position (--as <position>).
  position diff <n>   Show the ratified baseline vs the current effective config.
  launch <name>       The agent's session, with its resolved role tool
                      allowlist. This is what bin/<name> runs.
                      Takes at most ONE prompt (a multi-word one needs quotes).
                      No prompt opens the interactive TUI. Any other argument is
                      refused by name — a pi flag cannot be passed at all.
                      To send a prompt that starts with "-", use: launch <name> -- --tools
  help                Show this help

Roles: ea | jarvis | writer | reviewer | coder | qa | builder-local | custom

Flair: onboarding registers the agent as a Flair principal, which needs an admin
credential for the target instance — FLAIR_ADMIN_PASS in the environment, or the
0600 ~/.flair/admin-pass file 'flair init' writes. bob removes FLAIR_ADMIN_PASS
from its environment at startup and never passes it to an agent session. Soul
writes by onboard/align always read that file. --admin-pass-file overrides its
path; never pass the password itself as a flag. Use
--no-flair to scaffold an agent with no Flair identity at all.`);
}

// bob#214: `--context-window <tokens>` — the model's context window as the
// server enforces it, written to bob.yaml. A value that is not a positive whole
// number is refused, never rounded or defaulted.
function contextWindowFlag(
  flags: Record<string, string | boolean>,
  command: string,
): number | undefined {
  if (flags["context-window"] === undefined) return undefined;
  const raw = stringFlag(flags, "context-window");
  const n = raw !== undefined && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n)) {
    throw new UsageError(
      `${command}: --context-window must be a positive whole number of tokens (the context length the server enforces for the model)`,
    );
  }
  return n;
}

// bob#214: onboarding and hiring open a session (the hiring interview), and
// every session refuses to start without the model's context window. So `bob
// onboard` and `bob hire` REQUIRE the flag and refuse before anything is
// written — before the scaffold, the keypair and the Flair registration —
// rather than scaffold an agent whose interview cannot open. onboard's
// --dry-run refuses the same way, so its plan never shows a run that would fail.
function requireContextWindowFlag(
  flags: Record<string, string | boolean>,
  command: string,
  pair: string,
): number {
  const contextWindow = contextWindowFlag(flags, command);
  if (contextWindow === undefined) {
    throw new UsageError(
      `${command}: --context-window <tokens> is required — the context window the server enforces for ${pair}. bob writes it to bob.yaml as provider.context_window and refuses to start a session without it. Nothing was written.`,
    );
  }
  return contextWindow;
}

async function onboard(
  name: string,
  flags: Record<string, string | boolean>,
  adminPassFromEnv: string | undefined,
): Promise<void> {
  // Value flags go through stringFlag: a bare `--model`, or the empty
  // `--model=` form, means "not given" — the default applies — never the
  // literal id "true" or an empty id written into bob.yaml and models.json.
  const role = (stringFlag(flags, "role") ?? "custom") as BobRole;
  const provider = stringFlag(flags, "provider") ?? "ollama-cloud";
  const model = stringFlag(flags, "model") ?? "kimi-k2.6";
  const dryRun = boolFlag(flags, "dry-run");
  const force = boolFlag(flags, "force");
  const noInteractive = boolFlag(flags, "no-interactive");
  // --no-flair is an EXPLICIT opt-out, not a fallback. When Flair is in play
  // (the default) a missing admin credential FAILS the command; the way to
  // scaffold without an identity is to say so.
  const noFlair = boolFlag(flags, "no-flair");
  const flairUrl = stringFlag(flags, "flair-url") ?? DEFAULT_FLAIR_URL;
  const adminPassFile = stringFlag(flags, "admin-pass-file");
  const adminUser = stringFlag(flags, "admin-user");
  const contextWindow = requireContextWindowFlag(
    flags,
    `bob onboard ${name}`,
    `${provider}/${model}`,
  );

  if (dryRun) {
    const template = loadRole(role);
    console.log(`[bob onboard] PLAN (--dry-run):
  agent.id        = ${name}
  agent.role      = ${role}
  provider.name   = ${provider}
  provider.model  = ${model}
  provider.context_window = ${contextWindow}
  soul (from template, ${template.soul.length} chars) → ~/agents/${name}/soul.md
  tools.allow     = ${template.tools.allow.join(", ")}
  bin/launcher    → ~/agents/${name}/bin/${name}
  bob.yaml        → ~/agents/${name}/bob.yaml
  flair identity  = ${noFlair ? "SKIPPED (--no-flair)" : `Agent record + soul at ${flairUrl}`}
  interview       = ${noInteractive ? "SKIPPED (--no-interactive)" : "interactive pi session"}`);
    return;
  }

  const result = initAgent({
    name,
    role,
    provider,
    model,
    contextWindow,
    noClobber: !force,
    skipFlair: noFlair,
    flairUrl,
  });
  console.log(
    `[bob onboard] scaffolded ${name} — wrote ${result.files.length} files into ${result.agentDir}`,
  );
  for (const f of result.files) console.log(`  ${f}`);

  // Identity BEFORE persona (#93 then #94). Both are part of "onboarded" —
  // a keypair with no Agent record is a scaffold, not an agent.
  await provisionOnboard(result, {
    name,
    role,
    flairUrl,
    noFlair,
    adminPassFromEnv,
    adminPassFile,
    adminUser,
  });

  if (noInteractive) {
    console.log(`\nSkipped interview (--no-interactive). Edit ~/agents/${name}/soul.md by hand,`);
    console.log(
      `then run 'bob align ${name} --flair-url ${flairUrl}' to push the revised persona into Flair.`,
    );
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
    // The interview rewrote soul.md AFTER the first mirror, so Flair still
    // holds the seed template. Push again — otherwise the whole point of the
    // interview stops at the local file, which is #94 all over again.
    if (!noFlair && result.flairConfig) {
      const again = await syncFlairSoul({
        name,
        role,
        flairUrl: result.flairConfig.url,
        operatorFlairUrl: result.flairConfig.url,
        keyFile: result.flairConfig.keyPath,
        soulPath: outcome.soulPath,
        adminPassFile,
        adminUser,
      });
      console.log(`[bob onboard] Flair soul updated with the interviewed persona`);
      console.log(describeProvisioning(again));
    }
  } else {
    console.log(`[bob onboard] persona unchanged — ${outcome.soulPath} still the seed template.`);
    console.log(`Run 'bob align ${name} --flair-url ${flairUrl}' to try the interview again.`);
  }
}

// Register the Agent record + mirror the seed soul. Kept next to onboard()
// rather than inline so the "identity, then soul" order is one call, and so
// the --no-flair branch is the only way past it.
async function provisionOnboard(
  result: InitResult,
  opts: {
    name: string;
    role: string;
    flairUrl: string;
    noFlair: boolean;
    adminPassFromEnv: string | undefined;
    adminPassFile?: string;
    adminUser?: string;
  },
): Promise<void> {
  if (opts.noFlair) {
    console.log(
      `\n[bob onboard] --no-flair: no keypair, no Agent record, no soul in Flair.\n` +
        `  ${opts.name} will run with a local soul.md only. Register later with:\n` +
        `    flair agent add ${opts.name} && bob onboard ${opts.name} --force`,
    );
    return;
  }
  if (!result.flairConfig || !result.flair) {
    // Unreachable via the CLI (both are populated whenever skipFlair is
    // false), but an empty branch here would hide a future regression that
    // stops populating them — which is exactly the silent skip #93 is about.
    throw new Error(
      `bob onboard ${opts.name}: scaffold produced no Flair config; cannot register the identity.`,
    );
  }
  console.log(`\n[bob onboard] provisioning Flair identity for ${opts.name}…`);
  const provisioned = await provisionFlairIdentity({
    name: opts.name,
    role: opts.role,
    flairUrl: result.flairConfig.url,
    publicKeyBase64: result.flair.publicKeyBase64,
    keyFile: result.flairConfig.keyPath,
    soulPath: join(result.agentDir, "soul.md"),
    adminPassFromEnv: opts.adminPassFromEnv,
    adminPassFile: opts.adminPassFile,
    adminUser: opts.adminUser,
  });
  console.log(describeProvisioning(provisioned));
}

async function align(name: string, flags: Record<string, string | boolean>): Promise<void> {
  // #155 — the check-in runs on the agent's OWN provider and model, read from
  // its bob.yaml by runAlign. A flag replaces only the field it names, and it is
  // read the way `bob run` and `bob install-service` read one: a bare flag (no
  // value) means "not given", never the literal text "true".
  const provider = stringFlag(flags, "provider");
  const model = stringFlag(flags, "model");
  const agentDir = stringFlag(flags, "agent-dir") ?? `${process.env.HOME}/agents/${name}`;
  // Read every flag BEFORE the session starts: the check-in can rewrite
  // soul.md, so a bad --no-flair spelling must fail here, not after it.
  const noFlair = boolFlag(flags, "no-flair");
  const adminPassFile = stringFlag(flags, "admin-pass-file");
  const adminUser = stringFlag(flags, "admin-user");
  const operatorFlairUrl = stringFlag(flags, "flair-url");
  if (!noFlair) operatorSelectedFlairUrl(name, readFlairBlock(agentDir).url, operatorFlairUrl);

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

  // Mirror local → Flair whether or not the interview changed anything: an
  // unchanged soul.md can still differ from Flair (someone edited the file by
  // hand since the last align), and that divergence is the case worth
  // surfacing. syncFlairSoul verifies registration first, then uses the
  // operator password file for the Soul write.
  if (noFlair) return;
  // The same canonical tree the session ran from (bob#204), not a re-read of the
  // requested path.
  const flair = readFlairBlock(outcome.agentDir);
  const synced = await syncFlairSoul({
    name,
    role: readAgentRole(outcome.agentDir),
    flairUrl: flair.url,
    operatorFlairUrl: operatorFlairUrl ?? "",
    keyFile: flair.keyFile,
    soulPath: outcome.soulPath,
    adminPassFile,
    adminUser,
  });
  console.log(describeProvisioning(synced));
}

// Read the agent's `flair:` block from bob.yaml. Its URL is untrusted until
// syncFlairSoul compares it with the operator's --flair-url selection.
function readFlairBlock(agentDir: string): { url: string; agentId: string; keyFile: string } {
  const yamlPath = join(agentDir, "bob.yaml");
  const block = readBlock(readFileSync(yamlPath, "utf8"), "flair");
  const url = block?.url;
  const agentId = block?.agentId;
  const keyFile = block?.keyFile;
  if (typeof url !== "string" || typeof agentId !== "string" || typeof keyFile !== "string") {
    throw new Error(
      `${yamlPath}: the flair: block must carry url, agentId and keyFile. ` +
        `Re-run 'bob onboard <name> --force' to regenerate it.`,
    );
  }
  return { url, agentId, keyFile };
}

function readAgentRole(agentDir: string): string | undefined {
  const block = readBlock(readFileSync(join(agentDir, "bob.yaml"), "utf8"), "agent");
  return typeof block?.role === "string" ? block.role : undefined;
}

async function run(
  name: string,
  prompt: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const model = stringFlag(flags, "model");
  // The interactive REPL on the SDK lands in a later phase-1 PR.
  if (boolFlag(flags, "interactive")) {
    console.error(
      "bob run: --interactive is not yet supported on the embedded-SDK path (give a task prompt for now)",
    );
    return 2;
  }
  // Lifespan is the only knob (`serve` is retired): a task prompt = a MINIMAL
  // one-shot; NO prompt = the agent runs PERSISTENTLY (on-duty).
  if (prompt === undefined) {
    // PERSISTENT: one warm pi session that stays up, loading the agent's
    // bob.yaml capabilities (discord's inbound gateway, cron, …) and posting
    // back via them. This is what the service unit invokes. Blocks until
    // SIGTERM/SIGINT — runPersistent disposes the session gracefully (await
    // in-flight turn → dispose → exit 0); KeepAlive/Restart relaunches it.
    await runPersistent({ name, model });
    return 0;
  }
  // ONE-SHOT TASK (claude -p style) — minimal + ephemeral (no gateway; see
  // BOB_PERSISTENT in run.ts). captureStdout collects the assistant's final
  // text (runAgent is otherwise silent), so we print the response.
  const result = await runAgent({ name, prompt, model, captureStdout: true });
  if (result.stdout && result.stdout.trim().length > 0) {
    console.log(result.stdout);
  }
  return result.exitCode;
}

// `bob install-service <name>` — write the agent's service unit so it self-runs
// (KeepAlive + RunAtLoad). Does NOT start it — that's `bob up`. The unit runs
// bob under Node: `<interpreter> <bob> run <name>`, with the interpreter
// resolved at install time; it embeds NO secrets (the discord token is read
// from the file path in bob.yaml at runtime).
async function installServiceCmd(
  name: string,
  flags: Record<string, string | boolean>,
): Promise<number> {
  // launchd + systemd both use a minimal PATH, so the unit needs ABSOLUTE paths
  // to `bob` and to a Node interpreter. Default the bob path to this process's
  // own script; installService resolves the interpreter (or refuses the install
  // with a remedy when no Node is available).
  const bobBin = stringFlag(flags, "bob-bin") ?? (process.argv[1] || "bob");
  const model = stringFlag(flags, "model");
  const { path: written, argv } = await installService({ name, bobBin, model });
  console.log(`[bob install-service] wrote ${written}`);
  console.log(`  runs:    ${argv.join(" ")}`);
  console.log(`  next:    bob up ${name}   (load + start)`);
  if (bobBin === "bob") {
    console.error(
      "[bob install-service] WARNING: could not resolve an absolute bob path; the unit needs one.",
    );
    console.error("  Re-run with --bob-bin <absolute path to bob>.");
  }
  return 0;
}

async function upCmd(name: string): Promise<number> {
  await up({ name });
  console.log(`[bob up] loaded ${servicePath(name)} — agent ${name} is running`);
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

function usageError(err: unknown): number | undefined {
  if (err instanceof UsageError) {
    console.error(`bob: ${err.message}`);
    return 2;
  }
  return undefined;
}

// Render a position diff for `bob position diff`.
function formatPositionDiff(name: string, diff: import("./shell/index.js").PositionDiff): string {
  if (diff.empty) return `[bob position diff] ${name}: no drift from the ratified baseline.`;
  const lines: string[] = [`[bob position diff] ${name}: drift from the ratified baseline:`];
  if (diff.roleChanged) lines.push(`  role: changed`);
  for (const d of [
    ["tools added", diff.tools.added],
    ["tools removed", diff.tools.removed],
    ["tools excluded (added)", diff.excludeTools.added],
    ["tools excluded (removed)", diff.excludeTools.removed],
    ["capabilities added", diff.capabilities.added],
    ["capabilities removed", diff.capabilities.removed],
    ["files added", diff.files.added],
    ["files removed", diff.files.removed],
    ["files changed", diff.files.changed],
  ] as const) {
    if (d[1].length > 0) lines.push(`  ${d[0]}: ${d[1].join(", ")}`);
  }
  if (diff.residentChanged) lines.push(`  resident: changed`);
  if (diff.allowResidentShellChanged) lines.push(`  allowResidentShell: changed`);
  if (diff.soulChanged) lines.push(`  soul.md: changed`);
  return lines.join("\n");
}

async function main(): Promise<number> {
  // The operator password leaves the environment FIRST, before any command
  // runs: read once, deleted from process.env, and handed explicitly to the
  // one operator transport that uses it (onboard's registration), so no agent
  // session this process starts gets it through its environment. What this
  // does not cover is stated at takeFlairAdminPassFromEnv.
  const adminPassFromEnv = takeFlairAdminPassFromEnv();
  // parseArgs validates every declared boolean flag, so a bad spelling is a
  // usage error HERE — before any command runs — and never a stack trace.
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    const usage = usageError(err);
    if (usage !== undefined) return usage;
    throw err;
  }
  try {
    switch (args.command) {
      case "onboard": {
        const name = args.positional[0];
        if (!name) {
          console.error("bob onboard: missing <name>");
          return 2;
        }
        await onboard(name, args.flags, adminPassFromEnv);
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
        await onboard(name, args.flags, adminPassFromEnv);
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
      case "launch": {
        // At most one prompt, and nothing else: the whitelist is enforced in
        // parseLaunchArgs, which refuses any other argument BY NAME.
        try {
          const launch = parseLaunchArgs(args.positional, args.flags);
          // bob#200: the tps-mail consumer runs each mail as ONE turn through
          // this launcher, with the verified fields as JSON on STDIN. Mail-turn
          // mode takes no prompt argument and never opens the TUI.
          if (process.env[MAIL_TURN_ENV] === "1") {
            if (launch.prompt !== undefined) {
              console.error(
                "bob launch: a mail turn takes its input on stdin, never as an argument",
              );
              return 2;
            }
            // The consumer watchdog FIRST: before stdin is read, so a consumer
            // that is already gone is noticed now (see watchParent).
            const stopWatching = watchParent({
              expectedParentPid: mailTurnParentPid(process.env[MAIL_TURN_PARENT_ENV]),
            });
            try {
              let input: string;
              try {
                // fd 0 until EOF — never process.stdin (see readMailTurnInput).
                input = readMailTurnInput();
              } catch (err) {
                console.error(
                  `bob launch ${launch.name}: mail turn refused — ${err instanceof Error ? err.message : String(err)}`,
                );
                return 2;
              }
              return await runMailTurnLaunch({ name: launch.name, input });
            } finally {
              stopWatching();
            }
          }
          return await runLaunch(launch);
        } catch (err: unknown) {
          if (err instanceof LaunchArgError) {
            console.error(err.message);
            return 2;
          }
          throw err;
        }
      }
      case "install-service":
        if (!args.positional[0]) {
          console.error("bob install-service: missing <name>");
          return 2;
        }
        return await installServiceCmd(args.positional[0], args.flags);
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
      case "login": {
        const name = args.positional[0];
        if (!name) {
          console.error("bob login: missing <agent>");
          return 2;
        }
        const provider = args.positional[1];
        const agentsRoot = stringFlag(args.flags, "agents-root");
        try {
          return await runLogin({
            name,
            ...(provider !== undefined ? { provider } : {}),
            ...(agentsRoot !== undefined ? { agentsRoot } : {}),
          });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          return 1;
        }
      }
      case "logout": {
        const name = args.positional[0];
        if (!name) {
          console.error("bob logout: missing <agent>");
          return 2;
        }
        const provider = args.positional[1];
        const agentsRoot = stringFlag(args.flags, "agents-root");
        try {
          return await runLogout({
            name,
            ...(provider !== undefined ? { provider } : {}),
            ...(agentsRoot !== undefined ? { agentsRoot } : {}),
          });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          return 1;
        }
      }
      case "hire": {
        if (args.flags.flair !== undefined) {
          console.error("bob hire: --flair is not supported in slice 1");
          return 2;
        }
        const name = args.positional[0];
        const as = stringFlag(args.flags, "as");
        if (!name) {
          console.error("bob hire: missing <name>");
          return 2;
        }
        if (!as) {
          console.error("bob hire: missing --as <position>");
          return 2;
        }
        const provider = stringFlag(args.flags, "provider");
        const model = stringFlag(args.flags, "model");
        // bob#214: refused here as a usage error, before anything is written;
        // hireAgent refuses a missing window too, before its own first write.
        const contextWindow = requireContextWindowFlag(
          args.flags,
          `bob hire ${name}`,
          provider !== undefined && model !== undefined ? `${provider}/${model}` : "its model",
        );
        const result = await hireAgent({
          name,
          positionName: as,
          agentsRoot: stringFlag(args.flags, "agents-root") ?? `${process.env.HOME}/agents`,
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
          contextWindow,
          skipFlair: true,
        });
        console.log(`[bob hire] ${name} hired as position "${as}"`);
        console.log(`  agent dir:       ${result.agentDir}`);
        console.log(`  ratified role:   ${result.grant.role}`);
        console.log(
          `  position:        ${result.grant.position.name} ${result.grant.position.version} (${result.grant.position.hash.slice(0, 12)}…)`,
        );
        console.log(`  ratified tools:  ${result.grant.maxTools.join(", ") || "(none)"}`);
        console.log(`  ratified caps:   ${result.grant.maxCapabilities.join(", ") || "(none)"}`);
        console.log(`  override repo:   ${result.overrideDir}`);
        console.log(
          `  interview:       ${result.interview.soulUpdated ? "soul.md updated" : "soul.md unchanged"}`,
        );
        return 0;
      }
      case "position": {
        const sub = args.positional[0];
        const name = args.positional[1];
        if (sub === "diff") {
          if (!name) {
            console.error("bob position diff: missing <name>");
            return 2;
          }
          const diff = positionDiff({
            name,
            agentsRoot: stringFlag(args.flags, "agents-root") ?? `${process.env.HOME}/agents`,
          });
          console.log(formatPositionDiff(name, diff));
          return diff.empty ? 0 : 3;
        }
        if (sub === "adopt") {
          const as = stringFlag(args.flags, "as");
          if (!name) {
            console.error("bob position adopt: missing <name>");
            return 2;
          }
          if (!as) {
            console.error("bob position adopt: missing --as <position>");
            return 2;
          }
          const result = adoptAgent({
            name,
            positionName: as,
            agentsRoot: stringFlag(args.flags, "agents-root") ?? `${process.env.HOME}/agents`,
          });
          console.log(`[bob position adopt] ${name} bound to position "${as}"`);
          console.log(`  ratified role:   ${result.grant.role}`);
          console.log(
            `  position:        ${result.grant.position.name} ${result.grant.position.version}`,
          );
          console.log(
            `  config unchanged: ${result.diff.empty ? "yes (diff empty)" : "NO — diff is not empty"}`,
          );
          return 0;
        }
        console.error(
          `bob position: unknown subcommand '${sub ?? ""}'. Use 'position adopt <name> --as <position>' or 'position diff <name>'.`,
        );
        return 2;
      }
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
    const usage = usageError(err);
    if (usage !== undefined) return usage;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`bob: ${msg}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
