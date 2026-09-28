// The ONE effective-configuration resolver (bob#195, slice 1).
//
// It combines the trust layers, in order, for an ADOPTED agent:
//
//   1. verify the position name/version/hash and the role name against the host
//      grant;
//   2. refuse, BY NAME, every requested tool or capability outside the ratified
//      maxima — before any intersection;
//   3. apply the narrow-only local disables (tools + capabilities);
//   4. run the EXISTING validators (resolveToolPolicy, resolveCapabilities) on
//      the result, and check host secret presence for the enabled set.
//
// An agent with NO grant is not adopted: the caller keeps today's resolution
// untouched, so an existing `bob init` agent keeps booting unchanged.
//
// The resolver runs before hire commits files, and again before every session.

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
import { missingSecrets, type SecretBindings } from "./secrets.js";
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
  bindings: SecretBindings;
  persistent?: boolean;
  // When true (hire + every session start) the enabled-only secret presence
  // check runs and refuses on a missing binding.
  checkSecrets?: boolean;
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
  // host-ratified maximum (a host trust root), never a position field.
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
    role: roleCeiling(grant.role, grant.maxTools, grant.allowResidentShell),
    resident: readResident(yamlText),
    persistent: input.persistent,
  });

  const resolution = resolveCapabilities({ yamlText, only: enabledCaps });

  // (5) Enabled-only host secret presence.
  if (input.checkSecrets !== false) {
    const missing = missingSecrets(position.manifest.secrets ?? [], enabledCaps, input.bindings);
    if (missing.length > 0) {
      refuse(
        `enabled capabilit${missing.length === 1 ? "y" : "ies"} require host secret${missing.length === 1 ? "" : "s"} that are not bound: ${missing.map((m) => `${m.capability} needs "${m.name}"`).join("; ")}. A position names a secret; the host supplies it. Bind it (BOB_SECRET_* or the host secrets file), or disable the capability.`,
      );
    }
  }

  // (6) Resolve packaged files against the allow-listed override layer.
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

// The ratified snapshot for `bob position diff`: the effective sets plus the
// resolved-file hashes and soul hash at ratification.
export function snapshotForDiff(config: EffectiveConfig, soulHash: string): RatifiedSnapshot {
  const files: Record<string, string> = {};
  for (const f of config.files) files[f.path] = hashString(f.content);
  return {
    tools: [...config.tools].sort(),
    capabilities: [...config.capabilities].sort(),
    files,
    soulHash,
    position: { name: "", version: "", hash: "" },
  };
}

export interface PositionDiff {
  tools: { added: string[]; removed: string[] };
  capabilities: { added: string[]; removed: string[] };
  files: { added: string[]; removed: string[]; changed: string[] };
  soulChanged: boolean;
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
  const bCaps = new Set(baseline.capabilities);
  const cCaps = new Set(current.capabilities);
  const files: Record<string, string> = {};
  for (const f of current.files) files[f.path] = hashString(f.content);

  const diff: PositionDiff = {
    tools: {
      added: [...cTools].filter((t) => !bTools.has(t)).sort(),
      removed: [...bTools].filter((t) => !cTools.has(t)).sort(),
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
    empty: false,
  };
  diff.empty =
    diff.tools.added.length === 0 &&
    diff.tools.removed.length === 0 &&
    diff.capabilities.added.length === 0 &&
    diff.capabilities.removed.length === 0 &&
    diff.files.added.length === 0 &&
    diff.files.removed.length === 0 &&
    diff.files.changed.length === 0 &&
    !diff.soulChanged;
  return diff;
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
