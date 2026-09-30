// `bob doctor <name>` — health check for an onboarded agent.
//
// Walks the expected per-agent layout + checks each piece. Output is
// per-check status + an actionable fix-hint when something's wrong, so
// when Pulse breaks at 4pm, `bob doctor pulse` tells you why in 10
// seconds, not 10 minutes of grep.
//
// PR-1 shipped this as a stub. PR-22 makes it real.
//
// Checks (all soft — doctor never modifies state):
//   - agent dir, soul.md, bob.yaml, launcher (exists + perms)
//   - Ed25519 keypair (private 0600, public exists)
//   - .pi-agent/auth.json + models.json (PR-16a wrote these when
//     provider was exe-dev-gateway)
//   - provider.context_window (bob#225): FAILS when bob.yaml declares no
//     context window, because a session refuses to start without one — doctor
//     says so first, with the exact line to add
//   - TPS mail inbox dir + new/cur counts
//   - Discord token file (if path-hint exists)
//   - tps-mail (bob#200): FAILS when channels.tps_mail is declared with no
//     capability to honour it, when the capability's config is invalid (an
//     empty senders allow-list above all), when the agent has no Flair identity,
//     when the inbox is missing, when this host is not a TPS delivery target
//     (#134), when the reply transport (the tps CLI, the signing key) is
//     missing, or when the tps CLI on PATH does not take the reply contract
//     (`mail send --stdin --reply-to`); and surfaces refused counts per reason,
//     dispatch failures and reply failures.

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  expandHome,
  TPS_MAIL_CAPABILITY,
  type TpsMailCapabilityConfig,
  validateTpsMailConfig,
} from "../capabilities/tps-mail/config.js";
import { REFUSAL_REASONS } from "../capabilities/tps-mail/envelope.js";
import {
  type ProviderLimitsBlock,
  readAgentRole,
  readBlock,
  readCapabilities,
  readProviderLimits,
  readResident,
  readTools,
  type ToolsBlock,
} from "./bob-yaml.js";
import { readTpsMailIdentity, type TpsMailIdentity, tpsMailStatsPath } from "./mail-consumer.js";
import { effectiveCapabilities, resolveAgentToolPolicy } from "./run.js";
import {
  auditToolNames,
  capabilityForTool,
  residentDroppedTools,
  type ToolPolicy,
} from "./tool-allowlist.js";

const AGENT_NAME = /^[a-z0-9-]+$/;

export type CheckStatus = "ok" | "fail" | "skip" | "warn";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
  // Single-line hint a user can act on. Omitted for OK/SKIP.
  fix?: string;
}

export interface DoctorReport {
  agent: string;
  agentDir: string;
  checks: DoctorCheck[];
  summary: {
    ok: number;
    fail: number;
    skip: number;
    warn: number;
  };
}

export interface DoctorOptions {
  name: string;
  agentsRoot?: string;
  flairKeysDir?: string;
  // Override for tests. Defaults to process.env.HOME.
  homeDir?: string;
  // PATH searched for the tps CLI (tests). Defaults to process.env.PATH.
  pathEnv?: string;
  // Wall-clock bound on the tps reply-contract probe (tests). Default 10 s.
  tpsProbeTimeoutMs?: number;
  // Position grant store + positions root, as the runtime resolves them (tests).
  // Default: <home>/.bob/host and bob's packaged positions.
  hostRoot?: string;
  positionsRoot?: string;
}

