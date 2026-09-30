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
// must drop both names — and the work capability's `run` too (see below).
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

// What each tool an agent's allowlist can name does, reviewed by hand, one row
// per name (bob#213). The rows cover pi's built-ins and every tool a blessed
// capability's manifest declares in `provides.tools`, planned capabilities
// included, so no capability goes live with a tool nobody classified.
// test/shell/tool-allowlist.test.ts fails on such a name without a row, and on a
// row whose name nothing provides.
//
// The manifests are the authority, not the extensions' `registerTool` calls: a
// session's `tools` allowlist is required (resolveToolPolicy), it resolves only
// pi built-ins and names in a built capability's `provides.tools`
// (auditToolNames), and pi enables only the names that allowlist lists. A tool
// an extension registers without declaring it can never be active. The setup
// sessions' bob-owned `write_soul` has no row: no allowlist can name it, and
// the setup policy (SETUP_TOOL_POLICY in session.ts, read + write_soul) is fixed.
//
//   read-only  reads and reports; changes nothing.
//   writer     writes a file the model names, or runs a command the model
//              writes. A resident agent drops these unless its role opts in.
//   effect     changes something without writing a file the model names or
//              running a command: a memory write, a Discord post or reaction,
//              a status report, a robot action, or cancelling a job this run
//              started. A resident agent keeps these (the jarvis role holds
//              flair_write and discord_reply without the shell opt-in).
//   egress     this policy's category for the web tools (bob#244, web spec v3),
//              which send model-influenced data to a host outside the office.
//              Other effects can be outbound too (discord_reply posts a
//              message; the planned mail_send sends a mail): egress sets the
//              web tools apart so they get their own resident grant. A resident
//              agent drops these unless its role opts in with
//              `allowResidentWeb`; the shell opt-in (`allowResidentShell`) does
//              not cover them.
export type ToolEffect = "read-only" | "writer" | "effect" | "egress";

// The writer rows come first, in the order RESIDENT_EXCLUDED_TOOLS lists them.
export const TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = Object.freeze({
  bash: "writer", // pi: runs a command
  write: "writer", // pi: writes a file
  edit: "writer", // pi: edits a file
  powershell: "writer", // pi (Windows): runs a command
  run: "writer", // work: runs a command
  write_file: "writer", // anchored-edit: writes a file
  edit_lines: "writer", // anchored-edit: edits a file
  insert_after: "writer", // anchored-edit: edits a file
  flair_write: "effect", // flair: writes a memory
  discord_reply: "effect", // discord: posts a message
  discord_react: "effect", // discord: adds a reaction
  observatory_report: "effect", // observatory: posts the office's status
  reachy_look: "effect", // reachy: turns the robot's head
  reachy_say: "effect", // reachy: speaks a line
  reachy_frame: "effect", // reachy: asks the robot for a camera frame
  run_cancel: "effect", // work: stops a job this run started
  mail_send: "effect", // mail (planned): sends a mail
  // Both web tools carry model-influenced data out of the office: web_fetch to
  // the host of a URL the model chose (its host, path and query), web_search to
  // the search provider (the query the model writes). Neither is registered yet
  // (web registers no tool in slice R1a).
  web_fetch: "egress", // web: fetches a URL
  web_search: "egress", // web (planned for R2): sends a search query to the provider
  read: "read-only", // pi
  grep: "read-only", // pi
  find: "read-only", // pi
  ls: "read-only", // pi
  read_lines: "read-only", // anchored-edit
  run_status: "read-only", // work
  flair_search: "read-only", // flair
  flair_get: "read-only", // flair
  discord_fetch: "read-only", // discord
  reachy_state: "read-only", // reachy (placeholder)
  bob_fixture_noop: "read-only", // fixture: echoes its argument
});

// Every tool name an agent's allowlist could name: pi's built-ins, then every
// name a blessed capability's manifest provides (built or planned), in catalog
// order.
export function providedToolNames(): string[] {
  const names = new Set<string>(PI_BUILTIN_TOOLS);
  for (const entry of Object.values(BLESSED_CATALOG)) {
    for (const tool of entry.manifest.provides?.tools ?? []) names.add(tool);
  }
  return [...names];
}

// The provided names that have no row in `effects`.
export function unclassifiedToolNames(
  provided: readonly string[] = providedToolNames(),
  effects: Readonly<Record<string, ToolEffect>> = TOOL_EFFECTS,
): string[] {
  return provided.filter((name) => !Object.hasOwn(effects, name));
}

// The names a resident agent drops: every writer row, in row order, then every
// provided name with no row at all. Allowlist-shaped: a resident agent keeps a
// tool only when its row says read-only or effect, so a missing classification
// drops the tool; it never keeps it.
export function residentExclusions(
  provided: readonly string[] = providedToolNames(),
  effects: Readonly<Record<string, ToolEffect>> = TOOL_EFFECTS,
): string[] {
  const writers = Object.keys(effects).filter((name) => effects[name] === "writer");
  return [...new Set([...writers, ...unclassifiedToolNames(provided, effects)])];
}

// The egress rows: what a resident agent drops unless its role opts in with
// `allowResidentWeb` (bob#244). Separate from the shell opt-in on purpose:
// the shell grant does not grant `web_fetch` or `web_search`; shell commands
// may themselves make outbound requests.
export function residentEgressTools(
  effects: Readonly<Record<string, ToolEffect>> = TOOL_EFFECTS,
): string[] {
  return Object.keys(effects).filter((name) => effects[name] === "egress");
}

export const RESIDENT_EGRESS_TOOLS: readonly string[] = Object.freeze(residentEgressTools());

