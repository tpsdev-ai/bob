// The host grant: the per-agent trust root (bob#195, slice 1).
//
// At hire (or adoption) the OPERATOR ratifies, in host-controlled state the
// agent's own tools cannot write, four things:
//
//   * the role name;
//   * the position version and hash;
//   * the maximum tool set;
//   * the maximum permitted capability set.
//
// Every boot verifies the position hash and role against this state, refuses by
// name each tool or capability outside the ratified set BEFORE any intersection,
// applies the narrow-only local disables, and only then runs the existing
// validators. Because the grant lives OUTSIDE the agent's directory (the agent's
// tools address ~/agents/<name>/), changing bob.yaml cannot select another role
// or add a grant.
//
// The diff BASELINE (the materialized defaults at hire/adoption) is stored
// alongside, so `bob position diff` compares the current effective configuration
// against what the operator ratified.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Host state root. Overridable (tests, multi-tenant hosts). Deliberately NOT
// under ~/agents: the grant is the trust root, and the agent lives under a
// directory its own shell can reach.
export function defaultHostRoot(): string {
  return join(homedir(), ".bob", "host");
}

export interface GrantPosition {
  name: string;
  version: string;
  hash: string;
}

export interface HostGrant {
  agent: string;
  role: string;
  position: GrantPosition;
  // The ratified maxima. bob.yaml may narrow within these; a name outside them is
  // refused by name.
  maxTools: string[];
  maxCapabilities: string[];
  // The role's resident-shell grant, frozen at ratification (a position may not
  // carry it).
  allowResidentShell: boolean;
  ratifiedAt: string;
}

export interface RatifiedSnapshot {
  // The effective configuration at ratification: what `position diff` compares to.
  tools: string[];
  capabilities: string[];
  // Resolved files at ratification, keyed by relative path.
  files: Record<string, string>;
  soulHash: string;
  position: GrantPosition;
}

function grantPath(hostRoot: string, agent: string): string {
  return join(hostRoot, "grants", `${agent}.json`);
}
function baselinePath(hostRoot: string, agent: string): string {
  return join(hostRoot, "baselines", `${agent}.json`);
}

// Read an agent's host grant. Returns undefined when the agent has never been
// ratified — the state that keeps an ordinary `bob init` agent booting unchanged.
export function readGrant(hostRoot: string, agent: string): HostGrant | undefined {
  const p = grantPath(hostRoot, agent);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new Error(
      `bob: the host grant for "${agent}" at ${p} is unreadable (${err instanceof Error ? err.message : String(err)}). Refusing to boot an adopted agent whose trust root cannot be read.`,
    );
  }
  try {
    return JSON.parse(raw) as HostGrant;
  } catch (err) {
    throw new Error(
      `bob: the host grant for "${agent}" at ${p} is unparsable (${err instanceof Error ? err.message : String(err)}). Refusing to boot an adopted agent whose trust root cannot be read.`,
    );
  }
}

export function writeGrant(hostRoot: string, grant: HostGrant): string {
  const p = grantPath(hostRoot, grant.agent);
  mkdirSync(join(hostRoot, "grants"), { recursive: true, mode: 0o700 });
  writeFileSync(p, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
  return p;
}

export function readBaseline(hostRoot: string, agent: string): RatifiedSnapshot | undefined {
  const p = baselinePath(hostRoot, agent);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(raw) as RatifiedSnapshot;
}

export function writeBaseline(hostRoot: string, agent: string, snap: RatifiedSnapshot): string {
  const p = baselinePath(hostRoot, agent);
  mkdirSync(join(hostRoot, "baselines"), { recursive: true, mode: 0o700 });
  writeFileSync(p, `${JSON.stringify(snap, null, 2)}\n`, { mode: 0o600 });
  return p;
}