export function runDoctor(opts: DoctorOptions): DoctorReport {
  if (!AGENT_NAME.test(opts.name)) {
    throw new Error(`invalid agent name: ${JSON.stringify(opts.name)} (must match ${AGENT_NAME})`);
  }
  const home = opts.homeDir ?? homedir();
  const agentsRoot = opts.agentsRoot ?? join(home, "agents");
  const flairKeysDir = opts.flairKeysDir ?? join(home, ".flair", "keys");
  const agentDir = join(agentsRoot, opts.name);

  const checks: DoctorCheck[] = [];

  // Agent dir — root of everything else. If missing, everything else is moot.
  if (!existsSync(agentDir)) {
    checks.push({
      name: "agent dir",
      status: "fail",
      detail: agentDir,
      fix: `run 'bob onboard ${opts.name} --role <role>' to scaffold`,
    });
    return finalize(opts.name, agentDir, checks);
  }
  checks.push({ name: "agent dir", status: "ok", detail: agentDir });

  // soul.md
  checks.push(
    fileCheck("soul.md", join(agentDir, "soul.md"), {
      onMissing: `re-onboard or copy a role template to ${join(agentDir, "soul.md")}`,
    }),
  );

  // bob.yaml
  checks.push(
    fileCheck("bob.yaml", join(agentDir, "bob.yaml"), {
      onMissing: `re-run 'bob onboard ${opts.name} --force'`,
    }),
  );

  // The role's tool allowlist. pi ignores an unknown tool name SILENTLY, so a
  // bob.yaml carrying a name pi cannot enable (the OpenClaw-era casings bob
  // used to stamp) leaves the agent without a tool its role asked for and says
  // nothing. Report every offender with the fix.
  checks.push(toolAllowlistCheck(join(agentDir, "bob.yaml")));

  // bob#225 (item 4): the model's context window. A session REFUSES to start
  // without it (bob does not guess a window — a guess can disagree with the
  // server), and the refusal fires at session creation. Report it here first,
  // with the exact line to add, so it is heard from doctor and not from a
  // failed run.
  checks.push(contextWindowCheck(join(agentDir, "bob.yaml")));

  // Launcher — exists + executable
  const launcherPath = join(agentDir, "bin", opts.name);
  if (!existsSync(launcherPath)) {
    checks.push({
      name: "launcher",
      status: "fail",
      detail: launcherPath,
      fix: `re-run 'bob onboard ${opts.name} --force'`,
    });
  } else {
    const mode = statSync(launcherPath).mode & 0o777;
    if ((mode & 0o111) === 0) {
      checks.push({
        name: "launcher",
        status: "fail",
        detail: `${launcherPath} not executable (mode ${mode.toString(8).padStart(3, "0")})`,
        fix: `chmod +x ${launcherPath}`,
      });
    } else {
      checks.push({
        name: "launcher",
        status: "ok",
        detail: `${launcherPath} mode ${mode.toString(8).padStart(3, "0")}`,
      });
    }
  }

  // Ed25519 private key (mode 0600)
  const privKey = join(flairKeysDir, `${opts.name}.key`);
  if (!existsSync(privKey)) {
    checks.push({
      name: "Ed25519 private key",
      status: "fail",
      detail: privKey,
      fix: `re-run 'bob onboard ${opts.name} --force' to regenerate`,
    });
  } else {
    const mode = statSync(privKey).mode & 0o777;
    if (mode !== 0o600) {
      checks.push({
        name: "Ed25519 private key",
        status: "warn",
        detail: `mode ${mode.toString(8).padStart(3, "0")} (should be 600)`,
        fix: `chmod 600 ${privKey}`,
      });
    } else {
      checks.push({ name: "Ed25519 private key", status: "ok", detail: "mode 600" });
    }
  }

  // Ed25519 public key
  checks.push(
    fileCheck("Ed25519 public key", join(flairKeysDir, `${opts.name}.pub`), {
      onMissing: `re-run 'bob onboard ${opts.name} --force'`,
    }),
  );

  // pi-agent auth + models (PR-16a wrote these for exe-dev-gateway provider).
  // If the agent uses a different provider, these files may legitimately
  // not exist — soft check (warn, not fail).
  const piAuth = join(agentDir, ".pi-agent", "auth.json");
  if (existsSync(piAuth)) {
    const mode = statSync(piAuth).mode & 0o777;
    if (mode !== 0o600) {
      checks.push({
        name: "pi auth.json",
        status: "warn",
        detail: `mode ${mode.toString(8).padStart(3, "0")} (should be 600 — contains API key)`,
        fix: `chmod 600 ${piAuth}`,
      });
    } else {
      checks.push({ name: "pi auth.json", status: "ok", detail: "mode 600" });
    }
  } else {
    checks.push({
      name: "pi auth.json",
      status: "skip",
      detail: "not present — fine if you're using a provider that doesn't need it",
    });
  }

  const piModels = join(agentDir, ".pi-agent", "models.json");
  checks.push({
    name: "pi models.json",
    status: existsSync(piModels) ? "ok" : "skip",
    detail: existsSync(piModels)
      ? "present"
      : "not present — fine if using a provider without custom routing",
  });

  // bob#200: the tps-mail capability. When it is declared its own checks cover
  // the inbox, so the generic inbox check below runs only for an agent without it.
  let yamlText: string | undefined;
  try {
    yamlText = readFileSync(join(agentDir, "bob.yaml"), "utf8");
  } catch {
    yamlText = undefined;
  }
  const mail = tpsMailChecks({
    name: opts.name,
    yamlText,
    home,
    flairKeysDir,
    pathEnv: opts.pathEnv ?? process.env.PATH ?? "",
    tpsProbeTimeoutMs: opts.tpsProbeTimeoutMs ?? TPS_PROBE_TIMEOUT_MS,
    agentDir,
    hostRoot: opts.hostRoot ?? join(home, ".bob", "host"),
    positionsRoot: opts.positionsRoot,
  });
  if (mail.declared) {
    checks.push(...mail.checks);
    return finalize(opts.name, agentDir, checks);
  }
  checks.push(...mail.checks);

  // TPS mail inbox
  const mailDir = join(home, ".tps", "mail", opts.name);
  const newDir = join(mailDir, "new");
  const curDir = join(mailDir, "cur");
  if (!existsSync(mailDir)) {
    checks.push({
      name: "TPS mail inbox",
      status: "warn",
      detail: `${mailDir} not present`,
      fix: `mkdir -p ${newDir} ${curDir}; tps mail provisions on first send`,
    });
  } else {
    const newCount = countFiles(newDir);
    const curCount = countFiles(curDir);
    checks.push({
      name: "TPS mail inbox",
      status: "ok",
      detail: `${mailDir} (new=${newCount} cur=${curCount})`,
    });
  }

  return finalize(opts.name, agentDir, checks);
}

