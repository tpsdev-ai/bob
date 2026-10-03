import { isAlias, isMap, isSeq, type Node, parseDocument } from "yaml";
import { DEFAULT_PROVIDER_REGISTRY, type ProviderRegistry } from "./provider-registry.js";
import { MAX_TIMER_MS, type RunLimitsBlock } from "./run-bounds.js";
import {
  ModelBudgetError,
  parseSessionBudget,
  positiveTokens,
  type SessionBudget,
} from "./session-budget.js";

// Read the top-level `capabilities:` block as a string list. Supports the
// block-sequence form bob writes:
//
//   capabilities:
//     - discord
//     - flair
//
// and the inline-flow form `capabilities: [discord, flair]`. Returns [] when
// the field is absent or empty. Names are trimmed; quotes stripped.
export function readCapabilities(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Drop the post-colon `\s*` (the capture trims anyway) to avoid a
    // polynomial regex (CodeQL js/polynomial-redos) — `\s*` overlapping `(.*)`.
    const m = line.match(/^capabilities\s*:(.*)$/);
    if (!m) continue;

    const inline = m[1].trim();
    // Inline-flow form: capabilities: [a, b, c] (also handles `[]`).
    if (inline.startsWith("[")) {
      const inner = inline.replace(/^\[/, "").replace(/\]\s*$/, "");
      return splitList(inner);
    }
    // Inline scalar after the colon is unusual for a list; ignore it and read
    // the following block-sequence items.

    // Block-sequence form: subsequent `  - item` lines until the next
    // column-0 key (or EOF).
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "" || l.trim().startsWith("#")) continue;
      // A new column-0, non-comment key ends the block.
      if (/^[A-Za-z0-9_-]+\s*:/.test(l)) break;
      // Trim first, then a literal "-" prefix check — avoids the polynomial
      // regex `^\s+-\s*(.+?)\s*$` (CodeQL js/polynomial-redos) on adversarial
      // whitespace. (Column-0 keys are already handled by the break above.)
      const t = l.trim();
      if (t.startsWith("-")) {
        items.push(stripQuotes(t.slice(1).trim()));
      } else {
        // Non-list, deeper-indented content under capabilities: stop — the
        // block sequence has ended.
        break;
      }
    }
    return items;
  }
  return [];
}

// --- `tools:` block ---------------------------------------------------------
//
// The role's tool allowlist, exactly as `bob init` stamps it out of role.json:
//
//   tools:
//     allow:
//       - read
//       - bash
//     exclude:
//       - bash
//     allowResidentShell: false
//     allowResidentWeb: false
//
// `readBlock` already handles the shape (a flat mapping of scalar / inline-list
// / block-sequence-list values); this wrapper is the SCHEMA on top of it. A key
// it does not recognize is an error, not an ignored setting — the allowlist
// spent its whole life inert because nothing validated it, and a typo like
// `alow:` must not read as "allow everything".
//
// Names are NOT resolved here (this module stays free of any pi/capability
// knowledge): tool-allowlist.ts resolves them against the tools that can
// actually exist. This reader only guarantees the block's shape.
export interface ToolsBlock {
  // Tool names to enable — the strict allowlist handed to pi. Absent is a load
  // error (tool-allowlist.ts resolveToolPolicy); an explicit empty list means
  // no tools.
  allow?: string[];
  // Tool names to disable after the allowlist.
  exclude?: string[];
  // Opt a resident agent back into the shell + file-writing tools the resident
  // policy drops (see tool-allowlist.ts, RESIDENT_EXCLUDED_TOOLS).
  allowResidentShell?: boolean;
  // bob#244: lift the resident egress exclusion for the web tools
  // (tool-allowlist.ts, RESIDENT_EGRESS_TOOLS); an explicit `exclude` entry
  // still wins. Like allowResidentShell, bob.yaml may only narrow the role's
  // grant.
  allowResidentWeb?: boolean;
}

const TOOLS_KEYS = ["allow", "exclude", "allowResidentShell", "allowResidentWeb"] as const;

