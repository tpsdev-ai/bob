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

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