// bob#230: the capabilities that open an INBOUND chat surface. Each is served
// only by the persistent runtime (discord's gateway opens under BOB_PERSISTENT;
// the tps-mail consumer is started by startPersistent).
const INBOUND_CHAT_CAPABILITIES: ReadonlySet<string> = new Set(["discord", "tps-mail"]);

// The `tools:` allowlist check. Audits every name in the agent's bob.yaml
// against the tools pi and the blessed capabilities can actually enable, and
// reports a resident agent whose allowlist asks for a tool the resident policy
// drops. NEVER throws: a malformed block or a bad `resident:` value is a FAIL
// with a fix, not a doctor crash (doctor is what you run when something is
// wrong).
// bob#225 (item 4): the declared context window. Every session refuses to start
// without one (requireModelLimits), so doctor reports the SAME problem early,
// naming the exact line to add. Read through the module the resolver reads
// (readProviderLimits) so doctor and a session agree on what is declared.
function contextWindowCheck(yamlPath: string): DoctorCheck {
  const name = "provider.context_window";
  let yamlText: string;
  try {
    yamlText = readFileSync(yamlPath, "utf8");
  } catch {
    return { name, status: "skip", detail: `${yamlPath} unreadable` };
  }

  let block: ProviderLimitsBlock;
  let providerBlock: Record<string, unknown> | undefined;
  try {
    block = readProviderLimits(yamlText);
    providerBlock = readBlock(yamlText, "provider");
  } catch (err) {
    return {
      name,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "fix the shape of the provider: block in bob.yaml",
    };
  }

  const model = providerBlock?.model;
  const forModel = typeof model === "string" && model !== "" ? ` for ${model}` : "";
  if (block.contextWindow !== undefined) {
    return { name, status: "ok", detail: `context_window: ${block.contextWindow}${forModel}` };
  }
  if (typeof model !== "string" || model === "") {
    // No provider.model to key a window to: a session refuses a bob.yaml that
    // declares no provider pair for THAT reason, before any window is read.
    return { name, status: "skip", detail: "no provider.model declared" };
  }
  return {
    name,
    status: "fail",
    detail:
      providerBlock === undefined
        ? "no provider: block in bob.yaml — a session refuses to start without the model's context window"
        : `provider.context_window is not declared${forModel} — a session refuses to start without the model's context window`,
    fix: `add "context_window: <tokens>" under "provider:" in ${yamlPath}`,
  };
}

