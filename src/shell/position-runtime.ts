// Position runtime orchestration (bob#195, slice 1): hire, adopt, diff, and the
// boot resolver the session entry paths use.
//
//   * `hireAgent`     — scaffold a NEW agent from a packaged position, ratify the
//                       host grant, store the diff baseline and initialize the
//                       override repository. Validates the candidate BEFORE it
//                       writes anything, so a refused hire leaves no scaffold,
//                       grant or override repository behind.
//   * `adoptAgent`    — bind an EXISTING agent to a position: independently
//                       resolve it before and after, verify its requests, record
//                       the binding/ratification/baseline, initialize the
//                       override repository, and leave the config and soul
//                       byte-for-byte unchanged.
//   * `resolveAdoptedConfig` — the boot resolver. Returns undefined for an agent
//                       with no grant (an ordinary `bob init` agent keeps
//                       booting unchanged); otherwise the effective config with
//                       the grant/position/override/secret layers applied.
//   * `positionDiff`  — the ratified baseline vs the current effective config.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAgentRole, readCapabilities, readTools } from "./bob-yaml.js";
import { lookupCapability } from "./capability-catalog.js";
import { resolveCapabilities } from "./capability-loader.js";
import {
  computePositionDiff,
  type EffectiveConfig,
  type PositionDiff,
  resolveEffectiveConfig,
  snapshotForDiff,
} from "./effective-config.js";
import {
  defaultHostRoot,
  type HostGrant,
  type RatifiedSnapshot,
  readBaseline,
  readGrant,
  writeBaseline,
  writeGrant,
} from "./host-grant.js";
import { type InitResult, initAgent } from "./init.js";
import { initOverrideRepo } from "./overrides.js";
import { DEFAULT_POSITIONS_ROOT, type LoadedPosition, loadPosition } from "./positions.js";
import { loadRole } from "./role-loader.js";
import { resolveAgentToolPolicy } from "./run.js";
import { loadSecretBindings, type SecretBindings } from "./secrets.js";

const AGENT_NAME = /^[a-z0-9-]+$/;

export interface PositionCommonOptions {
  name: string;
  positionName: string;
  agentsRoot: string;
  hostRoot?: string;
  positionsRoot?: string;
  bindings?: SecretBindings;
  now?: () => Date;
}

function refuse(detail: string): never {
  throw new Error(`bob: ${detail}`);
}

function resolveHostRoot(opts: { hostRoot?: string }): string {
  return opts.hostRoot ?? defaultHostRoot();
}

function resolveBindings(opts: PositionCommonOptions, hostRoot: string): SecretBindings {
  return opts.bindings ?? loadSecretBindings({ hostRoot });
}

// A grant built from a ratifiable position + role. maxTools/maxCapabilities are
// the position's requested maxima; allowResidentShell is the ROLE's grant (a
// position never carries it).
function grantFor(
  name: string,
  position: LoadedPosition,
  roleAllowResidentShell: boolean,
  now: () => Date,
): HostGrant {
  return {
    agent: name,
    role: position.manifest.role,
    position: {
      name: position.manifest.name,
      version: position.manifest.version,
      hash: position.hash,
    },
    maxTools: [...position.manifest.tools],
    maxCapabilities: [...position.manifest.capabilities.permitted],
    allowResidentShell: roleAllowResidentShell,
    ratifiedAt: now().toISOString(),
  };
}

// Assert the position's requests are compatible with its named role, and that
// its permitted capabilities are blessed + implemented. Runs BEFORE any file is
// written.
function assertPositionAgainstRole(position: LoadedPosition, roleAllow: readonly string[]): void {
  const ceiling = new Set(roleAllow);
  const widened = position.manifest.tools.filter((t) => !ceiling.has(t));
  if (widened.length > 0) {
    refuse(
      `the "${position.manifest.name}" position requests tool${widened.length === 1 ? "" : "s"} the "${position.manifest.role}" role's ceiling does not cover: ${widened.join(", ")}. A position names an existing role whose ceiling covers the tools it requests.`,
    );
  }
  for (const cap of position.manifest.capabilities.permitted) {
    const entry = lookupCapability(cap);
    if (!entry || entry.notYetImplemented) {
      refuse(
        `the "${position.manifest.name}" position permits capability "${cap}", which is not blessed and implemented.`,
      );
    }
  }
}

// The yaml the position materializes, used to VALIDATE before scaffolding. Kept
// in lockstep with what initAgent writes (same tools/capabilities/role).
function materializedYaml(
  role: string,
  tools: readonly string[],
  capabilities: readonly string[],
): string {
  const toolLines = tools.map((t) => `    - ${t}`).join("\n");
  const capLines = capabilities.map((c) => `  - ${c}`).join("\n");
  return `agent:\n  role: ${role}\n\ntools:\n  allow:\n${toolLines}\n\ncapabilities:\n${capLines}\n`;
}

