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
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
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
  baselinePath,
  bindingMarkerPath,
  defaultHostRoot,
  grantPath,
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
import { initOverrideRepo, overridesDir } from "./overrides.js";
import { DEFAULT_POSITIONS_ROOT, type LoadedPosition, loadPosition } from "./positions.js";
import { defaultProviderName, type ProviderRegistry } from "./provider-registry.js";
import { loadRole } from "./role-loader.js";
import { assertProviderRunnable, mapBobProviderToPi, resolveAgentToolPolicy } from "./run.js";
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

// --- Re-binding is refused: ordinary hire and adoption only ever CREATE a
// binding. An agent that already carries a grant, a binding marker or a baseline
// is refused by name (each occupied path) and the refusal says re-binding is not
// supported in this slice. An explicit re-bind operation, which would preserve
// the prior record, is deferred to a later slice.

// The agent's current position, read from the grant when it parses, else from the
// binding marker. Undefined when neither is readable (the occupied file holds
// arbitrary bytes) — the refusal then simply omits the position.
function readablePosition(hostRoot: string, agentDir: string, name: string): string | undefined {
  try {
    const g = readGrant(hostRoot, name);
    if (g && typeof g.position?.name === "string" && g.position.name !== "") {
      return typeof g.position.version === "string" && g.position.version !== ""
        ? `${g.position.name} ${g.position.version}`
        : g.position.name;
    }
  } catch {
    // An unreadable or unparsable grant is still OCCUPIED state; just unnamed here.
  }
  const m = readBindingMarker(agentDir);
  if (m && typeof m.position === "string" && m.position !== "") return m.position;
  return undefined;
}

// Occupancy and rollback ownership concern directory entries, not their targets.
// Only ENOENT proves absence; an unreadable entry must never be claimed as ours.
function entryPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

// Refuse when ANY ratification path is already occupied. Runs BEFORE any write.
function assertUnoccupied(hostRoot: string, agentDir: string, name: string): void {
  const occupied: string[] = [];
  const gp = grantPath(hostRoot, name);
  const mp = bindingMarkerPath(agentDir);
  const bp = baselinePath(hostRoot, name);
  if (entryPresent(gp)) occupied.push(`grant ${gp}`);
  if (entryPresent(mp)) occupied.push(`binding marker ${mp}`);
  if (entryPresent(bp)) occupied.push(`baseline ${bp}`);
  if (occupied.length === 0) return;
  const current = readablePosition(hostRoot, agentDir, name);
  refuse(
    `refusing to bind "${name}": ratification state for this agent already exists (${occupied.join(", ")}).` +
      (current !== undefined ? ` Its current position is "${current}".` : "") +
      ` Re-binding an already-bound agent is not supported in this slice; remove the existing record deliberately to bind "${name}" afresh.`,
  );
}

// The stages of a bind, after each of which a test may inject a failure. `scaffold`
// and `interview` are the pre-commit steps that WRITE (the scaffold and the
// interview's refined soul); the rest are the file commit.
export type BindStep = "scaffold" | "interview" | "grant" | "marker" | "baseline" | "override-repo";

export interface BindHooks {
  // Test-only failure-injection seam: invoked AFTER each bind step, so a test can
  // throw at a chosen step and prove the rollback removes exactly what this
  // operation created. Never set in production.
  afterStep?: (step: BindStep) => void;
}

// The ledger of paths THIS operation creates, so a later failure removes exactly
// them and nothing else. When the agent directory was created here, every
// scaffold file (including the marker and the override repository) lives inside
// it, so removing it is complete; for adoption the agent directory pre-exists, so
// only the marker, the override repository (when this operation created it) and
// the host grant/baseline are removed.
interface BindTxn {
  agentDir: string;
  agentDirCreated: boolean;
  markerPath?: string;
  overrideDirCreated: boolean;
  grantPath?: string;
  baselinePath?: string;
}