function toolAllowlistCheck(yamlPath: string): DoctorCheck {
  const name = "tool allowlist";
  let yamlText: string;
  try {
    yamlText = readFileSync(yamlPath, "utf8");
  } catch {
    return { name, status: "skip", detail: `${yamlPath} unreadable` };
  }

  let block: ToolsBlock | undefined;
  try {
    block = readTools(yamlText);
  } catch (err) {
    return {
      name,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "fix the shape of the tools: block in bob.yaml",
    };
  }

  // Audit the names before resolving so EVERY offender gets its own fix, rather
  // than the resolver's single throw.
  const declared = [...(block?.allow ?? []), ...(block?.exclude ?? [])];
  const problems = auditToolNames(declared).problems;
  if (problems.length > 0) {
    return {
      name,
      status: "fail",
      detail: `unmapped tool name${problems.length === 1 ? "" : "s"}: ${problems
        .map((p) => p.name)
        .join(", ")}`,
      fix: problems.map((p) => `${p.name}: ${p.hint}`).join("; "),
    };
  }

  try {
    // Validation only — the policy below re-reads it. A non-boolean value is a
    // FAIL with a fix saying so (rather than the resolver's generic hint).
    readResident(yamlText);
  } catch (err) {
    return {
      name,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "set resident: true or false in bob.yaml",
    };
  }

  if (block?.allow === undefined) {
    // A missing policy is a FAIL, not an "ok, pi's defaults apply": pi's
    // defaults are not something bob.yaml decided, they are the absence of a
    // decision — and a session started on them holds whatever pi ships.
    return {
      name,
      status: "fail",
      detail:
        block === undefined
          ? "no tools: block in bob.yaml — the role's allowlist is missing"
          : "the tools: block declares no allow: list",
      fix: 'declare the role\'s allowlist: "tools:" with "allow:" (an explicit empty list means no tools)',
    };
  }

  // The FULL resolution — role.json as the ceiling, bob.yaml narrowing it, the
  // resident policy on top — i.e. the same call every launch path makes. So
  // doctor fails on exactly what a session would refuse: an allowlist that
  // widens past the role, a role bob cannot read, a name pi cannot enable.
  let policy: ToolPolicy;
  try {
    policy = resolveAgentToolPolicy(yamlText);
  } catch (err) {
    return {
      name,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "fix the tools: block (or the agent.role it widens past) in bob.yaml",
    };
  }
  // A name can be real in bob's catalog and still not exist for THIS agent: pi
  // enables only the tools the loaded capabilities register, and the session
  // REFUSES an allowlisted name that nothing provides, at load. Report that
  // here, before any session, naming the capability to declare — otherwise
  // doctor says OK for a config whose next run fails.
  //
  // BEFORE the resident-drop warning below: a resident agent can trip both, and
  // the missing capability is the FAILURE (it stops the session) while the drop
  // is a warning. Reporting the warning first would bury it. And a name the
  // denylist removes is absent ON PURPOSE — the session audit skips those, so
  // this check must too, or a valid narrowed policy fails doctor.
  const declaredCapabilities = new Set(readCapabilities(yamlText));
  const excludedTools = new Set(policy.excludeTools);
  const missingByCapability = new Map<string, string[]>();
  for (const tool of policy.tools) {
    if (excludedTools.has(tool)) continue;
    const capability = capabilityForTool(tool);
    if (capability === undefined || declaredCapabilities.has(capability)) continue;
    const names = missingByCapability.get(capability) ?? [];
    names.push(tool);
    missingByCapability.set(capability, names);
  }
  if (missingByCapability.size > 0) {
    const summary = [...missingByCapability]
      .map(([capability, tools]) => `${capability} (${tools.join(", ")})`)
      .join(", ");
    return {
      name,
      status: "fail",
      detail: `allowlisted tool${policy.tools.length === 1 ? "" : "s"} from a capability this agent does not declare: ${summary}`,
      fix: `declare it in bob.yaml (capabilities:) and configure its block — a session refuses an allowlisted tool nothing provides — or drop ${[...missingByCapability.values()].flat().join(", ")} from tools.allow`,
    };
  }

  // bob#230: judge residency as the SERVICE runs it. An inbound chat surface
  // (discord's gateway, the tps-mail consumer) is served only by the persistent
  // runtime, and the persistent runtime is resident whether or not bob.yaml
  // says `resident: true` (persistent.ts resolves with persistent: true). So a
  // chat-facing agent is checked against the policy its service holds.
  const chat = [...declaredCapabilities].filter((c) => INBOUND_CHAT_CAPABILITIES.has(c));
  const persistentService = chat.length > 0 && !policy.resident;
  let servicePolicy = policy;
  if (persistentService) {
    try {
      servicePolicy = resolveAgentToolPolicy(yamlText, { persistent: true });
    } catch (err) {
      return {
        name,
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        fix: "fix the tools: block (or the agent.role it widens past) in bob.yaml",
      };
    }
  }
  const residency = persistentService
    ? `the persistent service (resident by definition; it serves ${chat.join(", ")})`
    : "resident: true";

  // Every warning that applies is reported — none returns before another is
  // checked, so a dropped writer tool cannot hide the read-and-chat warning.
  const warnings: Array<{ detail: string; fix: string }> = [];

  const dropped = residentDroppedTools(servicePolicy);
  if (dropped.length > 0) {
    // The grant lives in the ROLE (roles/<role>/role.json), not in bob.yaml:
    // bob.yaml may only narrow the role's list, so setting
    // tools.allowResidentShell: true there would widen past the role and be
    // refused at load. Name the file the permission is actually in — and when
    // bob.yaml ALSO carries an explicit denial, name it too: the resolver keeps
    // the agent's explicit `false`, so granting it in the role alone would
    // still leave the tools dropped.
    const role = readAgentRole(yamlText) ?? "<role>";
    const denial = block.allowResidentShell === false;
    warnings.push({
      detail: `${residency} drops ${dropped.join(", ")}, which the role allows`,
      fix: denial
        ? `grant it in roles/${role}/role.json (tools.allowResidentShell: true) AND remove tools.allowResidentShell: false from bob.yaml — the grant lives in the role, and bob.yaml may only narrow it, but the explicit false in bob.yaml denies the grant even once the role gives it — or drop ${dropped.join(", ")} from tools.allow`
        : `set tools.allowResidentShell: true in roles/${role}/role.json — the grant lives in the role, and bob.yaml may only narrow the role, so it cannot grant this — or drop ${dropped.join(", ")} from tools.allow`,
    });
  }

  // bob#230: a resident agent that holds `read` alongside an inbound chat
  // surface (discord, tps-mail) keeps a file-read reach while it answers mail or
  // channel messages. read is now confined to the workspace and refuses the
  // agent's credentials, but a chat-facing resident role rarely needs any
  // file-read reach — warn so keeping it is a decision, not an accident.
  if (
    servicePolicy.resident &&
    chat.length > 0 &&
    servicePolicy.tools.includes("read") &&
    !servicePolicy.excludeTools.includes("read")
  ) {
    warnings.push({
      detail: `${residency} holds read alongside an inbound chat capability (${chat.join(", ")}); read is confined to the workspace, but a chat-facing resident role usually needs no file-read reach`,
      fix: `drop read from tools.allow, or remove the chat capability (${chat.join(", ")})`,
    });
  }

  if (warnings.length > 0) {
    return {
      name,
      status: "warn",
      detail: warnings.map((w) => w.detail).join("; AND "),
      fix: warnings.map((w) => w.fix).join("; AND "),
    };
  }

  return {
    name,
    status: "ok",
    detail: `${block.allow.length} name${block.allow.length === 1 ? "" : "s"}: ${block.allow.join(", ")}`,
  };
}