export function readTools(yamlText: string): ToolsBlock | undefined {
  // The INLINE form (`tools: {allow: [read]}`) is refused, not ignored.
  // `readBlock` drops a block key's inline value silently, which on this key
  // means the block reads as empty — and "empty" is one step away from pi's
  // defaults, the state this whole reader exists to make impossible. One shape
  // for the block: `tools:` followed by allow:/exclude:/allowResidentShell: on
  // indented lines.
  const inline = /^tools[ \t]*:(.*)$/m.exec(yamlText);
  const inlineValue = inline?.[1].trim() ?? "";
  if (inlineValue !== "" && !inlineValue.startsWith("#")) {
    throw new BobYamlError(
      "tools",
      lineOf(yamlText, /^tools[ \t]*:/m),
      `the inline form is not supported — write the block form: "tools:" on its own line, then allow:/exclude: indented under it.`,
    );
  }

  const raw = readBlock(yamlText, "tools");
  if (raw === undefined) return undefined;

  const out: ToolsBlock = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(TOOLS_KEYS as readonly string[]).includes(key)) {
      throw new BobYamlError(
        "tools",
        lineOfKey(yamlText, "tools", key),
        `unknown key "${key}" — supported keys are ${TOOLS_KEYS.join(", ")}.`,
      );
    }
    if (key === "allowResidentShell" || key === "allowResidentWeb") {
      if (typeof value !== "boolean") {
        throw new BobYamlError(
          "tools",
          lineOfKey(yamlText, "tools", key),
          `"${key}" must be true or false.`,
        );
      }
      out[key] = value;
      continue;
    }
    const names = toToolNames(value);
    if (names === undefined) {
      throw new BobYamlError(
        "tools",
        lineOfKey(yamlText, "tools", key),
        `"${key}" must be a list of tool names, or one name.`,
      );
    }
    // Narrowed for the assignment below: the key is one of the two name lists
    // (the two boolean grants were handled above).
    if (key === "allow" || key === "exclude") out[key] = names;
  }
  return out;
}

// Normalize a parsed value into a list of tool names. A single scalar is one
// name (`allow: read`); an explicit empty list stays empty (`allow:` with no
// items means "no tools", the same strict reading pi gives an empty `tools`).
// Anything else — a number, a mapping, a list with a non-string item — is
// undefined, which the caller turns into a schema error.
function toToolNames(value: unknown): string[] | undefined {
  const list = Array.isArray(value) ? value : [value];
  const names: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || item.trim() === "") return undefined;
    names.push(item.trim());
  }
  return names;
}

// --- `provider:` limits and the `session:` block (bob#214) -----------------
//
// The provider block names the model AND its limits:
//
//   provider:
//     name: ollama
//     model: some-model
//     context_window: 262144      # REQUIRED to run: the server's context length
//     max_output_tokens: 32000    # optional: the per-request output cap
//     models:                     # optional: other models `--model` may name
//       - id: other-model
//         context_window: 131072
//         max_output_tokens: 16384
//
// A window is required by the session factory, not here: this reader validates
// the SHAPE of what is present, and a model with no declared window reaches the
// factory as "undeclared", which refuses with the remedy. A key it does not
// recognize is an error, not an ignored setting — a misspelled limit must not
// read as "no limit".
const PROVIDER_KEYS = [
  "name",
  "model",
  "context_window",
  "max_output_tokens",
  "base_url",
  "models",
] as const;
const PROVIDER_MODEL_KEYS = ["id", "context_window", "max_output_tokens"] as const;

export interface DeclaredModelLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ProviderLimitsBlock extends DeclaredModelLimits {
  // Other models this agent may run on (a per-call `--model`), by model id.
  models: Record<string, DeclaredModelLimits>;
  baseUrl?: string;
}

// Endpoint eligibility is DERIVED FROM THE REGISTRY: a `provider.base_url`
// override is allowed only when the row declares an explicit override policy
// (a keyless profile), and not to a host that profile excludes. Disk contents
// never select a profile. An undeclared provider name has no policy, so it
// refuses — the same answer the old hardcoded set gave for every other name.
export function providerBaseUrlRefusal(
  provider: string,
  baseUrl: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): string | undefined {
  if (
    Array.from(baseUrl).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  ) {
    return "provider.base_url must not contain C0, DEL, or C1 control characters.";
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "provider.base_url must be an absolute http/https URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "provider.base_url must be http or https.";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "provider.base_url must not carry credentials (a username or password in the URL).";
  }
  if (parsed.href.includes("?") || parsed.href.includes("#")) {
    return "provider.base_url must not contain a query string or fragment.";
  }
  const policy = registry.find(provider)?.override;
  if (policy !== undefined) {
    const host = parsed.hostname.replace(/\.+$/, "");
    if (!(policy.excludeHosts ?? []).includes(host)) return undefined;
    return "provider.base_url host is excluded by the provider row’s override.excludeHosts policy.";
  }
  return "provider.base_url is only allowed for a keyless provider row that authorizes an override.";
}

