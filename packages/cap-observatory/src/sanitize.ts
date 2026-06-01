// sanitize() — the REDACTION BOUNDARY (Sherlock, hard requirement).
//
// A PURE function that runs BEFORE every POST to /IngestEvents. Whatever reaches
// the observatory's `structuredContent` reaches a screenshotted / shared UI, so
// the producer must never emit:
//   1. filesystem paths     — no `~/`, `/home/…`, `/Users/…`, `C:\…` in any field
//   2. secrets              — tokens / keys / bearer / API keys / PEM blocks
//   3. raw conversation     — transcripts / prompts (only Beads SUMMARIES pass)
//   4. mail / message bodies — (only summaries / metadata pass)
//
// This module is intentionally dependency-free and side-effect-free: it takes a
// string (or a record of fields) and returns the redacted form. It NEVER throws,
// NEVER logs, and NEVER calls out. It is exhaustively unit-tested against real
// dirty agent output (sanitize.test.ts) to catch drift.
//
// Design note: redaction is conservative — when a token-shaped or path-shaped
// substring is found it is replaced with a fixed placeholder, never partially
// echoed. A redactor that prints "ghp_••••cdef" still leaks entropy; we print a
// constant.

export const REDACTED = "[redacted]";

// --- secret patterns -------------------------------------------------------
// Each entry is a global regex; a match anywhere is replaced with REDACTED.
// Ordering matters only for readability — replacements are independent. Patterns
// are anchored to recognizable token shapes (provider prefixes, long base64/hex
// runs, key= / token= assignments, bearer headers, PEM bodies) rather than
// trying to recognize "a secret" semantically.
const SECRET_PATTERNS: RegExp[] = [
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_…
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // OpenAI / Anthropic / generic sk- keys.
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // xoxb/xoxp/xapp Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Bearer / TPS-Ed25519 authorization headers (capture the scheme + credential).
  /\b(?:Bearer|TPS-Ed25519)\s+[A-Za-z0-9+/_.:=-]{8,}/gi,
  // key=… / token=… / secret=… / password=… / apikey=… assignments (value redacted).
  /\b(?:api[-_]?key|secret|token|password|passwd|pwd|auth)\b\s*[:=]\s*["']?[A-Za-z0-9+/_.:=-]{6,}["']?/gi,
  // PEM private-key blocks (the body lines, conservatively the whole block).
  // Quantifiers are BOUNDED (type labels are short; a PEM block is < 8 KB) to keep
  // this linear — unbounded `[^-]*` / `[\s\S]*?` here is a polynomial-ReDoS vector
  // on crafted "-----BEGIN…PRIVATE KEY-----" repetitions (CodeQL js/polynomial-redos).
  // The long-base64/hex rules below redact the key body regardless, as backstop.
  /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?-----END[^-]{0,40}PRIVATE KEY-----/g,
  // Long opaque base64/hex runs (>= 40 chars) — JWT segments, raw key material.
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
  /\b[0-9a-fA-F]{40,}\b/g,
];

// --- filesystem path patterns ---------------------------------------------
// Replaced with REDACTED. Covers POSIX home (~), absolute /Users//home/ trees,
// and Windows drive paths. A leading-slash absolute path is redacted; bare
// relative tokens (e.g. "src/index.ts") are left — they carry no host/identity.
const PATH_PATTERNS: RegExp[] = [
  // ~ home references: ~/ or ~user/
  /~[A-Za-z0-9._-]*\/[^\s"'`)]*/g,
  // POSIX absolute paths under common user/system roots.
  /\/(?:Users|home|root|var|etc|tmp|opt|usr|private)\/[^\s"'`)]*/g,
  // Windows drive paths: C:\Users\… or C:/Users/…
  /\b[A-Za-z]:[\\/](?:Users|home)[\\/][^\s"'`)]*/g,
];

// sanitizeString — redact one free-text field. Pure; never throws on any input.
export function sanitizeString(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "";
  let out = input;
  // Secrets first (a secret may contain path-like / base64-like substrings; redact
  // the whole token before path rules nibble at it).
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  for (const re of PATH_PATTERNS) out = out.replace(re, REDACTED);
  // Collapse runs of the placeholder ("[redacted][redacted]" → "[redacted]") so
  // overlapping rules don't produce noise.
  out = out.replace(/(?:\[redacted\])(?:\s*\[redacted\])+/g, REDACTED);
  return out.trim();
}

// The fields of an OrgEventRecord / AgentStatus that carry free text and must be
// run through sanitizeString. Structural fields (ids, enums, timestamps) are not
// free text and are left intact (an agentId that matched the path/secret rules
// would be a config bug, surfaced by the schema's `^[a-z0-9-]+$` pattern).
const SANITIZED_EVENT_FIELDS = ["summary"] as const;
const SANITIZED_AGENT_FIELDS = ["currentTask", "name", "role"] as const;

// redactFields — copy `obj`, replacing each named string field with its redacted
// form. The cast to a string-indexed view is local to this helper (interfaces
// like OrgEventRecord/AgentStatus have no index signature, so we widen here
// rather than constraining callers to Record<string, unknown>). Pure: returns a
// new object; the input is never mutated.
function redactFields<T extends object>(obj: T, fields: readonly string[]): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const f of fields) {
    if (typeof out[f] === "string") out[f] = sanitizeString(out[f]);
  }
  return out as T;
}

// sanitizeEvent — redact the free-text fields of one event record. The `summary`
// is the only narrative field; everything else is structural (id/kind/authorId/
// refId/scope/createdAt/nonce/tsMs). Mail/message BODIES never reach here — the
// snapshot builder passes only summaries/metadata — but sanitize is the belt to
// that suspenders: any body that slips in is path/secret-scrubbed too.
export function sanitizeEvent<T extends object>(ev: T): T {
  return redactFields(ev, SANITIZED_EVENT_FIELDS);
}

// sanitizeAgent — redact the free-text fields of one agent snapshot. currentTask
// is the highest-risk field (it carries a Beads task summary that an agent may
// have written with a path or token in it).
export function sanitizeAgent<T extends object>(agent: T): T {
  return redactFields(agent, SANITIZED_AGENT_FIELDS);
}

// sanitize — the single boundary the producer calls before assembling the POST.
// Pure: returns a new, redacted copy of the batch (events + agents). The caller
// (client.post) MUST call this and POST the result — never the raw batch.
export function sanitize<E extends object, A extends object>(batch: {
  events: E[];
  agents: A[];
}): { events: E[]; agents: A[] } {
  return {
    events: batch.events.map(sanitizeEvent),
    agents: batch.agents.map(sanitizeAgent),
  };
}