// What a resident agent must not hold unless its role opts in
// (`allowResidentShell`). A resident agent runs unattended behind its service
// unit, with no human at the keyboard to approve a command or a file write.
//
// Every writer is dropped (`run`, bob#211, with `bash` and `powershell`; the
// anchored-edit writers with pi's `write` and `edit`), and so is any provided
// name without a row. `run_status` and `run_cancel` run nothing and are kept.
export const RESIDENT_EXCLUDED_TOOLS: readonly string[] = Object.freeze(residentExclusions());

// What a MAIL TURN may hold (bob#200 §4, F4): an explicit, reviewed ALLOWLIST,
// never a denylist. A mail turn answers ONE allow-listed peer and whatever it
// can reach can end up in the reply, so every tool is dropped unless it is
// named here — whatever role or capability supplies it. A denylist had to name
// every file- or network-reaching tool in advance and missed the ones a role
// or capability added later (builder-local's read_lines/edit_lines/
// insert_after/write_file): an allowlist cannot fall behind.
//
// The three Flair memory tools, because memory with receipts is the point.
// `flair_write` stays deliberately (spec §4): allow-listing a sender therefore
// also permits MAIL-INFLUENCED MEMORY WRITES, and the operator docs say so.
// Adding a tool here is a security review, not a convenience. No egress tool is
// on it (bob#244): the web tools stay out of mail turns because the
// intersection below drops them, not because of a separate mechanism.
export const MAIL_TURN_ALLOWED_TOOLS: readonly string[] = [
  "flair_search",
  "flair_get",
  "flair_write",
];

// The policy a mail turn runs with: the role's resolved allowlist INTERSECTED
// with MAIL_TURN_ALLOWED_TOOLS (pi's `tools` is strict over built-ins AND
// capability tools, so anything outside it is never active). Only narrows.
export function applyMailTurnPolicy(policy: ToolPolicy): ToolPolicy {
  const allowed = new Set(MAIL_TURN_ALLOWED_TOOLS);
  return { ...policy, tools: policy.tools.filter((name) => allowed.has(name)) };
}

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

// The blessed capability that provides a tool name, when one does. A name with
// no capability behind it is a pi built-in (or unknown).
export function capabilityForTool(name: string): string | undefined {
  return builtCapabilityTools().get(name);
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
  // bob#244: true when the role itself lets a resident agent keep the egress
  // (web) tools (role.json `tools.allowResidentWeb`). Independent of
  // allowResidentShell.
  allowResidentWeb?: boolean;
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
  // bob#244: whether a resident agent keeps the egress (web) tools. Absent
  // means no: a policy built without it drops them.
  allowResidentWeb?: boolean;
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
  let allowResidentWeb = block.allowResidentWeb === true;
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
    if (allowResidentWeb && ceiling.allowResidentWeb !== true) {
      throw new BobYamlError(
        "tools",
        lineOf(opts.yamlText, /^tools[ \t]*:/m),
        `bob.yaml widens the tool allowlist beyond the "${ceiling.name}" role: tools.allowResidentWeb is true, but the role does not grant it. A resident agent loses the web tools unless its ROLE opts in (roles/${ceiling.name}/role.json).`,
      );
    }
    // The role's grant is inherited; bob.yaml may still narrow it away.
    allowResidentShell = ceiling.allowResidentShell === true && block.allowResidentShell !== false;
    allowResidentWeb = ceiling.allowResidentWeb === true && block.allowResidentWeb !== false;
  }

  // The shell opt-in keeps the writers; only the web opt-in keeps egress. The
  // egress exclusion lists only the egress names this allowlist asks for: pi
  // applies excludeTools after the strict allowlist, so an unlisted name is
  // inert either way, and every existing agent's effective tool and exclusion
  // lists (and a bound agent's ratified baseline) stay exactly as they were;
  // the returned policy gains only the allowResidentWeb flag.
  const residentExclusions = resident
    ? [
        ...(allowResidentShell ? [] : RESIDENT_EXCLUDED_TOOLS),
        ...(allowResidentWeb ? [] : RESIDENT_EGRESS_TOOLS.filter((name) => tools.includes(name))),
      ]
    : [];

  return {
    tools,
    // A declared exclusion wins over the allowlist (pi applies `excludeTools`
    // after `tools`), and the resident policy rides on top of both.
    excludeTools: [...new Set([...declaredExclusions, ...residentExclusions])],
    resident,
    allowResidentShell,
    allowResidentWeb,
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

// The tools a resident agent's own allowlist asked for that the effective
// exclusion list drops while the SHELL grant (allowResidentShell) is absent:
// its non-egress names — doctor's warning, so the drop is never silent either.
// That list includes explicit tools.exclude entries, which stay excluded after
// the shell grant is given. The egress names, whose grant is allowResidentWeb,
// are residentDroppedWebTools'.
export function residentDroppedTools(policy: ToolPolicy): string[] {
  if (!policy.resident || policy.allowResidentShell) return [];
  const allowed = new Set(policy.tools);
  const egress = new Set(RESIDENT_EGRESS_TOOLS);
  return policy.excludeTools.filter((tool) => allowed.has(tool) && !egress.has(tool));
}

// bob#244: the egress (web) tools a resident agent's allowlist asked for that
// the effective resident policy drops: allowResidentWeb is not in effect,
// because the role does not grant it or bob.yaml narrows it away.
export function residentDroppedWebTools(policy: ToolPolicy): string[] {
  if (!policy.resident || policy.allowResidentWeb === true) return [];
  const excluded = new Set(policy.excludeTools);
  return RESIDENT_EGRESS_TOOLS.filter((tool) => policy.tools.includes(tool) && excluded.has(tool));
}