// bob#186 slice 2 (T7) — the provider readers run on a REAL YAML parser.
//
// `bob.yaml` is hand-emitted by init today, but the provider block's readers must
// not depend on a bespoke regex grammar once the document may carry nested
// metadata. This helper parses the WHOLE document once and returns one
// top-level block. Duplicate mapping keys, unresolved tags, aliases/anchors and
// merge keys REFUSE: the document is ambiguous and a reader cannot resolve it.
export function parseBobYamlBlock(yamlText: string, blockKey: string): unknown {
  let doc: import("yaml").Document;
  try {
    doc = parseDocument(yamlText, { uniqueKeys: true, schema: "core", merge: false });
  } catch {
    throw new BobYamlError(blockKey, 1, "could not parse bob.yaml.");
  }
  if (doc.errors.length > 0) {
    throw new BobYamlError(blockKey, 1, "could not parse bob.yaml.");
  }
  if (doc.warnings.length > 0) {
    throw new BobYamlError(blockKey, 1, "unsupported YAML tag in bob.yaml.");
  }
  refuseAmbiguousYaml(doc.contents, blockKey);
  const value = doc.toJS({ maxAliasCount: 0 });
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BobYamlError(blockKey, 1, "bob.yaml must be a mapping of top-level block keys.");
  }
  return (value as Record<string, unknown>)[blockKey];
}

// Refuse aliases, anchors and merge keys in bob.yaml, mirroring the registry
// loader: they make the document ambiguous, and the provider block is a flat,
// explicit declaration.
function refuseAmbiguousYaml(node: Node | null, blockKey: string): void {
  if (node === null || node === undefined) return;
  if (isAlias(node) || (node as { anchor?: unknown }).anchor !== undefined) {
    throw new BobYamlError(blockKey, 1, "bob.yaml uses a YAML alias/anchor, which is not allowed.");
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = pair.key as Node | null;
      if (key !== null && (key as { value?: unknown }).value === "<<") {
        throw new BobYamlError(
          blockKey,
          1,
          "bob.yaml uses a YAML merge key, which is not allowed.",
        );
      }
      if (pair.key) refuseAmbiguousYaml(pair.key as Node, blockKey);
      if (pair.value) refuseAmbiguousYaml(pair.value as Node, blockKey);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) refuseAmbiguousYaml(item as Node, blockKey);
  }
}

function tokensFor(yamlText: string, key: string, value: unknown): number {
  const tokens = positiveTokens(value);
  if (tokens === undefined) {
    throw new BobYamlError(
      "provider",
      lineOfKey(yamlText, "provider", key),
      `"${key}" must be a positive whole number of tokens (for example 262144).`,
    );
  }
  return tokens;
}

export function readProviderLimits(
  yamlText: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): ProviderLimitsBlock {
  const raw = parseBobYamlBlock(yamlText, "provider") as Record<string, unknown> | undefined;
  const out: ProviderLimitsBlock = { models: {} };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BobYamlError(
      "provider",
      lineOf(yamlText, /^provider[ \t]*:/m),
      `the "provider:" block must be a mapping of name/model/context_window keys.`,
    );
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(PROVIDER_KEYS as readonly string[]).includes(key)) {
      throw new BobYamlError(
        "provider",
        lineOfKey(yamlText, "provider", key),
        `unknown key "${key}" — supported keys are ${PROVIDER_KEYS.join(", ")}.`,
      );
    }
    if (key === "context_window") out.contextWindow = tokensFor(yamlText, key, value);
    else if (key === "max_output_tokens") out.maxOutputTokens = tokensFor(yamlText, key, value);
    else if (key === "base_url") {
      if (typeof value !== "string" || value.trim() === "") {
        throw new BobYamlError(
          "provider",
          lineOfKey(yamlText, "provider", key),
          `"base_url" must be an http/https URL string.`,
        );
      }
      const name = typeof raw.name === "string" ? raw.name : "";
      const refusal = providerBaseUrlRefusal(name, value, registry);
      if (refusal !== undefined) {
        throw new BobYamlError("provider", lineOfKey(yamlText, "provider", key), refusal);
      }
      out.baseUrl = new URL(value).href;
    } else if (key === "models") {
      const line = lineOfKey(yamlText, "provider", key);
      if (!Array.isArray(value)) {
        throw new BobYamlError(
          "provider",
          line,
          `"models" must be a list of "- id: <model>" entries.`,
        );
      }
      for (const item of value) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new BobYamlError(
            "provider",
            line,
            `each "models" entry must be "- id: <model>" with context_window under it.`,
          );
        }
        const entry = item as Record<string, unknown>;
        for (const k of Object.keys(entry)) {
          if (!(PROVIDER_MODEL_KEYS as readonly string[]).includes(k)) {
            throw new BobYamlError(
              "provider",
              line,
              `unknown key "${k}" in a "models" entry — supported keys are ${PROVIDER_MODEL_KEYS.join(", ")}.`,
            );
          }
        }
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        if (id === "") {
          throw new BobYamlError(
            "provider",
            line,
            `a "models" entry needs an "id" (the model id).`,
          );
        }
        if (Object.hasOwn(out.models, id)) {
          throw new BobYamlError("provider", line, `"models" names the same id twice.`);
        }
        out.models[id] = {
          ...(entry.context_window !== undefined
            ? { contextWindow: tokensFor(yamlText, "models", entry.context_window) }
            : {}),
          ...(entry.max_output_tokens !== undefined
            ? { maxOutputTokens: tokensFor(yamlText, "models", entry.max_output_tokens) }
            : {}),
        };
      }
    }
  }
  return out;
}