function soulHashOf(agentDir: string): string {
  const p = join(agentDir, "soul.md");
  if (!existsSync(p)) return "";
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

export interface HireOptions extends PositionCommonOptions {
  provider?: string;
  model?: string;
  skipFlair?: boolean;
  flairKeysDir?: string;
  flairUrl?: string;
}

export interface HireResult {
  agentDir: string;
  init: InitResult;
  grant: HostGrant;
  baseline: RatifiedSnapshot;
  overrideDir: string;
  effective: EffectiveConfig;
}

// Hire a NEW agent from a packaged position.
export function hireAgent(opts: HireOptions): HireResult {
  if (!AGENT_NAME.test(opts.name)) refuse(`invalid agent name ${JSON.stringify(opts.name)}.`);
  const hostRoot = resolveHostRoot(opts);
  const positionsRoot = opts.positionsRoot ?? DEFAULT_POSITIONS_ROOT;
  const now = opts.now ?? (() => new Date());

  const position = loadPosition(opts.positionName, { root: positionsRoot });
  const role = loadRole(position.manifest.role as never);
  assertPositionAgainstRole(position, role.tools.allow);

  const agentDir = join(opts.agentsRoot, opts.name);
  const bindings = resolveBindings(opts, hostRoot);
  const grant = grantFor(opts.name, position, role.tools.allowResidentShell === true, now);

  // VALIDATE against the materialized defaults BEFORE writing anything, so a
  // refused hire commits no scaffold, grant or override repository.
  const yamlText = materializedYaml(
    position.manifest.role,
    position.manifest.tools,
    position.manifest.capabilities.default,
  );
  const effective = resolveEffectiveConfig({
    yamlText,
    agentDir,
    position,
    grant,
    bindings,
    checkSecrets: true,
  });

  const init = initAgent({
    name: opts.name,
    role: position.manifest.role as never,
    provider: opts.provider ?? "exe-dev-gateway",
    model: opts.model ?? "claude-sonnet-4-6",
    agentsRoot: opts.agentsRoot,
    capabilities: position.manifest.capabilities.default,
    toolAllow: position.manifest.tools,
    skipFlair: opts.skipFlair ?? true,
    ...(opts.flairKeysDir !== undefined ? { flairKeysDir: opts.flairKeysDir } : {}),
    ...(opts.flairUrl !== undefined ? { flairUrl: opts.flairUrl } : {}),
  });

  writeGrant(hostRoot, grant);
  const baseline = snapshotForDiff(effective, soulHashOf(init.agentDir));
  baseline.position = grant.position;
  writeBaseline(hostRoot, opts.name, baseline);
  const overrideDir = initOverrideRepo(init.agentDir);

  return { agentDir: init.agentDir, init, grant, baseline, overrideDir, effective };
}

export interface AdoptOptions extends PositionCommonOptions {}

export interface AdoptResult {
  agentDir: string;
  grant: HostGrant;
  baseline: RatifiedSnapshot;
  overrideDir: string;
  // The agent's own tool/capability requests resolved BEFORE binding (today's
  // path) and AFTER binding (the grant/position resolver), for the adoption
  // comparison.
  before: { tools: string[]; capabilities: string[] };
  after: { tools: string[]; capabilities: string[] };
  soulHashBefore: string;
  soulHashAfter: string;
  diff: PositionDiff;
}

// Bind an EXISTING agent to a position.
export function adoptAgent(opts: AdoptOptions): AdoptResult {
  if (!AGENT_NAME.test(opts.name)) refuse(`invalid agent name ${JSON.stringify(opts.name)}.`);
  const hostRoot = resolveHostRoot(opts);
  const positionsRoot = opts.positionsRoot ?? DEFAULT_POSITIONS_ROOT;
  const now = opts.now ?? (() => new Date());

  const agentDir = join(opts.agentsRoot, opts.name);
  const yamlPath = join(agentDir, "bob.yaml");
  if (!existsSync(yamlPath)) {
    refuse(
      `cannot adopt ${opts.name}: ${yamlPath} not found (run 'bob onboard ${opts.name}' first).`,
    );
  }
  const yamlText = readFileSync(yamlPath, "utf8");

  const position = loadPosition(opts.positionName, { root: positionsRoot });
  const role = loadRole(position.manifest.role as never);
  assertPositionAgainstRole(position, role.tools.allow);

  // The existing agent's role must be the position's role — adoption binds to a
  // role; it never rewrites the agent's identity.
  const existingRole = readAgentRole(yamlText);
  if (existingRole !== position.manifest.role) {
    refuse(
      `cannot adopt ${opts.name} into the "${position.manifest.name}" position: the agent's role is "${existingRole}", but the position names the role "${position.manifest.role}". Adoption binds to a role; it does not change it.`,
    );
  }

  // The agent's OWN requests resolved the way they are today (the "before").
  const beforePolicy = resolveAgentToolPolicy(yamlText);
  const beforeCaps = resolveCapabilities({ yamlText }).capabilities.map((c) => c.name);

  // Verify the existing requests against the position's permitted sets — adoption
  // refuses rather than silently narrowing.
  const permTools = new Set(position.manifest.tools);
  const outsideTools = beforePolicy.tools.filter((t) => !permTools.has(t));
  if (outsideTools.length > 0) {
    refuse(
      `cannot adopt ${opts.name}: it requests tool${outsideTools.length === 1 ? "" : "s"} outside the "${position.manifest.name}" position's set: ${outsideTools.join(", ")}. Adoption never silently narrows a request; move the name into the position or drop it from bob.yaml.`,
    );
  }
  const permCaps = new Set(position.manifest.capabilities.permitted);
  const outsideCaps = beforeCaps.filter((c) => !permCaps.has(c));
  if (outsideCaps.length > 0) {
    refuse(
      `cannot adopt ${opts.name}: it requests capabilit${outsideCaps.length === 1 ? "y" : "ies"} the "${position.manifest.name}" position does not permit: ${outsideCaps.join(", ")}.`,
    );
  }

  const bindings = resolveBindings(opts, hostRoot);
  const grant = grantFor(opts.name, position, role.tools.allowResidentShell === true, now);

  // The "after": the same requests under the grant/position resolver.
  const effective = resolveEffectiveConfig({
    yamlText,
    agentDir,
    position,
    grant,
    bindings,
    checkSecrets: true,
  });

  const before = { tools: [...beforePolicy.tools].sort(), capabilities: [...beforeCaps].sort() };
  const after = {
    tools: [...effective.tools].sort(),
    capabilities: [...effective.capabilities].sort(),
  };

  const soulHashBefore = soulHashOf(agentDir);
  writeGrant(hostRoot, grant);
  const baseline = snapshotForDiff(effective, soulHashBefore);
  baseline.position = grant.position;
  writeBaseline(hostRoot, opts.name, baseline);
  const overrideDir = initOverrideRepo(agentDir);
  const soulHashAfter = soulHashOf(agentDir);

  const diff = computePositionDiff(baseline, effective, soulHashAfter);

  return {
    agentDir,
    grant,
    baseline,
    overrideDir,
    before,
    after,
    soulHashBefore,
    soulHashAfter,
    diff,
  };
}

// The boot resolver. Returns undefined when the agent has no grant (not adopted
// — today's resolution is used untouched), else the effective configuration.
export function resolveAdoptedConfig(input: {
  name: string;
  agentDir: string;
  yamlText: string;
  hostRoot?: string;
  positionsRoot?: string;
  bindings?: SecretBindings;
  persistent?: boolean;
}): EffectiveConfig | undefined {
  const hostRoot = input.hostRoot ?? defaultHostRoot();
  const grant = readGrant(hostRoot, input.name);
  if (!grant) return undefined;
  const position = loadPosition(grant.position.name, {
    root: input.positionsRoot ?? DEFAULT_POSITIONS_ROOT,
  });
  const bindings = input.bindings ?? loadSecretBindings({ hostRoot });
  return resolveEffectiveConfig({
    yamlText: input.yamlText,
    agentDir: input.agentDir,
    position,
    grant,
    bindings,
    checkSecrets: true,
    persistent: input.persistent,
  });
}

// `bob position diff` — the ratified baseline vs the current effective config.
export function positionDiff(input: {
  name: string;
  agentsRoot: string;
  hostRoot?: string;
  positionsRoot?: string;
  bindings?: SecretBindings;
}): PositionDiff {
  const hostRoot = input.hostRoot ?? defaultHostRoot();
  const grant = readGrant(hostRoot, input.name);
  if (!grant) refuse(`${input.name} is not bound to a position (nothing to diff).`);
  const baseline = readBaseline(hostRoot, input.name);
  if (!baseline) refuse(`${input.name} has a grant but no baseline record (re-run adoption).`);
  const agentDir = join(input.agentsRoot, input.name);
  const yamlText = readFileSync(join(agentDir, "bob.yaml"), "utf8");
  const position = loadPosition(grant.position.name, {
    root: input.positionsRoot ?? DEFAULT_POSITIONS_ROOT,
  });
  const bindings = input.bindings ?? loadSecretBindings({ hostRoot });
  const effective = resolveEffectiveConfig({
    yamlText,
    agentDir,
    position,
    grant,
    bindings,
    checkSecrets: false,
  });
  return computePositionDiff(baseline, effective, soulHashOf(agentDir));
}

// Read the position binding for an agent, for diagnostics.
export function readPositionBinding(
  hostRoot: string | undefined,
  name: string,
): HostGrant | undefined {
  return readGrant(hostRoot ?? defaultHostRoot(), name);
}

// The agent's currently requested capabilities (its bob.yaml), for tests/tools.
export function requestedCapabilities(yamlText: string): string[] {
  return readCapabilities(yamlText);
}

// The agent's currently requested tools (its bob.yaml).
export function requestedTools(yamlText: string, name: string): string[] {
  const block = readTools(yamlText);
  if (!block?.allow) refuse(`${name}: bob.yaml has no tools.allow`);
  return block.allow;
}

// For callers that want the agent dir path without importing path helpers.
export function agentDirFor(agentsRoot: string, name: string): string {
  return join(agentsRoot, name);
}

// Re-exported for the CLI so it does not reach into effective-config directly.
export { computePositionDiff, dirname };
