// The host grant: the per-agent trust root (bob#195, slice 1).
//
// At hire (or adoption) the OPERATOR ratifies, in host-controlled state, four
// things:
//
//   * the role name;
//   * the position name, version and hash;
//   * the maximum tool set;
//   * the maximum permitted capability set.
//
// Every boot verifies the position name/version/hash and role against this
// state, refuses by name each tool or capability outside the ratified set BEFORE
// any intersection, applies the narrow-only local disables, and only then runs
// the existing validators.
//
// The grant is TAMPER-EVIDENT, NOT tamper-proof. It is stored OUTSIDE every
// agent-addressable path — never under the agent's directory (~/agents/<name>/)
// and never under its session cwd — so the tools the position can hand the agent
// (`write`, `edit`, the anchored-edit tools) cannot address it by path
// containment, and a grant that is missing or unreadable is a LOUD refusal, not
// a silent fallback. But an agent running as the SAME OS user with a shell can
// still edit host files: real isolation is the sandbox work (bob#189), which
// slice 1 does not ship. That is the whole guarantee: the honest tool authority
// cannot reach the grant, and the OS user boundary is a later slice.
//
// The "previously bound" guard: hire and adoption also write a small binding
// marker INTO the agent's directory (`.position-binding.json`). The marker is
// not a trust root and carries no authority — the grant is the authority — but
// it is the evidence that THIS agent was once bound. A boot that finds a marker
// with no readable grant REFUSES (a bound agent whose trust root vanished must
// not silently fall back to legacy resolution); a boot with neither is an
// ordinary `bob init` agent and keeps booting unchanged.
//
// The diff BASELINE (the materialized effective settings at hire/adoption) is
// stored alongside, so `bob position diff` compares the current effective
// configuration against what the operator ratified.

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
  // The effective configuration at ratification: what `position diff` compares
  // to. Every setting the spec covers is stored, so drift in ANY of them shows.
  role: string;
  tools: string[];
  excludeTools: string[];
  resident: boolean;
  allowResidentShell: boolean;
  capabilities: string[];
  // Resolved files at ratification, keyed by relative path.
  files: Record<string, string>;
  soulHash: string;
  // Bookkeeping: the position identity the grant pins (overwritten from the
  // grant when the snapshot is written).
  position: GrantPosition;
}

// The binding marker: written by hire/adoption into the AGENT's directory as the
// evidence that this agent was once bound. It carries no authority — a boot that
// finds a grant uses the grant — but a boot that finds a marker and NO grant
// refuses, so a bound agent whose trust root vanished cannot silently fall back
// to legacy resolution.
export const BINDING_MARKER = ".position-binding.json";

export interface PositionBindingMarker {
  agent: string;
  position: string;
  role: string;
  ratifiedAt: string;
}

function grantPath(hostRoot: string, agent: string): string {
  return join(hostRoot, "grants", `${agent}.json`);
}
function baselinePath(hostRoot: string, agent: string): string {
  return join(hostRoot, "baselines", `${agent}.json`);
}

export function bindingMarkerPath(agentDir: string): string {
  return join(agentDir, BINDING_MARKER);
}

// Read the binding marker. Returns undefined when the agent was never bound.
// An UNREADABLE marker is treated as present (the conservative reading: a
// bound-looking agent must not fall back).
export function readBindingMarker(agentDir: string): PositionBindingMarker | undefined {
  const p = bindingMarkerPath(agentDir);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return { agent: "", position: "", role: "", ratifiedAt: "" };
  }
  try {
    return JSON.parse(raw) as PositionBindingMarker;
  } catch {
    return { agent: "", position: "", role: "", ratifiedAt: "" };
  }
}

export function writeBindingMarker(agentDir: string, grant: HostGrant): string {
  const p = bindingMarkerPath(agentDir);
  const marker: PositionBindingMarker = {
    agent: grant.agent,
    position: grant.position.name,
    role: grant.role,
    ratifiedAt: grant.ratifiedAt,
  };
  writeFileSync(p, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });
  return p;
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