// The agent's own session budget, overriding its role's (role.json `session`):
//
//   session:
//     compaction_threshold: 0.5   # compact between model calls past this fraction
//     thinking: low               # off | low | high
//
// Absent keys fall back to the role. Unknown keys and malformed values throw.
export function readSessionBudget(yamlText: string): SessionBudget {
  const inline = /^session[ \t]*:(.*)$/m.exec(yamlText);
  const inlineValue = inline?.[1].trim() ?? "";
  if (inlineValue !== "" && !inlineValue.startsWith("#")) {
    throw new BobYamlError(
      "session",
      lineOf(yamlText, /^session[ \t]*:/m),
      `the inline form is not supported — write "session:" on its own line, then compaction_threshold:/thinking: indented under it.`,
    );
  }
  const raw = readBlock(yamlText, "session");
  if (raw === undefined) return {};
  try {
    return parseSessionBudget(raw, 'bob.yaml "session:" block');
  } catch (err) {
    if (!(err instanceof ModelBudgetError)) throw err;
    const key = Object.keys(raw).find((k) => err.message.includes(`"${k}"`));
    throw new BobYamlError(
      "session",
      key !== undefined
        ? lineOfKey(yamlText, "session", key)
        : lineOf(yamlText, /^session[ \t]*:/m),
      err.message.replace(/^bob\.yaml "session:" block: /, ""),
    );
  }
}

// The one-shot run bounds and loop breaker, per agent (bob.yaml `run:`):
//
//   run:
//     wall_clock_seconds: 1800
//     no_progress_seconds: 600
//     turn_timeout_seconds: 300
//     tool_loop_limit: 4
//
// Absent keys fall back to their callers' defaults. An unknown key, a
// non-integer, or a value outside the accepted range throws, so a misspelled or
// absurd bound is not read as "no bound". A second `run:` line or a repeated
// key under `run:` throws too: the shared block reader keeps the last value of
// a repeated key, which would hide an invalid earlier one from these checks.
//
// A seconds key is capped so its milliseconds fit the runtime timer range
// (setTimeout clamps a larger delay to 1 ms).
const MAX_SECONDS = Math.floor(MAX_TIMER_MS / 1000);
const RUN_KEYS = [
  "wall_clock_seconds",
  "no_progress_seconds",
  "turn_timeout_seconds",
  "tool_loop_limit",
  "exploration_budget",
] as const;

function wholeSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  if (value < 1 || value > MAX_SECONDS) return undefined;
  return value;
}

// Refuse a second top-level `run:` line (block or inline form) and a direct
// sub-key of `run:` set twice, naming the key and both lines. Scans with the
// same column-0 key rule as readBlock; a direct sub-key is a `name:` line at the
// indent of the block's first content line.
function refuseDuplicateRunKeys(yamlText: string): void {
  const lines = yamlText.split(/\r?\n/);
  let runLine: number | undefined;
  let inRun = false;
  let baseIndent: number | undefined;
  const seen = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
      inRun = /^run\s*:/.test(line);
      if (inRun) {
        if (runLine !== undefined) {
          throw new BobYamlError(
            "run",
            i + 1,
            `a second "run:" (the first is on line ${runLine}) — write one "run:" block.`,
          );
        }
        runLine = i + 1;
      }
      continue;
    }
    if (!inRun) continue;
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const indent = line.length - line.replace(/^ +/, "").length;
    if (baseIndent === undefined) baseIndent = indent;
    if (indent !== baseIndent) continue;
    const m = t.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (!m) continue;
    const first = seen.get(m[1]);
    if (first !== undefined) {
      throw new BobYamlError(
        "run",
        i + 1,
        `"${m[1]}" is set again (first on line ${first}) — set it once.`,
      );
    }
    seen.set(m[1], i + 1);
  }
}

