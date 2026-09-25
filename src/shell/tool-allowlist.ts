// The tool names a bob.yaml `tools:` block may carry, and the resident policy
// that narrows them.
//
// Two facts made the role tool allowlist inert:
//
//   1. nothing read bob.yaml's `tools:` block back, so every agent got pi's
//      defaults (read, bash, edit, write) plus capability tools, whatever its
//      role said;
//   2. the names the shipped roles carried (Bash, Read, WebFetch,
//      mcp__plugin_discord_discord__reply) are OpenClaw/Claude-Code casings
//      pi's registry does not know, and pi ignores unknown names SILENTLY
//      (`setActiveToolsByName`: "Unknown tool names are ignored").
//
// So every name is resolved here against the set of tools that can actually
// exist — pi's built-ins plus the tools the blessed capabilities register — and
// anything else is refused BY NAME, with the replacement when there is one.
// Never a silent drop.
//
// Names are never rewritten: a stale name in an existing agent's bob.yaml is a
// loud error plus a `bob doctor` fix line, not a translation. Translating would
// leave the file quietly wrong, which is what this whole area is recovering
// from.

import { BobYamlError, lineOf, type ToolsBlock } from "./bob-yaml.js";
import { BLESSED_CATALOG } from "./capability-catalog.js";

// pi's built-in tools. Source: the installed pi-coding-agent, docs/usage.md
// ("Built-in tools: read, bash, powershell (Windows), edit, write, grep, find,
// ls") and core/tools/*. `find` is pi's file-glob equivalent — there is no
// `glob`. Note `powershell` is Windows' shell, so a policy that drops the shell
// must drop both names.
export const PI_BUILTIN_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "powershell",
] as const;

// What a resident agent must not hold unless its role opts in: a shell and the
// tools that write files. A resident agent runs unattended behind its service
// unit, with no human at the keyboard to approve a command.
export const RESIDENT_EXCLUDED_TOOLS = ["bash", "write", "edit", "powershell"] as const;

// Names that existed in the OpenClaw / Claude-Code tool set and DO map onto a
// real name here — used only to say which one in the error and in doctor's fix
// line. Keyed lowercase.
const LEGACY_RENAMES: Record<string, string> = {
  glob: "find",
  mcp__flair__search: "flair_search",
  mcp__flair__write: "flair_write",
  mcp__flair__get: "flair_get",
  mcp__plugin_discord_discord__reply: "discord_reply",
  mcp__plugin_discord_discord__fetch: "discord_fetch",
  mcp__plugin_discord_discord__fetch_messages: "discord_fetch",
  mcp__plugin_discord_discord__react: "discord_react",
};

// Names from the same tool set that have NO equivalent at all: the migration
// there is deletion. pi ships no web tool, and the shipped roles used to carry
// WebFetch / WebSearch on that assumption.
const NO_EQUIVALENT: Record<string, string> = {
  webfetch: "pi ships no web-fetch tool",
  websearch: "pi ships no web-search tool",
};

export interface ToolNameProblem {
  name: string;
  // Why the name cannot be enabled.
  detail: string;
  // What to do about it — the replacement name, or "remove it".
  hint: string;
}

export interface ToolNameAudit {
  resolved: string[];
  problems: ToolNameProblem[];
}

// tool name -> the blessed, BUILT capability that registers it. A name bound to
// a capability whose extension does not exist yet is not a name pi could ever
// enable, so unbuilt entries are indexed separately (below) to give a precise
// error instead of a generic one.
function builtCapabilityTools(): Map<string, string> {
  const index = new Map<string, string>();
  for (const [capability, entry] of Object.entries(BLESSED_CATALOG)) {
    if (entry.notYetImplemented) continue;
    for (const tool of entry.manifest.provides?.tools ?? []) index.set(tool, capability);
  }
  return index;
}

// tool name -> the blessed capability that declares it but has no extension
// yet. Same catalog, the other side of `notYetImplemented`.
function unbuiltCapabilityTools(): Map<string, string> {
  const index = new Map<string, string>();
  for (const [capability, entry] of Object.entries(BLESSED_CATALOG)) {
    if (!entry.notYetImplemented) continue;
    for (const tool of entry.manifest.provides?.tools ?? []) index.set(tool, capability);
  }
  return index;
}

// The names an agent may allow: pi's built-ins plus the built capabilities'
// tools. Sorted, for the error text and for doctor.
export function knownToolNames(): string[] {
  return [...new Set([...PI_BUILTIN_TOOLS, ...builtCapabilityTools().keys()])].sort();
}

