// Strip the bot's own @-mention(s) from inbound message content before handing
// it to the agent — the agent doesn't need to see its own ID. (The old
// per-message subprocess path in bob-shell did the same before PR4 removed it.)
//
// ReDoS note (CodeQL js/polynomial-redos): this regex is LINEAR. `<@` and the
// closing `>` are literal anchors around `\d+`, and the trailing `\s*` does not
// overlap any other quantifier (it sits between a literal `>` and the next
// token), so there is no ambiguous backtracking. We then `.trim()` once. We do
// NOT use a `(.+?)\s*$` / `\s*…\s*`-overlap shape.
const MENTION = /<@!?\d+>\s*/g;

export function cleanContent(content: string): string {
  return content.replace(MENTION, "").trim();
}