function readRunSettings(yamlText: string): {
  limits: RunLimitsBlock;
  toolLoopLimit?: number;
  explorationBudget?: number;
} {
  refuseDuplicateRunKeys(yamlText);
  const inline = /^run[ \t]*:(.*)$/m.exec(yamlText);
  const inlineValue = inline?.[1].trim() ?? "";
  if (inlineValue !== "" && !inlineValue.startsWith("#")) {
    throw new BobYamlError(
      "run",
      lineOf(yamlText, /^run[ \t]*:/m),
      `the inline form is not supported — write "run:" on its own line, then ${RUN_KEYS.join("/")}: indented under it.`,
    );
  }
  const raw = readBlock(yamlText, "run");
  if (raw === undefined) return { limits: {} };
  const out: RunLimitsBlock = {};
  let toolLoopLimit: number | undefined;
  let explorationBudget: number | undefined;
  for (const [key, value] of Object.entries(raw)) {
    if (!(RUN_KEYS as readonly string[]).includes(key)) {
      throw new BobYamlError(
        "run",
        lineOfKey(yamlText, "run", key),
        `unknown key "${key}" — supported keys are ${RUN_KEYS.join(", ")}.`,
      );
    }
    if (key === "tool_loop_limit") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new BobYamlError(
          "run",
          lineOfKey(yamlText, "run", key),
          `"tool_loop_limit" must be a positive whole number.`,
        );
      }
      toolLoopLimit = value;
      continue;
    }
    if (key === "exploration_budget") {
      // bob#279: a positive whole number of read-only calls.
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new BobYamlError(
          "run",
          lineOfKey(yamlText, "run", key),
          `"exploration_budget" must be a positive whole number.`,
        );
      }
      explorationBudget = value;
      continue;
    }
    const n = wholeSeconds(value);
    if (n === undefined) {
      throw new BobYamlError(
        "run",
        lineOfKey(yamlText, "run", key),
        `"${key}" must be a whole number of seconds between 1 and ${MAX_SECONDS}.`,
      );
    }
    if (key === "wall_clock_seconds") out.wallClockSeconds = n;
    else if (key === "no_progress_seconds") out.noProgressSeconds = n;
    else out.turnTimeoutSeconds = n;
  }
  return {
    limits: out,
    ...(toolLoopLimit !== undefined ? { toolLoopLimit } : {}),
    ...(explorationBudget !== undefined ? { explorationBudget } : {}),
  };
}

export function readToolLoopLimit(yamlText: string): number | undefined {
  return readRunSettings(yamlText).toolLoopLimit;
}

// bob#279: the agent's `run.exploration_budget`, or undefined when it sets none.
export function readExplorationBudget(yamlText: string): number | undefined {
  return readRunSettings(yamlText).explorationBudget;
}

export function readRunLimits(yamlText: string): RunLimitsBlock {
  return readRunSettings(yamlText).limits;
}

// The role this agent was hired into (bob.yaml `agent.role`). The role is the
// CEILING on the tool allowlist (tool-allowlist.ts): roles/<role>/role.json
// ships with bob, while bob.yaml is agent-writable, so bob.yaml may narrow the
// role's list but never widen it. An absent or non-scalar role is an error — a
// session cannot apply a ceiling it cannot read.
export function readAgentRole(yamlText: string): string {
  const block = readBlock(yamlText, "agent");
  const raw = block?.role;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new BobYamlError(
      "agent",
      lineOfKey(yamlText, "agent", "role"),
      raw === undefined
        ? `bob.yaml must declare the agent's role (agent.role) — the role's role.json is the ceiling on the tool allowlist.`
        : `"role" must be a role name (ea, jarvis, writer, reviewer, coder, qa, builder-local, custom).`,
    );
  }
  return raw.trim();
}

// Read the top-level `resident:` flag. True means the agent runs unattended
// behind its service unit, which is what the resident tool policy keys off
// (tool-allowlist.ts). Absent = false. A non-boolean value is an error rather
// than a silent "not resident" — the flag decides whether an agent holds a
// shell, so guessing it is the wrong failure mode.
export function readResident(yamlText: string): boolean {
  const m = yamlText.match(/^resident[ \t]*:(.*)$/m);
  if (!m) return false;
  const value = m[1].trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BobYamlError(
    "resident",
    lineOf(yamlText, /^resident[ \t]*:/m),
    "`resident` must be true or false.",
  );
}

// 1-based line of the first match of `pattern`, or 1. Used to point a config
// error at the line a human edits.
export function lineOf(yamlText: string, pattern: RegExp): number {
  const lines = yamlText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return 1;
}