// Audit an allowlist/exclude list without throwing: which names are usable and
// which are not. Callers that must fail loudly use resolveToolNames below.
export function auditToolNames(names: readonly string[]): ToolNameAudit {
  const built = builtCapabilityTools();
  const unbuilt = unbuiltCapabilityTools();
  const resolved: string[] = [];
  const problems: ToolNameProblem[] = [];

  for (const raw of names) {
    const name = raw.trim();
    if ((PI_BUILTIN_TOOLS as readonly string[]).includes(name) || built.has(name)) {
      resolved.push(name);
      continue;
    }
    problems.push({ name, ...describeUnknown(name, built, unbuilt) });
  }
  return { resolved, problems };
}

// Resolve an allowlist, throwing on the first block's worth of bad names. The
// message carries every offending name (one bob.yaml edit fixes them all), the
// known names, and the replacement per name.
export function resolveToolNames(names: readonly string[], yamlText: string): string[] {
  const { resolved, problems } = auditToolNames(names);
  if (problems.length === 0) return resolved;
  throw new BobYamlError(
    "tools",
    toolNameLine(yamlText, problems[0].name),
    `${problems.length === 1 ? "this name is" : "these names are"} not a tool pi can enable: ` +
      `${problems.map((p) => `${p.name} (${p.hint})`).join("; ")}. ` +
      `pi ignores an unknown tool name silently, so it would be dropped from the session. ` +
      `Known names: ${knownToolNames().join(", ")}.`,
  );
}

function describeUnknown(
  name: string,
  built: Map<string, string>,
  unbuilt: Map<string, string>,
): { detail: string; hint: string } {
  const detail = "not a pi built-in or a blessed capability tool";
  const lower = name.toLowerCase();

  // Case-only difference from a real name — the OpenClaw-era casing (Bash,
  // Read, WebFetch) is the common case in existing bob.yaml files.
  const canonical =
    [...PI_BUILTIN_TOOLS, ...built.keys()].find((tool) => tool === lower) ??
    [...PI_BUILTIN_TOOLS, ...built.keys()].find((tool) => tool.toLowerCase() === lower);
  if (canonical && canonical !== name) {
    return { detail, hint: `the pi name is "${canonical}" — rename it in bob.yaml` };
  }

  const renamed = LEGACY_RENAMES[lower];
  if (renamed) return { detail, hint: `use "${renamed}"` };

  const without = NO_EQUIVALENT[lower];
  if (without) return { detail, hint: `remove it (${without})` };

  const capability = unbuilt.get(name);
  if (capability) {
    return {
      detail,
      hint: `belongs to the "${capability}" capability, which is blessed but not implemented yet — remove it`,
    };
  }
  return { detail, hint: "remove it, or add the capability that would provide it" };
}

// 1-based line of `- <name>` inside the top-level `tools:` block, so the error
// points at the line to edit. Falls back to the block's own line.
function toolNameLine(yamlText: string, name: string): number {
  const lines = yamlText.split(/\r?\n/);
  let inTools = false;
  let blockLine = lineOf(yamlText, /^tools[ \t]*:/m);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
      inTools = /^tools\s*:/.test(line);
      if (inTools) blockLine = i + 1;
      continue;
    }
    if (!inTools) continue;
    const t = line.trim();
    if (t.startsWith("-") && stripQuotes(t.slice(1).trim()) === name) return i + 1;
  }
  return blockLine;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

// The role's own tool policy (roles/<role>/role.json `tools`) — the CEILING.
// role.json ships with bob; bob.yaml is agent-writable. So bob.yaml may narrow
// this list, never widen it (see resolveToolPolicy).
export interface RoleToolCeiling {
  // The role's name, for error text. The ceiling is a file inside bob, not in
  // the agent's directory, so the message has to say which role.
  name: string;
  // Tool names the role allows (role.json `tools.allow`).
  allow: readonly string[];
  // True when the role itself opts the agent back into the resident shell +
  // file-writing tools (role.json `tools.allowResidentShell`).
  allowResidentShell?: boolean;
}

export interface ResolveToolPolicyOptions {
  // The parsed `tools:` block (bob-yaml.ts readTools), if bob.yaml has one.
  tools?: ToolsBlock;
  // The role's ceiling (role.json). Every path that starts a session passes it
  // (resolveAgentToolPolicy); optional at this level so a unit test can
  // exercise the block on its own.
  role?: RoleToolCeiling;
  // bob.yaml's top-level `resident:` flag.
  resident?: boolean;
  // The lifespan the session will run in. The persistent runtime is resident
  // whether or not bob.yaml says so (an agent running unattended behind its
  // service unit is resident by definition).
  persistent?: boolean;
  // bob.yaml text, for error line numbers.
  yamlText: string;
}