// ─── tps-mail (bob#200) ─────────────────────────────────────────────────────

// Does bob.yaml carry the legacy `channels: tps_mail:` block onboard used to
// scaffold? Nothing reads it, so an agent carrying it LOOKS mail-capable.
function declaresLegacyTpsMailChannel(yamlText: string): boolean {
  let inChannels = false;
  for (const line of yamlText.split(/\r?\n/)) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
      inChannels = /^channels\s*:/.test(line);
      continue;
    }
    if (inChannels && /^\s+tps_mail\s*:/.test(line)) return true;
  }
  return false;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Is this host somewhere TPS delivers mail to (#134)? A joined branch holds the
// office's host record (identity/host.json, written by `tps branch init`) and
// runs the branch daemon; an office host holds its own host identity
// (identity/host.seed). Neither: mail sent from another host never arrives.
function deliveryTargetCheck(tpsRoot: string): DoctorCheck {
  const name = "tps-mail delivery";
  const identityDir = join(tpsRoot, "identity");
  if (existsSync(join(identityDir, "host.json"))) {
    let running = false;
    try {
      const raw = readFileSync(join(tpsRoot, "branch.pid"), "utf8").trim();
      running = /^[0-9]+$/.test(raw) && pidAlive(Number(raw));
    } catch {
      running = false;
    }
    return running
      ? { name, status: "ok", detail: "joined TPS branch; the branch daemon is running" }
      : {
          name,
          status: "warn",
          detail:
            "joined TPS branch, but the branch daemon is not running (branch.pid) — mail from the office is not delivered until it is",
          fix: "tps branch start",
        };
  }
  if (["host.seed", "host.pub", "host.key"].some((f) => existsSync(join(identityDir, f)))) {
    return { name, status: "ok", detail: "TPS office host (mail is delivered locally)" };
  }
  return {
    name,
    status: "fail",
    detail: `this host is not a TPS delivery target — no joined branch (${join(identityDir, "host.json")}) and no office identity (${join(identityDir, "host.seed")}), so mail sent from another host never arrives (#134)`,
    fix: "join this host to the office as a branch: 'tps branch init' here, then 'tps office join <name> <token>' on the office host",
  };
}

// What is wrong with the replied/ entry itself: "absent" when there is none,
// undefined when it is (or links to) a directory, else the problem.
function repliedEntryProblem(path: string): string | undefined {
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : String(err);
  }
  let target: ReturnType<typeof statSync>;
  try {
    target = statSync(path);
  } catch {
    return link.isSymbolicLink() ? "a broken symlink" : "unreadable";
  }
  return target.isDirectory() ? undefined : "not a directory";
}