// 1-based line of a sub-key inside a top-level block, falling back to the
// block's own line.
function lineOfKey(yamlText: string, blockKey: string, subKey: string): number {
  const lines = yamlText.split(/\r?\n/);
  let inBlock = false;
  let blockLine = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
      inBlock = new RegExp(`^${blockKey}\\s*:`).test(line);
      if (inBlock) blockLine = i + 1;
      continue;
    }
    if (!inBlock) continue;
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (m && m[1] === subKey) return i + 1;
  }
  return blockLine;
}

// A shape `readBlock` deliberately does not support. Thrown rather than guessed
// at: the whole reason issue #77 shipped is that an unsupported shape produced a
// plausible-looking wrong value (a list of maps became a list of strings, and
// the maps' second keys were hoisted into the enclosing block) instead of an
// error, so it passed every eye between authoring and publish.
//
// The message carries the block key, the 1-based line number, and — when known
// — the offending KEY name. It never echoes a VALUE: a bob.yaml value can be a
// secret, and an error string ends up in logs.
export class BobYamlError extends Error {
  readonly key: string;
  readonly line: number;
  constructor(key: string, line: number, detail: string) {
    super(`bob.yaml "${key}:" block, line ${line}: ${detail}`);
    this.name = "BobYamlError";
    this.key = key;
    this.line = line;
  }
}

const SUPPORTED_SHAPES =
  'Supported under a block: "name: value", "name: [a, b]", a list of scalars, ' +
  'and a list of single-level "- name: value" mappings.';

