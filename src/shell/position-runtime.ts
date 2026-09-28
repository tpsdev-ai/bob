// Position runtime orchestration (bob#195, slice 1): hire, adopt, diff, and the
// boot resolver the session entry paths use.
//
//   * `hireAgent`     — scaffold a NEW agent from a packaged position, ratify the
//                       host grant, store the diff baseline, initialize the
//                       override repository, and run the hiring interview. It
//                       validates the candidate BEFORE it writes anything, so a
//                       refused hire leaves no scaffold, grant or override
//                       repository behind.
//   * `adoptAgent`    — bind an EXISTING agent to a position: independently
//                       resolve it before and after, verify its requests, REQUIRE
//                       the two resolutions to be equal, then record the
//                       binding/ratification/baseline and initialize the override
//                       repository, leaving the config and soul byte-for-byte
//                       unchanged.
//   * `resolveAdoptedConfig` — the boot resolver. Returns undefined for an agent
//                       with no grant (an ordinary `bob init` agent keeps
//                       booting unchanged); otherwise the effective config with
//                       the grant/position/override layers applied. A previously
//                       bound agent whose grant is missing REFUSES.
//   * `positionDiff`  — the ratified baseline vs the current effective config.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  bindingMarkerPath,
  defaultHostRoot,
  type HostGrant,
  type PositionBindingMarker,
  type RatifiedSnapshot,
  readBaseline,
  readBindingMarker,
  readGrant,
  writeBaseline,
  writeBindingMarker,
  writeGrant,
} from "./host-grant.js";
import { type InitResult, initAgent } from "./init.js";
import { type OnboardResult, runOnboard, type SessionRunner } from "./onboard.js";
import { initOverrideRepo } from "./overrides.js";
import { DEFAULT_POSITIONS_ROOT, type LoadedPosition, loadPosition } from "./positions.js";
import { loadRole } from "./role-loader.js";
import { resolveAgentToolPolicy } from "./run.js";
import type { SessionDeps } from "./session.js";

const AGENT_NAME = /^[a-z0-9-]+$/;

export interface PositionCommonOptions {
  name: string;
  positionName: string;
  agentsRoot: string;
  hostRoot?: string;
  positionsRoot?: string;
  now?: () => Date;
}

function refuse(detail: string): never {
  throw new Error(`bob: ${detail}`);
}