function rollbackBind(tx: BindTxn): void {
  if (tx.agentDirCreated) {
    rmSync(tx.agentDir, { recursive: true, force: true });
  } else {
    if (tx.markerPath !== undefined) rmSync(tx.markerPath, { force: true });
    if (tx.overrideDirCreated) rmSync(overridesDir(tx.agentDir), { recursive: true, force: true });
  }
  if (tx.grantPath !== undefined) rmSync(tx.grantPath, { force: true });
  if (tx.baselinePath !== undefined) rmSync(tx.baselinePath, { force: true });
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
  // The validated provider selection (loaded once by the CLI). Names the default
  // provider to hire onto and maps a caller's provider name; never re-loaded
  // here.
  registry?: ProviderRegistry;
  // bob#214: the model's context window, written to bob.yaml (see initAgent).
  // Required: hireAgent refuses before writing anything without it.
  contextWindow?: number;
  skipFlair?: boolean;
  flairKeysDir?: string;
  flairUrl?: string;
  // Test seam for the hiring interview (defaults to pi's InteractiveMode). The
  // interview runs AFTER candidate validation and scaffolding, and may rewrite
  // soul.md; the baseline is snapshotted from the result.
  interview?: SessionRunner;
  deps?: SessionDeps;
  // Test seam: a function called after each bind step, so a test can inject a
  // failure and prove the rollback. See BindHooks.
  commitHook?: (step: BindStep) => void;
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

const DEFAULT_MODEL = "claude-sonnet-4-6";

// Hire a NEW agent from a packaged position. ASYNC because it runs the existing
// onboarding interview after the candidate is validated and scaffolded.
//
// Order: EVERY deterministic refusal runs before anything is written; the
// scaffold and interview then run under a transaction, and the file commit
// (grant, marker, baseline, override repository) removes everything THIS
// operation created on any later failure. So a refused hire — including a failed
// interview — leaves no scaffold and no half-written binding.
export async function hireAgent(opts: HireOptions): Promise<HireResult> {
  if (!AGENT_NAME.test(opts.name)) refuse(`invalid agent name ${JSON.stringify(opts.name)}.`);
  if (opts.skipFlair === false) {
    refuse(
      "Flair provisioning is not supported for hire in slice 1. Use bob onboard for a Flair identity.",
    );
  }
  const hostRoot = resolveHostRoot(opts);
  const positionsRoot = opts.positionsRoot ?? DEFAULT_POSITIONS_ROOT;
  const now = opts.now ?? (() => new Date());
  const agentDir = join(opts.agentsRoot, opts.name);

  // --- Deterministic refusals. NONE of these writes anything. ---
  const position = loadPosition(opts.positionName, { root: positionsRoot });
  const role = loadRole(position.manifest.role as never);
  assertPositionAgainstRole(position, role.tools.allow);
  assertUnoccupied(hostRoot, agentDir, opts.name);

  const provider = opts.provider ?? defaultProviderName("hire", opts.registry);
  const model = opts.model ?? DEFAULT_MODEL;
  // The provider/runtime-key refusal the interview session would otherwise raise
  // AFTER the scaffold exists. Run it up front so a missing key leaves nothing.
  assertProviderRunnable(
    mapBobProviderToPi(provider, opts.registry),
    `bob hire ${opts.name}`,
    opts.registry,
  );
  // bob#214: likewise the context window. The interview is a session, and every
  // session refuses to start without the model's declared window, so a hire
  // without one would scaffold and then fail its interview. Refuse it here.
  if (opts.contextWindow === undefined) {
    refuse(
      `bob hire ${opts.name}: --context-window <tokens> is required — the context window the server enforces for ${provider}/${model}. bob writes it to bob.yaml as provider.context_window and refuses to start a session (the hiring interview included) without it. Nothing was written.`,
    );
  }

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
    agent: opts.name,
    agentDir,
    position,
    grant,
  });
  // The position supplies the seed persona, but the agent's OWN identity (the
  // header initAgent stamps) stays on top: the seed soul is the identity plus
  // the position's persona, never the generic packaged soul alone.
  const soulFile = effective.files.find((f) => f.kind === "soul");

  // --- The bind: scaffold, interview and the file commit, under a rollback. ---
  const tx: BindTxn = {
    agentDir,
    agentDirCreated: !entryPresent(agentDir),
    overrideDirCreated: false,
  };
  try {
    const init = initAgent({
      name: opts.name,
      role: position.manifest.role as never,
      provider,
      model,
      agentsRoot: opts.agentsRoot,
      ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
      capabilities: position.manifest.capabilities.default,
      toolAllow: position.manifest.tools,
      skipFlair: opts.skipFlair ?? true,
      ...(soulFile !== undefined ? { soulBody: soulFile.content } : {}),
      ...(opts.flairKeysDir !== undefined ? { flairKeysDir: opts.flairKeysDir } : {}),
      ...(opts.flairUrl !== undefined ? { flairUrl: opts.flairUrl } : {}),
      ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
    });
    opts.commitHook?.("scaffold");

    // The hiring interview runs after candidate validation and scaffolding. It
    // refines the seed soul (which already carries the agent's identity). A
    // nonzero exit is a FAILED hire: nothing is committed.
    const interview = await runOnboard({
      name: opts.name,
      role: position.manifest.role,
      agentDir: init.agentDir,
      provider,
      model,
      hostRoot,
      positionsRoot,
      ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
      ...(opts.interview !== undefined ? { sessionRunner: opts.interview } : {}),
      ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
    });
    if (interview.exitCode !== 0) {
      refuse(
        `the onboarding interview for "${opts.name}" exited with code ${interview.exitCode}; a failed interview is a failed hire, so nothing was committed.`,
      );
    }
    opts.commitHook?.("interview");

    writeGrant(hostRoot, grant);
    tx.grantPath = grantPath(hostRoot, opts.name);
    opts.commitHook?.("grant");

    writeBindingMarker(init.agentDir, grant);
    tx.markerPath = bindingMarkerPath(init.agentDir);
    opts.commitHook?.("marker");

    // The baseline is snapshotted AFTER the interview: what the operator ratified
    // is the agent as it now stands, so `position diff` is empty immediately.
    const baseline = snapshotForDiff(effective, soulHashOf(init.agentDir));
    baseline.position = grant.position;
    writeBaseline(hostRoot, opts.name, baseline);
    tx.baselinePath = baselinePath(hostRoot, opts.name);
    opts.commitHook?.("baseline");

    tx.overrideDirCreated = !entryPresent(overridesDir(init.agentDir));
    const overrideDir = initOverrideRepo(init.agentDir);
    opts.commitHook?.("override-repo");

    return { agentDir: init.agentDir, init, grant, baseline, overrideDir, effective, interview };
  } catch (err) {
    rollbackBind(tx);
    throw err;
  }
}