// Read a top-level `<key>:` block into an object. Used for a capability's
// per-capability config block (the block keyed by the capability name, e.g. the
// top-level `discord:` block). Returns undefined when the block is absent.
//
// Supported value shapes for a sub-key:
//   - Flat scalar: `name: value` — coerced (`true`/`false` → boolean,
//     integer-looking → number, else string with quotes stripped).
//   - Inline-flow list: `name: [a, b, c]` — array of coerced scalars.
//   - Block-sequence list of scalars: `name:` followed by deeper-indented
//     `- item` lines. (Needed by the discord capability's channelIds.)
//   - Block-sequence list of ONE-LEVEL mappings: `name:` followed by
//     `- subKey: value` lines, each optionally continued by further
//     `subKey: value` lines indented deeper than its `-`. Every value in a
//     mapping item is a scalar or an inline-flow list. (Needed by the
//     observatory capability's `agents`.)
//
// Everything else THROWS BobYamlError — notably: nested mappings (at block
// level or inside a list item), nested lists, flow mappings (`{a: b}`), an
// empty `-`, a list whose items mix scalars and mappings, ragged indentation,
// and any line that isn't recognizable as one of the above. Growing past this
// grammar means swapping in a real YAML parser, not widening this one.
export function readBlock(yamlText: string, key: string): Record<string, unknown> | undefined {
  const lines = yamlText.split(/\r?\n/);
  let inBlock = false;
  let found = false;
  const out: Record<string, unknown> = {};
  // Indent of the block's direct sub-keys, set by its first content line. Every
  // direct sub-key must sit at exactly this column; anything deeper has to
  // belong to an open list, or it's an unsupported nested mapping.
  let baseIndent: number | undefined;
  // The block-sequence list opened by the most recent value-less sub-key, if
  // it's still open. Closed by a sub-key at baseIndent, a column-0 key, or EOF.
  let list: OpenList | undefined;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;

    if (/^[A-Za-z0-9_-]+\s*:/.test(rawLine)) {
      // A column-0 key. Are we entering, or leaving, our block?
      const km = rawLine.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
      const isOurs = km?.[1] === key;
      inBlock = isOurs === true;
      baseIndent = undefined;
      list = undefined;
      if (isOurs) {
        found = true;
        // An inline value on the block key (e.g. `discord: foo`) is ignored;
        // the block form is `discord:` followed by indented sub-keys.
      }
      continue;
    }
    if (!inBlock) continue;

    const t = rawLine.trim();
    if (t === "" || t.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.replace(/^ +/, "").length;
    if (baseIndent === undefined) {
      if (t.startsWith("-")) {
        throw new BobYamlError(
          key,
          lineNo,
          `the block is a list, but a capability config block must be a mapping. ${SUPPORTED_SHAPES}`,
        );
      }
      baseIndent = indent;
    }

    // --- A `- item` line: an entry in the open block-sequence list. ---
    // (Trim-first + literal "-" check — no `^\s+-\s*(.+?)\s*$` polynomial
    // regex on adversarial whitespace; CodeQL js/polynomial-redos.)
    if (t.startsWith("-")) {
      if (!list) {
        throw new BobYamlError(
          key,
          lineNo,
          `a list item appeared where no "name:" opened a list. ${SUPPORTED_SHAPES}`,
        );
      }
      if (list.dashIndent === undefined) {
        if (indent <= list.keyIndent) {
          throw new BobYamlError(
            key,
            lineNo,
            `list items under "${list.subKey}:" must be indented deeper than it.`,
          );
        }
        list.dashIndent = indent;
      } else if (indent !== list.dashIndent) {
        throw new BobYamlError(
          key,
          lineNo,
          `this "-" under "${list.subKey}:" is indented differently from the first item; every item in a list must share one indent.`,
        );
      }

      const after = t.slice(1).trim();
      if (after === "") {
        throw new BobYamlError(
          key,
          lineNo,
          `an empty "-" (a nested list, or an item whose keys start on the next line) is not supported under "${list.subKey}:". ${SUPPORTED_SHAPES}`,
        );
      }
      if (after.startsWith("-")) {
        throw new BobYamlError(
          key,
          lineNo,
          `nested lists are not supported under "${list.subKey}:". ${SUPPORTED_SHAPES}`,
        );
      }
      if (after.startsWith("{")) {
        throw new BobYamlError(
          key,
          lineNo,
          `flow mappings ({...}) are not supported under "${list.subKey}:". ${SUPPORTED_SHAPES}`,
        );
      }

      const kv = matchKey(after);
      if (kv) {
        if (list.kind === "scalar") {
          throw new BobYamlError(
            key,
            lineNo,
            `the list under "${list.subKey}:" mixes scalar items with "name: value" items; a list must be all one or all the other.`,
          );
        }
        list.kind = "mapping";
        const item: Record<string, unknown> = {};
        list.items.push(item);
        list.current = item;
        setMappingValue(key, lineNo, list.subKey, item, kv.name, kv.rest);
      } else {
        if (list.kind === "mapping") {
          throw new BobYamlError(
            key,
            lineNo,
            `the list under "${list.subKey}:" mixes scalar items with "name: value" items; a list must be all one or all the other.`,
          );
        }
        list.kind = "scalar";
        list.current = undefined;
        list.items.push(coerceScalar(after));
      }
      continue;
    }

    // --- A continuation line of the open mapping item. ---
    if (list?.current && list.dashIndent !== undefined && indent > list.dashIndent) {
      const kv = matchKey(t);
      if (!kv) {
        throw new BobYamlError(
          key,
          lineNo,
          `expected "name: value" inside the list item under "${list.subKey}:". ${SUPPORTED_SHAPES}`,
        );
      }
      setMappingValue(key, lineNo, list.subKey, list.current, kv.name, kv.rest);
      continue;
    }

    // --- Otherwise it must be a direct sub-key of the block. ---
    if (indent !== baseIndent) {
      throw new BobYamlError(
        key,
        lineNo,
        indent > baseIndent
          ? `nested mappings are not supported. ${SUPPORTED_SHAPES}`
          : `this line is outdented past the block's other keys. ${SUPPORTED_SHAPES}`,
      );
    }
    list = undefined;

    // A `name: value` sub-key. (No leading/trailing `\s*` in the pattern —
    // coerceScalar trims; avoids CodeQL js/polynomial-redos.)
    const m = t.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (!m) {
      throw new BobYamlError(key, lineNo, `expected "name: value". ${SUPPORTED_SHAPES}`);
    }
    const subKey = m[1];
    refuseReservedKey(key, lineNo, subKey);
    const rest = m[2].trim();
    if (rest.startsWith("[")) {
      // Inline-flow list.
      out[subKey] = splitList(stripBrackets(rest)).map(coerceScalar);
    } else if (rest.startsWith("{")) {
      throw new BobYamlError(
        key,
        lineNo,
        `flow mappings ({...}) are not supported for "${subKey}:". ${SUPPORTED_SHAPES}`,
      );
    } else if (rest === "") {
      // Empty value — the head of a block-sequence list. Open it; if no `- item`
      // lines follow, it stays an empty array.
      const items: unknown[] = [];
      out[subKey] = items;
      list = { items, keyIndent: indent, subKey };
    } else {
      out[subKey] = coerceScalar(rest);
    }
  }
  return found ? out : undefined;
}

// A block-sequence list that is still accepting `- item` lines.
interface OpenList {
  items: unknown[];
  // Indent of the sub-key that opened the list — items must be deeper.
  keyIndent: number;
  subKey: string;
  // Indent of the first `-`; every later item must match it exactly.
  dashIndent?: number;
  // Set by the first item; a list may not mix the two.
  kind?: "scalar" | "mapping";
  // The mapping item currently accepting deeper-indented `name: value` lines.
  current?: Record<string, unknown>;
}

