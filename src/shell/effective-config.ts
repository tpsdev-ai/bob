// The ONE effective-configuration resolver (bob#195, slice 1).
//
// It combines the trust layers, in order, for an ADOPTED agent:
//
//   1. verify the position name/hash AND the position's role + version against
//      the host grant, and load the CURRENT packaged role the grant ratified;
//   2. refuse, BY NAME, every requested tool or capability outside the ratified
//      maxima — before any intersection;
//   3. apply the narrow-only local disables (tools + capabilities);
//   4. run the EXISTING validators (resolveToolPolicy, resolveCapabilities) on
//      the result, with BOTH the packaged role's ceiling and the grant maximum
//      enforced.
//
// An agent with NO grant is not adopted: the caller keeps today's resolution
// untouched, so an existing `bob init` agent keeps booting unchanged.
//
// The resolver runs before hire commits files, and again before every session.
//
// Slice 1 ships NO secret bindings: a position that declares a secret is refused
// (position-runtime.ts), so there is nothing to bind here.

import { createHash } from "node:crypto";
import {
  readAgentRole,
  readCapabilities,
  readResident,
  readTools,
  type ToolsBlock,
} from "./bob-yaml.js";
import { lookupCapability } from "./capability-catalog.js";
import { capabilityConfigEnv, resolveCapabilities } from "./capability-loader.js";
import type { HostGrant, RatifiedSnapshot } from "./host-grant.js";
import { loadOverrides, type Overrides, resolvePositionFiles } from "./overrides.js";
import type { LoadedPosition } from "./positions.js";
import { loadRole } from "./role-loader.js";
import { type RoleToolCeiling, resolveToolNames, resolveToolPolicy } from "./tool-allowlist.js";

export interface ResolvedPositionFile {
  path: string;
  kind: string;
  source: "position" | "override";
  content: string;
}

export interface EffectiveConfig {
  role: string;
  tools: string[];
  excludeTools: string[];
  resident: boolean;
  allowResidentShell: boolean;
  capabilities: string[];
  files: ResolvedPositionFile[];
  extensionSources: string[];
  capabilityBySource: Record<string, string>;
  capabilityEnv: Record<string, string>;
}

export interface EffectiveConfigInputs {
  yamlText: string;
  agentDir: string;
  position: LoadedPosition;
  grant: HostGrant;
  overrides?: Overrides;
  persistent?: boolean;
}

function refuse(detail: string): never {
  throw new Error(`bob: ${detail}`);
}

// The role ceiling must cover the position's requested tools, and the grant's
// ratified role must be a role bob ships. Used at hire and at boot.
export function roleCeiling(
  roleName: string,
  allow: readonly string[],
  allowResidentShell: boolean,
): RoleToolCeiling {
  return { name: roleName, allow, allowResidentShell };
}

