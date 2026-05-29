// Targeted bob.yaml readers — the monorepo deliberately avoids a YAML dep (see
// the note in init.ts renderBobYaml and run.ts resolveProviderAndModel). These
// readers extend that same hand-rolled, format-specific approach to the shapes
// the capability loader needs: the top-level `capabilities:` string list and a
// per-capability scalar config block.
//
// This is NOT a general YAML parser. It targets the flat, 2-space-indented
// output `bob init` emits. Anything fancier (anchors, nested maps, multi-line
// scalars) is out of scope on purpose — if config grows past flat scalars we
// swap in a real YAML emitter+parser monorepo-wide (already flagged in init.ts).

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

// Read a top-level `<key>:` block into an object. Used for a capability's
// per-capability config block (the block keyed by the capability name, e.g. the
// top-level `discord:` block). Returns undefined when the block is absent.
//
// Supported value shapes for a sub-key:
//   - Flat scalar: `name: value` — coerced (`true`/`false` → boolean,
//     integer-looking → number, else string with quotes stripped).
//   - Inline-flow list: `name: [a, b, c]` — array of coerced strings.
//   - Block-sequence list: `name:` followed by deeper-indented `- item` lines —
//     array of coerced strings. (Needed by the discord capability's channelIds.)
// Nested maps are still out of scope.
export function readBlock(yamlText: string, key: string): Record<string, unknown> | undefined {
  const lines = yamlText.split(/\r?\n/);
  let inBlock = false;
  let found = false;
  const out: Record<string, unknown> = {};
  // When the previous sub-key opened a block-sequence list, this points at the
  // array we're appending `- item` lines into, plus the indent of the sub-key
  // so we know when the list ends. Reset to undefined on any non-list line.
  let pendingList: { items: unknown[]; keyIndent: number } | undefined;

  for (const rawLine of lines) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(rawLine)) {
      // A column-0 key. Are we entering, or leaving, our block?
      const km = rawLine.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
      const isOurs = km?.[1] === key;
      inBlock = isOurs === true;
      pendingList = undefined;
      if (isOurs) {
        found = true;
        // Reject an inline value on the block key (e.g. `discord: foo`); the
        // block form is `discord:` followed by indented scalars.
      }
      continue;
    }
    if (!inBlock) continue;
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;

    const indent = rawLine.length - rawLine.replace(/^ +/, "").length;
    const t = rawLine.trim();

    // A `- item` line continues an open block-sequence list iff it's indented
    // deeper than the sub-key that opened the list. (Trim-first + literal "-"
    // check — no `^\s+-\s*(.+?)\s*$` polynomial regex on adversarial space.)
    if (pendingList && t.startsWith("-") && indent > pendingList.keyIndent) {
      pendingList.items.push(coerceScalar(t.slice(1).trim()));
      continue;
    }
    pendingList = undefined;

    // A `name: value` sub-key. (No leading/trailing `\s*` in the pattern —
    // coerceScalar trims; avoids CodeQL js/polynomial-redos.)
    const m = t.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (!m) continue;
    const subKey = m[1];
    const rest = m[2].trim();
    if (rest.startsWith("[")) {
      // Inline-flow list.
      const inner = rest.replace(/^\[/, "").replace(/\]\s*$/, "");
      out[subKey] = splitList(inner).map(coerceScalar);
    } else if (rest === "") {
      // Empty value — may be the head of a block-sequence list. Open a pending
      // list; if no `- item` lines follow, it stays an empty array.
      const list: unknown[] = [];
      out[subKey] = list;
      pendingList = { items: list, keyIndent: indent };
    } else {
      out[subKey] = coerceScalar(rest);
    }
  }
  return found ? out : undefined;
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
