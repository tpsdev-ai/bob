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

// Read a top-level `<key>:` block of flat `name: value` scalar pairs into an
// object. Used for a capability's per-capability config block (the block keyed
// by the capability name, e.g. the top-level `discord:` block). Returns
// undefined when the block is absent. Values are coerced: `true`/`false` →
// boolean, integer-looking → number, everything else → string (quotes
// stripped). Nested maps/lists are not supported (flat scalars only).
export function readBlock(yamlText: string, key: string): Record<string, unknown> | undefined {
  const lines = yamlText.split(/\r?\n/);
  let inBlock = false;
  let found = false;
  const out: Record<string, unknown> = {};
  for (const line of lines) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
      // A column-0 key. Are we entering, or leaving, our block?
      const km = line.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
      const isOurs = km?.[1] === key;
      inBlock = isOurs === true;
      if (isOurs) {
        found = true;
        // Reject an inline value on the block key (e.g. `discord: foo`); the
        // block form is `discord:` followed by indented scalars.
      }
      continue;
    }
    if (!inBlock) continue;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // Trim first, then match without leading/trailing `\s*` — avoids the
    // polynomial regex (CodeQL js/polynomial-redos). coerceScalar trims the value.
    const t = line.trim();
    const m = t.match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (m) {
      out[m[1]] = coerceScalar(m[2]);
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
  const v = stripQuotes(raw.trim());
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}