export interface AdoptOptions extends PositionCommonOptions {
  // Test seam: a function called after each bind step, so a test can inject a
  // failure and prove the rollback. See BindHooks.
  commitHook?: (step: BindStep) => void;
}

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
  // Re-binding is refused: an agent that already carries a grant, a binding
  // marker or a baseline is refused by name BEFORE anything is written.
  assertUnoccupied(hostRoot, agentDir, opts.name);
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
    agent: opts.name,
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

  // --- The file commit, under a rollback. The agent directory PRE-EXISTS (it was
  // scaffolded by bob init), so on a later failure only the marker, the override
  // repository (when this operation created it) and the host grant/baseline are
  // removed — the existing bob.yaml, soul.md and any other file are untouched. ---
  const tx: BindTxn = { agentDir, agentDirCreated: false, overrideDirCreated: false };
  try {
    const soulHashBefore = soulHashOf(agentDir);
    writeGrant(hostRoot, grant);
    tx.grantPath = grantPath(hostRoot, opts.name);
    opts.commitHook?.("grant");

    writeBindingMarker(agentDir, grant);
    tx.markerPath = bindingMarkerPath(agentDir);
    opts.commitHook?.("marker");

    const baseline = snapshotForDiff(effective, soulHashBefore);
    baseline.position = grant.position;
    writeBaseline(hostRoot, opts.name, baseline);
    tx.baselinePath = baselinePath(hostRoot, opts.name);
    opts.commitHook?.("baseline");

    tx.overrideDirCreated = !entryPresent(overridesDir(agentDir));
    const overrideDir = initOverrideRepo(agentDir);
    opts.commitHook?.("override-repo");

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
  } catch (err) {
    rollbackBind(tx);
    throw err;
  }
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
    agent: input.name,
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
    agent: input.name,
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