export function resolveEffectiveConfig(input: EffectiveConfigInputs): EffectiveConfig {
  const { yamlText, agentDir, position, grant } = input;

  // (1) The position identity and the role are pinned by the grant.
  if (position.manifest.name !== grant.position.name) {
    refuse(
      `this agent is bound to position "${grant.position.name}", but "${position.manifest.name}" was loaded. The binding is host-ratified and cannot be changed by bob.yaml.`,
    );
  }
  if (position.hash !== grant.position.hash) {
    refuse(
      `the "${position.manifest.name}" position on disk does not match the host-ratified hash (ratified ${grant.position.hash}, found ${position.hash}). Refusing to boot on an unratified position; re-run 'bob position adopt' with the operator.`,
    );
  }
  // The manifest's role AND version are pinned by the grant too. The hash covers
  // the manifest, but a grant is the thing that must be compared EXPLICITLY:
  // name/hash alone would let a future re-hash of a drifted manifest pass.
  if (position.manifest.role !== grant.role) {
    refuse(
      `the "${position.manifest.name}" position names role "${position.manifest.role}", but the host grant ratified role "${grant.role}". A position's role is pinned by the binding and cannot be changed.`,
    );
  }
  if (position.manifest.version !== grant.position.version) {
    refuse(
      `the "${position.manifest.name}" position is version "${position.manifest.version}", but the host grant ratified version "${grant.position.version}". Refusing to boot on an unratified position version; re-run 'bob position adopt' with the operator.`,
    );
  }

  // Load and validate the CURRENT packaged role the grant ratified. The role is
  // the tool ceiling; it has to be readable and its names usable, exactly as
  // resolveAgentToolPolicy requires on the non-adopted path.
  const role = loadRole(grant.role as never);

  // The instance's declared role must be the ratified one.
  const roleBlock = readAgentRole(yamlText);
  if (roleBlock !== grant.role) {
    refuse(
      `agent.role is "${roleBlock}", but the host grant for this agent ratified the role "${grant.role}". Changing bob.yaml cannot select another role; the role is part of the ratified trust root.`,
    );
  }

  // (2) Refuse requested tools/capabilities outside the ratified maxima FIRST.
  const block = readTools(yamlText);
  if (block === undefined || block.allow === undefined) {
    refuse(
      `bob.yaml has no tools.allow block — the role's allowlist must be declared. (An adopted agent is still governed by its role's allowlist.)`,
    );
  }
  const requestedTools = resolveToolNames(block.allow, yamlText);
  const maxTools = new Set(grant.maxTools);
  const widened = requestedTools.filter((t) => !maxTools.has(t));
  if (widened.length > 0) {
    refuse(
      `bob.yaml requests tool${widened.length === 1 ? "" : "s"} outside the host-ratified set: ${widened.join(", ")}. The ratified maximum is ${grant.maxTools.join(", ") || "(none)"}. Widening the tool set is a load error — a grant is a host decision, not a bob.yaml edit.`,
    );
  }

  const permitted = new Set(position.manifest.capabilities.permitted);
  const maxCaps = new Set(grant.maxCapabilities);
  const requested = readCapabilities(yamlText);
  for (const name of requested) {
    const entry = lookupCapability(name);
    if (!entry || entry.notYetImplemented) {
      refuse(`capability "${name}" is not a blessed, implemented capability.`);
    }
    if (!permitted.has(name)) {
      refuse(
        `bob.yaml requests capability "${name}", which the "${position.manifest.name}" position does not permit. A capability can only be enabled if the position permits it and the host grant ratifies it.`,
      );
    }
    if (!maxCaps.has(name)) {
      refuse(
        `bob.yaml requests capability "${name}", which is outside the host-ratified capability set (${grant.maxCapabilities.join(", ") || "(none)"}). Enabling a capability is a host grant, not a bob.yaml edit.`,
      );
    }
  }

  // (3) Narrow-only local disables.
  const overrides = input.overrides ?? loadOverrides(agentDir);
  const disabledTools = new Set(overrides?.disable.tools ?? []);
  const disabledCaps = new Set(overrides?.disable.capabilities ?? []);
  const enabledTools = requestedTools.filter((t) => !disabledTools.has(t));
  const enabledCaps = requested.filter((c) => !disabledCaps.has(c));

  // (4) The existing validators, on the narrowed result. The ceiling is the
  // PACKAGED ROLE's allow list (the same ceiling every non-adopted session
  // gets); the host-ratified maximum was already enforced above, so a session
  // holds neither more than the role allows nor more than the grant ratified.
  const narrowed: ToolsBlock = {
    allow: enabledTools,
    ...(block.exclude !== undefined ? { exclude: block.exclude } : {}),
    ...(block.allowResidentShell !== undefined
      ? { allowResidentShell: block.allowResidentShell }
      : {}),
  };
  const policy = resolveToolPolicy({
    yamlText,
    tools: narrowed,
    role: roleCeiling(role.role, role.tools.allow, grant.allowResidentShell),
    resident: readResident(yamlText),
    persistent: input.persistent,
  });

  const resolution = resolveCapabilities({ yamlText, only: enabledCaps });

  // (5) Resolve packaged files against the allow-listed override layer.
  const resolvedFiles = resolvePositionFiles(position, agentDir);
  const files: ResolvedPositionFile[] = position.manifest.files.map((f) => ({
    path: f.path,
    kind: f.kind,
    source: resolvedFiles.sources[f.path] ?? "position",
    content: resolvedFiles.files[f.path] ?? "",
  }));

  return {
    role: grant.role,
    tools: policy.tools,
    excludeTools: policy.excludeTools,
    resident: policy.resident,
    allowResidentShell: policy.allowResidentShell,
    capabilities: resolution.capabilities.map((c) => c.name),
    files,
    extensionSources: resolution.extensionSources,
    capabilityBySource: Object.fromEntries(
      resolution.capabilities.map((c) => [c.piPackage, c.name]),
    ),
    capabilityEnv: capabilityConfigEnv(resolution),
  };
}