// The policy a session gets: pi's strict allowlist, the denylist applied after
// it, and the residency decision.
//
// `tools` is ALWAYS an array, never undefined. An agent that declares no
// allowlist is a load ERROR: pi's own defaults (read, bash, edit, write) are
// not a policy, they are the absence of one, and this whole area exists
// because "absent" quietly became "everything pi ships". An explicit empty
// list is how an agent says "no tools". `excludeTools` is always an array.
export interface ToolPolicy {
  tools: string[];
  excludeTools: string[];
  resident: boolean;
  allowResidentShell: boolean;
}

export function resolveToolPolicy(opts: ResolveToolPolicyOptions): ToolPolicy {
  const block = opts.tools;

  // Fail closed on a missing allowlist. Three shapes mean the same thing and
  // all three are refused: no `tools:` block, a `tools:` block with no
  // `allow:`, and the inline form (refused in bob-yaml.ts readTools). The old
  // reading — "no block means pi's defaults" — is what made the allowlist
  // inert; pi's defaults are not a decision bob.yaml made.
  if (block === undefined) {
    throw new BobYamlError(
      "tools",
      lineOf(opts.yamlText, /^tools[ \t]*:/m),
      `bob.yaml has no tools: block — declare the role's allowlist under "tools:" with "allow:" (an explicit empty list means no tools). Without one pi falls back to its own defaults (read, bash, edit, write), which is not a policy.`,
    );
  }
  if (block.allow === undefined) {
    throw new BobYamlError(
      "tools",
      lineOf(opts.yamlText, /^tools[ \t]*:/m),
      `the tools: block declares no allow: list — an allowlist is required ("allow:" with no items means no tools).`,
    );
  }

  const resident = opts.resident === true || opts.persistent === true;
  const tools = resolveToolNames(block.allow, opts.yamlText);
  const declaredExclusions =
    block.exclude === undefined ? [] : resolveToolNames(block.exclude, opts.yamlText);

  // The role is the ceiling. A subset is fine — an agent may always hold fewer
  // tools than its role allows — but a name the role does not allow is a
  // widening, and widening is a load error: bob.yaml is the file the agent can
  // edit, so without this the role would be a default rather than a bound.
  const ceiling = opts.role;
  let allowResidentShell = block.allowResidentShell === true;
  if (ceiling) {
    const roleAllows = new Set(roleToolNames(ceiling));
    const widened = tools.filter((name) => !roleAllows.has(name));
    if (widened.length > 0) {
      throw new BobYamlError(
        "tools",
        toolNameLine(opts.yamlText, widened[0]),
        `bob.yaml widens the tool allowlist beyond the "${ceiling.name}" role: ${widened.join(
          ", ",
        )} ${widened.length === 1 ? "is" : "are"} not in the role. The role is the ceiling — roles/${ceiling.name}/role.json allows ${[...roleAllows].sort().join(", ")}. Move the name into that role, or drop it here.`,
      );
    }
    if (allowResidentShell && ceiling.allowResidentShell !== true) {
      throw new BobYamlError(
        "tools",
        lineOf(opts.yamlText, /^tools[ \t]*:/m),
        `bob.yaml widens the tool allowlist beyond the "${ceiling.name}" role: tools.allowResidentShell is true, but the role does not grant it. A resident agent loses the shell + the file-writing tools unless its ROLE opts back in (roles/${ceiling.name}/role.json).`,
      );
    }
    // The role's grant is inherited; bob.yaml may still narrow it away.
    allowResidentShell = ceiling.allowResidentShell === true && block.allowResidentShell !== false;
  }

  const residentExclusions = resident && !allowResidentShell ? [...RESIDENT_EXCLUDED_TOOLS] : [];

  return {
    tools,
    // A declared exclusion wins over the allowlist (pi applies `excludeTools`
    // after `tools`), and the resident policy rides on top of both.
    excludeTools: [...new Set([...declaredExclusions, ...residentExclusions])],
    resident,
    allowResidentShell,
  };
}

// The role ceiling's names, resolved through the same audit as bob.yaml's. A
// role is a bob-shipped file, so a bad name in it is a bob fault: the error
// says which role instead of pointing a line number into the agent's bob.yaml.
function roleToolNames(ceiling: RoleToolCeiling): string[] {
  const { resolved, problems } = auditToolNames(ceiling.allow);
  if (problems.length > 0) {
    throw new Error(
      `role "${ceiling.name}" allows tool ${problems.length === 1 ? "name" : "names"} pi cannot enable: ` +
        `${problems.map((p) => `${p.name} (${p.hint})`).join("; ")}. ` +
        `Known names: ${knownToolNames().join(", ")}.`,
    );
  }
  return resolved;
}

// The tools a resident agent's own allowlist asked for that the resident policy
// drops — doctor's warning, so the drop is never silent either.
export function residentDroppedTools(policy: ToolPolicy): string[] {
  if (!policy.resident || policy.allowResidentShell) return [];
  const allowed = new Set(policy.tools);
  return policy.excludeTools.filter((tool) => allowed.has(tool));
}