// `__proto__` cannot be stored as a key of the plain objects readBlock builds:
// the assignment would set the prototype or be ignored, so the key would vanish
// before a reader's unknown-key check sees it. Refuse it instead.
function refuseReservedKey(key: string, lineNo: number, name: string): void {
  if (name === "__proto__") {
    throw new BobYamlError(key, lineNo, `"__proto__" is a reserved key and is not supported.`);
  }
}

// Match `name: value` STRICTLY: the colon must be followed by whitespace or end
// of line. That's YAML's own rule, and it's load-bearing here — the loose form
// would read `- http://example` as the key `http` with value `//example`,
// silently turning a list of URLs into a list of objects.
function matchKey(s: string): { name: string; rest: string } | undefined {
  const m = s.match(/^([A-Za-z0-9_-]+)[ \t]*:([ \t].*)?$/);
  if (!m) return undefined;
  return { name: m[1], rest: (m[2] ?? "").trim() };
}

// Assign one `name: value` inside a mapping list item. Values are scalars or
// inline-flow lists — same grammar as a block's direct sub-keys, minus opening
// a nested block sequence.
function setMappingValue(
  key: string,
  lineNo: number,
  subKey: string,
  obj: Record<string, unknown>,
  name: string,
  rest: string,
): void {
  refuseReservedKey(key, lineNo, name);
  if (rest === "") {
    throw new BobYamlError(
      key,
      lineNo,
      `"${name}:" inside the list item under "${subKey}:" has no value; nested mappings and nested lists inside a list item are not supported. ${SUPPORTED_SHAPES}`,
    );
  }
  if (rest.startsWith("{")) {
    throw new BobYamlError(
      key,
      lineNo,
      `flow mappings ({...}) are not supported for "${name}:". ${SUPPORTED_SHAPES}`,
    );
  }
  if (rest.startsWith("[")) {
    obj[name] = splitList(stripBrackets(rest)).map(coerceScalar);
    return;
  }
  obj[name] = coerceScalar(rest);
}

function stripBrackets(rest: string): string {
  return rest.replace(/^\[/, "").replace(/\]$/, "");
}

// Read the top-level `cron:` block-sequence of maps into raw entries. Targets
// the exact shape `bob init` documents:
//
//   cron:
//     - name: morning_briefing
//       schedule: "0 9 * * *"
//       prompt: "Compose the brief."
//
// Each `- key: value` starts an entry; subsequent `key: value` lines indented
// deeper than the `-` add to it. A column-0 key (or EOF) ends the block. Values
// are coerced as scalars (quotes stripped). Returns [] when absent. The caller
// validates required keys (name/schedule/prompt) + maps to CronEntry — keeping
// this reader dependency-free + free of a layering cycle with index.ts.
export function readCron(yamlText: string): Array<Record<string, string>> {
  const lines = yamlText.split(/\r?\n/);
  const entries: Array<Record<string, string>> = [];
  let inBlock = false;
  let current: Record<string, string> | undefined;
  let dashIndent = -1;

  for (const rawLine of lines) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(rawLine)) {
      inBlock = rawLine.match(/^([A-Za-z0-9_-]+)\s*:/)?.[1] === "cron";
      current = undefined;
      continue;
    }
    if (!inBlock) continue;
    const t = rawLine.trim();
    if (t === "" || t.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.replace(/^ +/, "").length;

    if (t.startsWith("-")) {
      // New entry. The text after "-" may be the first `key: value`.
      current = {};
      entries.push(current);
      dashIndent = indent;
      const after = t.slice(1).trim();
      if (after) addCronKv(current, after);
    } else if (current && indent > dashIndent) {
      addCronKv(current, t);
    } else {
      // Unexpected shape under cron: — stop reading the block.
      break;
    }
  }
  return entries;
}

function addCronKv(obj: Record<string, string>, kv: string): void {
  // Same `name: value` shape as readBlock — coerceScalar trims + strips quotes;
  // cron values are all strings (name / cron-expr / prompt), so stringify.
  const m = kv.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
  if (!m) return;
  obj[m[1]] = String(coerceScalar(m[2].trim()));
}

function splitList(inner: string): string[] {
  if (inner.trim() === "") return [];
  return inner
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function coerceScalar(raw: string): unknown {
  const trimmed = raw.trim();
  // An explicitly-quoted scalar is a STRING — no bool/number coercion. This is
  // load-bearing for Discord channel snowflakes (`'111'` must stay "111", not
  // become 111, so it satisfies a string schema).
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2);
  const v = stripQuotes(trimmed);
  if (quoted) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}