// The ratified snapshot for `bob position diff`: the complete set of effective
// SETTINGS `bob position diff` is responsible for comparing, plus the resolved
// file hashes and soul hash at ratification. It stores the settings the spec
// covers — role, tool allow list, tool exclusions, the residency decision, the
// resident-shell grant, the capability set — so a change to ANY of them shows
// as drift, not just a change to tools/capabilities/files/soul.
export function snapshotForDiff(config: EffectiveConfig, soulHash: string): RatifiedSnapshot {
  const files: Record<string, string> = {};
  for (const f of config.files) files[f.path] = hashString(f.content);
  return {
    role: config.role,
    tools: [...config.tools].sort(),
    excludeTools: [...config.excludeTools].sort(),
    resident: config.resident,
    allowResidentShell: config.allowResidentShell,
    capabilities: [...config.capabilities].sort(),
    files,
    soulHash,
    // The position identity is bookkeeping: it lives in the grant, and callers
    // overwrite this placeholder from the grant. An empty default here is
    // intentional (see position-runtime.ts).
    position: { name: "", version: "", hash: "" },
  };
}

export interface PositionDiff {
  roleChanged: boolean;
  tools: { added: string[]; removed: string[] };
  excludeTools: { added: string[]; removed: string[] };
  capabilities: { added: string[]; removed: string[] };
  files: { added: string[]; removed: string[]; changed: string[] };
  soulChanged: boolean;
  residentChanged: boolean;
  allowResidentShellChanged: boolean;
  empty: boolean;
}

// Compare the current effective configuration to the ratified baseline, EXCLUDING
// bookkeeping metadata. A non-empty diff means the instance drifted from what
// the operator ratified.
export function computePositionDiff(
  baseline: RatifiedSnapshot,
  current: EffectiveConfig,
  soulHash: string,
): PositionDiff {
  const bTools = new Set(baseline.tools);
  const cTools = new Set(current.tools);
  const bExclude = new Set(baseline.excludeTools);
  const cExclude = new Set(current.excludeTools);
  const bCaps = new Set(baseline.capabilities);
  const cCaps = new Set(current.capabilities);
  const files: Record<string, string> = {};
  for (const f of current.files) files[f.path] = hashString(f.content);

  const diff: PositionDiff = {
    roleChanged: baseline.role !== current.role,
    tools: {
      added: [...cTools].filter((t) => !bTools.has(t)).sort(),
      removed: [...bTools].filter((t) => !cTools.has(t)).sort(),
    },
    excludeTools: {
      added: [...cExclude].filter((t) => !bExclude.has(t)).sort(),
      removed: [...bExclude].filter((t) => !cExclude.has(t)).sort(),
    },
    capabilities: {
      added: [...cCaps].filter((c) => !bCaps.has(c)).sort(),
      removed: [...bCaps].filter((c) => !cCaps.has(c)).sort(),
    },
    files: {
      added: Object.keys(files)
        .filter((p) => !(p in baseline.files))
        .sort(),
      removed: Object.keys(baseline.files)
        .filter((p) => !(p in files))
        .sort(),
      changed: Object.keys(files)
        .filter((p) => p in baseline.files && baseline.files[p] !== files[p])
        .sort(),
    },
    soulChanged: baseline.soulHash !== soulHash,
    residentChanged: baseline.resident !== current.resident,
    allowResidentShellChanged: baseline.allowResidentShell !== current.allowResidentShell,
    empty: false,
  };
  diff.empty =
    !diff.roleChanged &&
    diff.tools.added.length === 0 &&
    diff.tools.removed.length === 0 &&
    diff.excludeTools.added.length === 0 &&
    diff.excludeTools.removed.length === 0 &&
    diff.capabilities.added.length === 0 &&
    diff.capabilities.removed.length === 0 &&
    diff.files.added.length === 0 &&
    diff.files.removed.length === 0 &&
    diff.files.changed.length === 0 &&
    !diff.soulChanged &&
    !diff.residentChanged &&
    !diff.allowResidentShellChanged;
  return diff;
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