function resolveHostRoot(opts: { hostRoot?: string }): string {
  return opts.hostRoot ?? defaultHostRoot();
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

// Assert the position's requests are compatible with its named role, that its
// permitted capabilities are blessed + implemented, and that it declares no
// feature slice 1 cannot honor. Runs BEFORE any file is written.
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
  // Slice 1 ships NO host secret bindings. A position that declares a secret is
  // REFUSED rather than accepted with the requirement quietly unmet: hire and
  // adoption both go through this check, so no position that names a secret can
  // be bound. (None of the shipped positions declares one.)
  if ((position.manifest.secrets?.length ?? 0) > 0) {
    refuse(
      `the "${position.manifest.name}" position declares host secret${(position.manifest.secrets?.length ?? 0) === 1 ? "" : "s"}, which slice 1 does not bind. Host secret bindings ship in a later slice; a position that names a secret is refused rather than accepted with the requirement unmet.`,
    );
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
  // Test seam for the hiring interview (defaults to pi's InteractiveMode). The
  // interview runs AFTER candidate validation and scaffolding, and may rewrite
  // soul.md; the baseline is snapshotted from the result.
  interview?: SessionRunner;
  deps?: SessionDeps;
}

export interface HireResult {
  agentDir: string;
  init: InitResult;
  grant: HostGrant;
  baseline: RatifiedSnapshot;
  overrideDir: string;
  effective: EffectiveConfig;
  // The hiring interview's result (soul before/after, exit code).
  interview: OnboardResult;
}

const DEFAULT_PROVIDER = "exe-dev-gateway";
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Hire a NEW agent from a packaged position. ASYNC because it runs the existing
// onboarding interview after the candidate is validated and scaffolded.
export async function hireAgent(opts: HireOptions): Promise<HireResult> {
  if (!AGENT_NAME.test(opts.name)) refuse(`invalid agent name ${JSON.stringify(opts.name)}.`);
  const hostRoot = resolveHostRoot(opts);
  const positionsRoot = opts.positionsRoot ?? DEFAULT_POSITIONS_ROOT;
  const now = opts.now ?? (() => new Date());

  const position = loadPosition(opts.positionName, { root: positionsRoot });
  const role = loadRole(position.manifest.role as never);
  assertPositionAgainstRole(position, role.tools.allow);

  const agentDir = join(opts.agentsRoot, opts.name);
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
  });

  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const model = opts.model ?? DEFAULT_MODEL;

  // The position supplies the seed persona, but the agent's OWN identity (the
  // header initAgent stamps) stays on top: the seed soul is the identity plus
  // the position's persona, never the generic packaged soul alone.
  const soulFile = effective.files.find((f) => f.kind === "soul");
  const init = initAgent({
    name: opts.name,
    role: position.manifest.role as never,
    provider,
    model,
    agentsRoot: opts.agentsRoot,
    capabilities: position.manifest.capabilities.default,
    toolAllow: position.manifest.tools,
    skipFlair: opts.skipFlair ?? true,
    ...(soulFile !== undefined ? { soulBody: soulFile.content } : {}),
    ...(opts.flairKeysDir !== undefined ? { flairKeysDir: opts.flairKeysDir } : {}),
    ...(opts.flairUrl !== undefined ? { flairUrl: opts.flairUrl } : {}),
  });

  // The hiring interview runs after candidate validation and scaffolding. It
  // refines the seed soul (which already carries the agent's identity).
  const interview = await runOnboard({
    name: opts.name,
    role: position.manifest.role,
    agentDir: init.agentDir,
    provider,
    model,
    ...(opts.interview !== undefined ? { sessionRunner: opts.interview } : {}),
    ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
  });

  writeGrant(hostRoot, grant);
  writeBindingMarker(init.agentDir, grant);
  // The baseline is snapshotted AFTER the interview: what the operator ratified
  // is the agent as it now stands, so `position diff` is empty immediately.
  const baseline = snapshotForDiff(effective, soulHashOf(init.agentDir));
  baseline.position = grant.position;
  writeBaseline(hostRoot, opts.name, baseline);
  const overrideDir = initOverrideRepo(init.agentDir);

  return { agentDir: init.agentDir, init, grant, baseline, overrideDir, effective, interview };
}

export interface AdoptOptions extends PositionCommonOptions {}

// The effective settings adoption compares before and after binding.
export interface EffectiveSettings {
  role: string;
  tools: string[];
  excludeTools: string[];
  resident: boolean;
  allowResidentShell: boolean;
  capabilities: string[];
}

export interface AdoptResult {
  agentDir: string;
  grant: HostGrant;
  baseline: RatifiedSnapshot;
  overrideDir: string;
  // The agent's effective settings BEFORE binding (today's path) and AFTER
  // binding (the grant/position resolver). Adoption REQUIRES these to be equal.
  before: EffectiveSettings;
  after: EffectiveSettings;
  soulHashBefore: string;
  soulHashAfter: string;
  diff: PositionDiff;
}

