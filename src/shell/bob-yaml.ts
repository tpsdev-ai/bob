// Targeted bob.yaml readers — the monorepo deliberately avoids a YAML dep (see
// the note in init.ts renderBobYaml and run.ts resolveProviderAndModel). These
// readers extend that same hand-rolled, format-specific approach to the shapes
// the capability loader needs: the top-level `capabilities:` string list and a
// per-capability scalar config block.
//
// This is NOT a general YAML parser. It targets the 2-space-indented output
// `bob init` emits plus the shapes capability config schemas actually need.
// Anything fancier (anchors, aliases, multi-line scalars, flow mappings, maps
// nested more than one level under a list item) is out of scope on purpose — if
// config grows past that we swap in a real YAML emitter+parser repo-wide
// (already flagged in init.ts).
//
// Out-of-scope shapes THROW `BobYamlError` rather than parse to something
// plausible-but-wrong. That distinction is the whole lesson of #77: `readBlock`
// silently rendered a list of mappings as a list of strings, so a capability
// that could never be configured shipped anyway.

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