// Can this directory be fsynced? undefined when it can; the error code when not.
function directoryFsyncProblem(dir: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? String(err);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function findOnPath(bin: string, pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, bin);
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

// ─── The reply contract ─────────────────────────────────────────────────────
//
// bob sends every reply as `tps mail send <to> --stdin --reply-to <messageId>`
// (reply.ts). A tps that does not take those flags — @tpsdev-ai/cli 0.7.0 and
// older; the contract landed with tpsdev-ai/cli#431 — fails every reply
// closed, so an agent that passes every other check would still look
// mail-capable and never answer. Doctor asks the CLI itself: `tps mail --help`
// prints its mail usage and exits without acting, and a CLI that takes the
// contract names both flags there.
//
// An unknown answer never passes: a probe that cannot start, is killed at its
// timeout, exits non-zero, or prints neither flag is a FAIL naming what it saw.
// The probe runs with a fixed argv, no shell, and an environment of PATH and
// HOME only, so no ambient variable reaches the child.
export const TPS_PROBE_TIMEOUT_MS = 10_000;
export const TPS_REPLY_CONTRACT_FLAGS = ["--stdin", "--reply-to"] as const;

export function tpsReplyContractProblem(
  tps: string,
  o: { pathEnv: string; home: string; timeoutMs: number },
): string | undefined {
  const res = spawnSync(tps, ["mail", "--help"], {
    encoding: "utf8",
    env: { PATH: o.pathEnv, HOME: o.home },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    timeout: o.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code ?? res.error.message;
    return code === "ETIMEDOUT"
      ? `'${tps} mail --help' did not finish within ${o.timeoutMs}ms`
      : `'${tps} mail --help' could not be run (${code})`;
  }
  if (res.status !== 0) {
    return `'${tps} mail --help' exited ${res.status ?? res.signal}`;
  }
  const usage = typeof res.stdout === "string" ? res.stdout : "";
  const missing = TPS_REPLY_CONTRACT_FLAGS.filter((flag) => !usage.includes(flag));
  if (missing.length > 0) {
    return `${tps} does not take 'mail send --stdin --reply-to' (its mail usage names no ${missing.join(" or ")}), so every reply would fail closed`;
  }
  return undefined;
}

function countRefusedByReason(refusedDir: string): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!existsSync(refusedDir)) return counts;
  let names: string[];
  try {
    names = readdirSync(refusedDir);
  } catch {
    return counts;
  }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    let reason = "unknown";
    try {
      const m = /^reason:\s*(\S+)/m.exec(readFileSync(join(refusedDir, `${f}.reason`), "utf8"));
      if (m) reason = m[1];
    } catch {
      // a refused record with no sidecar still counts
    }
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function countJson(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function summarize(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function sum(counts: Record<string, number> | undefined): number {
  return Object.values(counts ?? {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
}

function tpsMailChecks(o: {
  name: string;
  yamlText: string | undefined;
  home: string;
  flairKeysDir: string;
  pathEnv: string;
  tpsProbeTimeoutMs: number;
  agentDir: string;
  hostRoot: string;
  positionsRoot?: string;
}): { declared: boolean; checks: DoctorCheck[] } {
  if (o.yamlText === undefined) return { declared: false, checks: [] };
  let capabilities: string[];
  try {
    capabilities = readCapabilities(o.yamlText);
  } catch {
    capabilities = [];
  }
  const declared = capabilities.includes(TPS_MAIL_CAPABILITY);

  // The EFFECTIVE set — what the persistent runtime actually starts (Gauge
  // round 6, blocker 4). An adopted agent's grant or a local override can
  // remove tps-mail that bob.yaml declares; doctor then says so rather than
  // passing checks for a consumer that will never run.
  let effective: ReturnType<typeof effectiveCapabilities>;
  try {
    effective = effectiveCapabilities({
      name: o.name,
      agentDir: o.agentDir,
      yamlText: o.yamlText,
      hostRoot: o.hostRoot,
      ...(o.positionsRoot !== undefined ? { positionsRoot: o.positionsRoot } : {}),
    });
  } catch (err) {
    if (!declared) return { declared: false, checks: [] };
    return {
      declared: true,
      checks: [
        {
          name: "tps-mail",
          status: "fail",
          detail: `the agent's effective capabilities cannot be resolved: ${err instanceof Error ? err.message : String(err)}`,
          fix: "fix the agent's position grant / overrides (bob position diff) so the runtime can resolve it",
        },
      ],
    };
  }
  const enabled = effective.names.includes(TPS_MAIL_CAPABILITY);
  if (declared && !enabled) {
    return {
      declared: true,
      checks: [
        {
          name: "tps-mail",
          status: "warn",
          detail: `DISABLED — bob.yaml declares tps-mail, but it is not in this agent's effective capabilities (${effective.adopted ? "its position grant does not permit it, or a local override disables it" : "it did not resolve"}); the runtime starts no mail consumer, so mail to ${o.name} is not answered`,
          fix: "enable tps-mail through the agent's position (bob position diff shows what the grant and overrides allow), or remove it from capabilities:",
        },
      ],
    };
  }
  if (!enabled) {
    if (!declaresLegacyTpsMailChannel(o.yamlText)) return { declared: false, checks: [] };
    return {
      declared: false,
      checks: [
        {
          name: "tps-mail",
          status: "fail",
          detail:
            "bob.yaml declares channels.tps_mail, but nothing consumes it — the agent looks mail-capable and is not",
          fix: "declare the tps-mail capability (add tps-mail to capabilities: and a tps-mail: block with inbox: and senders:), or delete channels.tps_mail",
        },
      ],
    };
  }

  const checks: DoctorCheck[] = [];
  let config: TpsMailCapabilityConfig;
  try {
    config = validateTpsMailConfig(
      effective.adopted
        ? (effective.configs[TPS_MAIL_CAPABILITY] ?? {})
        : (readBlock(o.yamlText, TPS_MAIL_CAPABILITY) ?? {}),
    );
  } catch (err) {
    checks.push({
      name: "tps-mail config",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "give the tps-mail: block inbox: and a non-empty senders: list of exact TPS agent ids — with no allow-list the capability refuses to load",
    });
    return { declared, checks };
  }
  checks.push({
    name: "tps-mail config",
    status: "ok",
    detail: `${config.senders.length} allow-listed sender${config.senders.length === 1 ? "" : "s"}: ${config.senders.join(", ")} (each is granted this agent's read scope)`,
  });

  let identity: TpsMailIdentity | undefined;
  try {
    identity = readTpsMailIdentity(o.yamlText);
    checks.push({
      name: "tps-mail identity",
      status: "ok",
      detail: `signs as ${identity.agentId}`,
    });
  } catch (err) {
    checks.push({
      name: "tps-mail identity",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "add the flair: block (url, agentId, keyFile) — re-run 'bob onboard <name> --force' without --no-flair",
    });
  }

  const inbox = expandHome(config.inbox, o.home);
  if (!existsSync(join(inbox, "new"))) {
    checks.push({
      name: "tps-mail inbox",
      status: "fail",
      detail: `${join(inbox, "new")} not present`,
      fix: `point tps-mail.inbox at the agent's TPS inbox, or create it: mkdir -p ${join(inbox, "new")} ${join(inbox, "cur")}`,
    });
  } else {
    // replied/ markers must be durable before any ack, and that needs fsync on
    // THE replied/ DIRECTORY itself (Gauge round 6, blocker 1): it can be a
    // mount or a symlink onto another filesystem. Before the consumer has
    // created it, the inbox root is where it will be created.
    // The ACTUAL entry, not followed: a broken symlink or a non-directory is a
    // failure; only a genuinely absent entry falls back to the inbox root.
    const repliedDir = join(inbox, "replied");
    const entry = repliedEntryProblem(repliedDir);
    const probed = entry === "absent" ? inbox : repliedDir;
    const durability =
      entry === "absent" || entry === undefined ? directoryFsyncProblem(probed) : entry;
    checks.push(
      durability === undefined
        ? {
            name: "tps-mail inbox",
            status: "ok",
            detail: `${inbox} (${probed === repliedDir ? "replied/" : "inbox root; replied/ not created yet"} can fsync a directory)`,
          }
        : {
            name: "tps-mail inbox",
            status: "fail",
            detail: `${probed}: cannot fsync the directory (${durability}), so replied/ markers cannot be made durable and no mail would ever be acked`,
            fix: "put the tps-mail inbox's replied/ directory on a filesystem that supports fsync on a directory",
          },
    );
  }

  checks.push(deliveryTargetCheck(join(o.home, ".tps")));

  const tps = findOnPath("tps", o.pathEnv);
  if (!tps) {
    checks.push({
      name: "tps-mail reply transport",
      status: "fail",
      detail: "the tps CLI is not on PATH — replies are sent with 'tps mail send'",
      fix: "install @tpsdev-ai/cli, and make sure the service unit's PATH reaches it",
    });
  } else if (identity && !existsSync(join(o.flairKeysDir, `${identity.agentId}.key`))) {
    checks.push({
      name: "tps-mail reply transport",
      status: "fail",
      detail: `no signing key at ${join(o.flairKeysDir, `${identity.agentId}.key`)} — the tps CLI would send replies unsigned, and recipients dead-letter those`,
      fix: `provision the agent's Flair key at ${join(o.flairKeysDir, `${identity.agentId}.key`)}`,
    });
  } else {
    checks.push({ name: "tps-mail reply transport", status: "ok", detail: tps });
  }
  if (tps) {
    const problem = tpsReplyContractProblem(tps, {
      pathEnv: o.pathEnv,
      home: o.home,
      timeoutMs: o.tpsProbeTimeoutMs,
    });
    checks.push(
      problem === undefined
        ? {
            name: "tps-mail reply contract",
            status: "ok",
            detail: `${tps} takes 'mail send --stdin --reply-to'`,
          }
        : {
            name: "tps-mail reply contract",
            status: "fail",
            detail: problem,
            fix: "install an @tpsdev-ai/cli release that includes tpsdev-ai/cli#431 ('tps mail send --stdin --reply-to'); 0.7.0 and older do not take it",
          },
    );
  }

  // Activity: refused per reason (durable, from refused/), what is waiting,
  // and the running consumer's failure counters.
  const refused = countRefusedByReason(join(inbox, "refused"));
  let stats:
    | {
        replied?: number;
        noReply?: number;
        dispatchFailed?: number;
        timeouts?: number;
        replyFailed?: Record<string, number>;
        verifyUnavailable?: number;
        markerFailed?: number;
        markerReadFailed?: number;
        reapExhausted?: number;
      }
    | undefined;
  try {
    stats = JSON.parse(readFileSync(tpsMailStatsPath(o.home, o.name), "utf8"));
  } catch {
    stats = undefined;
  }
  const refusedTotal = sum(refused);
  // Mail held for a human (held/ + .reason), by reason: never answered.
  const held = countRefusedByReason(join(inbox, "held"));
  const heldTotal = sum(held);
  const pending = countJson(join(inbox, "new"));
  const reasons = Object.fromEntries(REFUSAL_REASONS.map((r) => [r, refused[r] ?? 0]));
  for (const [k, n] of Object.entries(refused)) if (!(k in reasons)) reasons[k] = n;
  const parts = [
    `new=${pending} cur=${countJson(join(inbox, "cur"))} refused=${refusedTotal}${summarize(reasons)} held for inspection=${heldTotal}${summarize(held)}`,
  ];
  let failing = heldTotal > 0;
  if (stats) {
    const replyFailed = sum(stats.replyFailed);
    parts.push(
      `this run: replied=${stats.replied ?? 0} no-reply=${stats.noReply ?? 0} dispatch failures=${stats.dispatchFailed ?? 0} (timeouts ${stats.timeouts ?? 0}) reply failures=${replyFailed}${summarize(stats.replyFailed ?? {})} verify unavailable=${stats.verifyUnavailable ?? 0} marker failures=${stats.markerFailed ?? 0} marker read failures=${stats.markerReadFailed ?? 0} reap exhausted=${stats.reapExhausted ?? 0}`,
    );
    failing =
      failing ||
      (stats.dispatchFailed ?? 0) > 0 ||
      replyFailed > 0 ||
      (stats.verifyUnavailable ?? 0) > 0 ||
      (stats.markerFailed ?? 0) > 0 ||
      (stats.markerReadFailed ?? 0) > 0 ||
      (stats.reapExhausted ?? 0) > 0;
  } else {
    parts.push("no consumer stats yet (the persistent runtime writes them)");
  }
  checks.push({
    name: "tps-mail activity",
    status: failing ? "warn" : "ok",
    detail: parts.join("; "),
    ...(failing
      ? {
          fix: "read the runtime log's tps-mail: lines — a failed mail stays in new/ and is retried with backoff; a HELD mail (held/<file>.reason) needs a human",
        }
      : {}),
  });
  return { declared, checks };
}

function fileCheck(name: string, path: string, opts: { onMissing: string }): DoctorCheck {
  if (!existsSync(path)) {
    return { name, status: "fail", detail: path, fix: opts.onMissing };
  }
  // Reject symlinks-to-nowhere by stat'ing the resolved target.
  try {
    statSync(path);
    return { name, status: "ok", detail: path };
  } catch (err: unknown) {
    return {
      name,
      status: "fail",
      detail: `${path} unreadable: ${err instanceof Error ? err.message : String(err)}`,
      fix: opts.onMissing,
    };
  }
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function finalize(name: string, agentDir: string, checks: DoctorCheck[]): DoctorReport {
  const summary = { ok: 0, fail: 0, skip: 0, warn: 0 };
  for (const c of checks) summary[c.status] += 1;
  return { agent: name, agentDir, checks, summary };
}

// Render a DoctorReport into a multi-line string for terminal output.
export function formatReport(report: DoctorReport): string {
  const lines: string[] = [`[bob doctor ${report.agent}]`];
  const nameWidth = Math.max(...report.checks.map((c) => c.name.length));
  for (const c of report.checks) {
    const tag = ({ ok: "OK", fail: "FAIL", skip: "SKIP", warn: "WARN" } as const)[c.status];
    const padded = c.name.padEnd(nameWidth);
    lines.push(`  ${padded}  ${tag}${c.detail ? ` — ${c.detail}` : ""}`);
    if (c.fix) {
      lines.push(`  ${" ".repeat(nameWidth)}        fix: ${c.fix}`);
    }
  }
  const { ok, fail, skip, warn } = report.summary;
  if (fail > 0) {
    lines.push("");
    lines.push(`  ${fail} of ${ok + fail + skip + warn} checks FAILING. See above for fixes.`);
  } else if (warn > 0) {
    lines.push("");
    lines.push(`  ${warn} warning${warn > 1 ? "s" : ""}, but no hard failures.`);
  } else {
    lines.push("");
    lines.push("  All green.");
  }
  return lines.join("\n");
}