function settingsEqual(a: EffectiveSettings, b: EffectiveSettings): boolean {
  const norm = (s: EffectiveSettings) => ({
    role: s.role,
    tools: [...s.tools].sort(),
    excludeTools: [...s.excludeTools].sort(),
    resident: s.resident,
    allowResidentShell: s.allowResidentShell,
    capabilities: [...s.capabilities].sort(),
  });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// Name the settings that differ, for the refusal message.
function settingsDiffs(a: EffectiveSettings, b: EffectiveSettings): string[] {
  const out: string[] = [];
  if (a.role !== b.role) out.push(`role (${a.role} -> ${b.role})`);
  const diffSet = (label: string, x: string[], y: string[]) => {
    const xs = [...x].sort().join(", ") || "(none)";
    const ys = [...y].sort().join(", ") || "(none)";
    if (xs !== ys) out.push(`${label} (${xs} -> ${ys})`);
  };
  diffSet("tools", a.tools, b.tools);
  diffSet("excludeTools", a.excludeTools, b.excludeTools);
  diffSet("capabilities", a.capabilities, b.capabilities);
  if (a.resident !== b.resident) out.push(`resident (${a.resident} -> ${b.resident})`);
  if (a.allowResidentShell !== b.allowResidentShell)
    out.push(`allowResidentShell (${a.allowResidentShell} -> ${b.allowResidentShell})`);
  return out;
}

// Bind an EXISTING agent to a position.
export function adoptAgent(opts: AdoptOptions): AdoptResult {
  if (!AGENT_NAME.test(opts.name)) refuse(`invalid agent name ${JSON.stringify(opts.name)}.`);
  const hostRoot = resolveHostRoot(opts);
  const positionsRoot = opts.positionsRoot ?? DEFAULT_POSITIONS_ROOT;
  const now = opts.now ?? (() => new Date());

  const agentDir = join(opts.agentsRoot, opts.name);
  const yamlPath = join(agentDir, "bob.yaml");
  let yamlText: string;
  try {
    yamlText = readFileSync(yamlPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      refuse(
        `cannot adopt ${opts.name}: ${yamlPath} not found (run 'bob onboard ${opts.name}' first).`,
      );
    }
    throw err;
  }

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
  const before: EffectiveSettings = {
    role: existingRole,
    tools: beforePolicy.tools,
    excludeTools: beforePolicy.excludeTools,
    resident: beforePolicy.resident,
    allowResidentShell: beforePolicy.allowResidentShell,
    capabilities: beforeCaps,
  };

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

  const grant = grantFor(opts.name, position, role.tools.allowResidentShell === true, now);

  // The "after": the same requests under the grant/position resolver.
  const effective = resolveEffectiveConfig({
    yamlText,
    agentDir,
    position,
    grant,
  });

  const after: EffectiveSettings = {
    role: effective.role,
    tools: effective.tools,
    excludeTools: effective.excludeTools,
    resident: effective.resident,
    allowResidentShell: effective.allowResidentShell,
    capabilities: effective.capabilities,
  };

  // Adoption only binds when the two independently resolved configurations are
  // EQUAL. Otherwise the binding would silently change the agent's effective
  // settings — the opposite of "adopt without rewriting it".
  if (!settingsEqual(before, after)) {
    refuse(
      `cannot adopt ${opts.name}: the effective configuration before binding does not equal the one after binding — ${settingsDiffs(before, after).join("; ")}. Adoption binds only when the two resolutions agree; fix the position, the overrides or bob.yaml so they match.`,
    );
  }

  const soulHashBefore = soulHashOf(agentDir);
  writeGrant(hostRoot, grant);
  writeBindingMarker(agentDir, grant);
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
// — today's resolution is used untouched), else the effective configuration. A
// BOUND agent (its binding marker is present) whose grant is missing REFUSES:
// there is no fallback to legacy resolution once an agent has been adopted.
export function resolveAdoptedConfig(input: {
  name: string;
  agentDir: string;
  yamlText: string;
  hostRoot?: string;
  positionsRoot?: string;
  persistent?: boolean;
}): EffectiveConfig | undefined {
  const hostRoot = input.hostRoot ?? defaultHostRoot();
  const grant = readGrant(hostRoot, input.name);
  if (!grant) {
    const marker = readBindingMarker(input.agentDir);
    if (marker) {
      refuse(
        `${input.name} was bound to a position but its host grant is missing from the host state root (the binding marker ${bindingMarkerPath(input.agentDir)} is present). Refusing to boot an adopted agent whose trust root cannot be read — there is no fallback to legacy, unratified resolution. Restore the grant, or re-run 'bob position adopt ${input.name} --as <position>' with the operator; if the marker is stale, remove it.`,
      );
    }
    return undefined;
  }
  const position = loadPosition(grant.position.name, {
    root: input.positionsRoot ?? DEFAULT_POSITIONS_ROOT,
  });
  return resolveEffectiveConfig({
    yamlText: input.yamlText,
    agentDir: input.agentDir,
    position,
    grant,
    persistent: input.persistent,
  });
}

// `bob position diff` — the ratified baseline vs the current effective config.
export function positionDiff(input: {
  name: string;
  agentsRoot: string;
  hostRoot?: string;
  positionsRoot?: string;
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
  const effective = resolveEffectiveConfig({
    yamlText,
    agentDir,
    position,
    grant,
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

// Read the binding marker for an agent, for diagnostics.
export function readPositionMarker(agentDir: string): PositionBindingMarker | undefined {
  return readBindingMarker(agentDir);
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
export { computePositionDiff };
