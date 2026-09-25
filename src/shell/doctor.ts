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
//   - TPS mail inbox dir + new/cur counts
//   - Discord token file (if path-hint exists)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readAgentRole,
  readCapabilities,
  readResident,
  readTools,
  type ToolsBlock,
} from "./bob-yaml.js";
import { resolveAgentToolPolicy } from "./run.js";
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

// The `tools:` allowlist check. Audits every name in the agent's bob.yaml
// against the tools pi and the blessed capabilities can actually enable, and
// reports a resident agent whose allowlist asks for a tool the resident policy
// drops. NEVER throws: a malformed block or a bad `resident:` value is a FAIL
// with a fix, not a doctor crash (doctor is what you run when something is
// wrong).
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

  const dropped = residentDroppedTools(policy);
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
    return {
      name,
      status: "warn",
      detail: `resident: true drops ${dropped.join(", ")}, which the role allows`,
      fix: denial
        ? `grant it in roles/${role}/role.json (tools.allowResidentShell: true) AND remove tools.allowResidentShell: false from bob.yaml — the grant lives in the role, and bob.yaml may only narrow it, but the explicit false in bob.yaml denies the grant even once the role gives it — or drop ${dropped.join(", ")} from tools.allow`
        : `set tools.allowResidentShell: true in roles/${role}/role.json — the grant lives in the role, and bob.yaml may only narrow the role, so it cannot grant this — or drop ${dropped.join(", ")} from tools.allow`,
    };
  }

  return {
    name,
    status: "ok",
    detail: `${block.allow.length} name${block.allow.length === 1 ? "" : "s"}: ${block.allow.join(", ")}`,
  };
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
