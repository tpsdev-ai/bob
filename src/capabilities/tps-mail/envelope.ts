// Accepting a TPS mail record (bob#200 §2) — everything here runs BEFORE any
// session exists.
//
// A record in the maildir is `{ id, from, to, body, timestamp, headers? }`, and
// every field of it is an unsigned claim sitting in a file. The credential is
// the INNER signed envelope carried as the record's `body` (a JSON string):
//
//   { v: 1, from, to, subject?, body, messageId, timestamp,
//     delegationChain: [{ agent, kind, timestamp, rationale, signature }],
//     signature: "ed25519:<base64>" }
//
// This module decides one record: verify the inner envelope against the
// sender's key, bind the verified `from` to the record's `from` and to
// `X-TPS-Sender`, check the recipient and the id shapes, then apply the
// allow-list to the VERIFIED id. `X-TPS-Trust` is never read (F1).
//
// WHY THE VERIFIER LIVES HERE (finding, stated in the PR): the TPS CLI's
// verifier is `verifyEnvelope` in @tpsdev-ai/agent (packages/agent/src/lib/
// signEnvelope.ts). bob depends on no TPS package, and `tps` has no verify
// command to shell out to. So this is the SAME check with the SAME primitive
// and canonicalization — Ed25519 (node:crypto, RFC 8032) over RFC 8785 JCS
// bytes, ported line-for-line from the `canonicalize@3.0.0` package the CLI
// signs with — and it is pinned by envelopes the CLI's own signEnvelope
// produced (test/fixtures/tps-mail/cli-signed-envelopes.json). No new crypto:
// the signature primitive is node's.
//
// The steps mirror the CLI's verifyEnvelope + decideEnvelopeForMailbox:
// version, chain length and shape, chain tip == from, human entries unsigned,
// every agent-kind chain entry verified over jcs({prior, entry-without-sig}),
// the outer signature over jcs(envelope-without-signature), the wrapper/
// envelope `from` binding, recipient == this mailbox, messageId and timestamp
// shape. The CLI's replay ledger is replaced by the consumer's replied/ marker,
// keyed on the same signed messageId.

import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { TPS_AGENT_ID } from "./config.js";

// ─── RFC 8785 canonicalization ──────────────────────────────────────────────
//
// A port of canonicalize@3.0.0 (the package the CLI signs with): primitives
// through JSON.stringify, object keys sorted by UTF-16 code unit, undefined /
// symbol properties skipped, undefined / symbol array items as null. Inputs
// here come from JSON.parse or are built by this module, so there is no
// toJSON or cycle case to handle — both still fail closed.
export function canonicalize(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalize: non-finite number");
  }
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    if (out === undefined) throw new Error("canonicalize: value has no JSON form");
    return out;
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => canonicalize(item === undefined || typeof item === "symbol" ? null : item))
      .join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const item = obj[key];
    if (item === undefined || typeof item === "symbol") continue;
    parts.push(`${JSON.stringify(key)}:${canonicalize(item)}`);
  }
  return `{${parts.join(",")}}`;
}

// ─── Ed25519 ────────────────────────────────────────────────────────────────

// A key resolver returns the sender's registered raw 32-byte Ed25519 public
// key, `null` when the principal is not registered (an unpinned key), and
// THROWS when it cannot answer (Flair down) — a retryable outage, not a verdict.
export type KeyResolver = (agentId: string) => Promise<Buffer | null>;

function decodeSignature(sig: unknown): Buffer | null {
  if (typeof sig !== "string" || !sig.startsWith("ed25519:")) return null;
  const bytes = Buffer.from(sig.slice("ed25519:".length), "base64");
  return bytes.length === 64 ? bytes : null;
}

function verifySig(payload: string, sig: Buffer, publicKey: Buffer): boolean {
  if (publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey.toString("base64url") },
      format: "jwk",
    });
    return verifyEd25519(null, Buffer.from(payload, "utf8"), key, sig);
  } catch {
    return false;
  }
}

// ─── The decision ───────────────────────────────────────────────────────────

// Why a record is refused. Each is counted separately in stats and doctor (F9).
export const REFUSAL_REASONS = [
  "malformed",
  "unsigned",
  "bad-signature",
  "unpinned-key",
  "from-mismatch",
  "wrong-recipient",
  "sender-not-allowed",
  // A second, DIFFERENT signed envelope reusing a messageId this agent already
  // answered (or is answering). Refused, never acked as a re-delivery: the
  // consumer's state for an id is bound to the sender and envelope digest.
  "id-collision",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

// The inbound id the consumer keys everything on (the replied/ marker, the
// reply's threading). It is the SIGNED envelope messageId — stable across a
// re-delivery and across a relay hop, unlike the record's local `id` — and it
// becomes a filename and an argv element, so its shape is strict.
export const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface AcceptedMail {
  kind: "accept";
  // The VERIFIED sender id (inner envelope `from`, bound to the record).
  sender: string;
  // The signed envelope messageId.
  messageId: string;
  // The signed body — untrusted data, sanitized later by the prompt template.
  body: string;
  // sha256 (hex) of the RFC 8785 form of the whole verified envelope, with the
  // OUTER signature normalized to its verified bytes (canonical padded base64):
  // the same signed envelope re-delivered — however that signature was
  // base64-encoded — has the same digest; another envelope reusing its
  // messageId does not.
  digest: string;
}

export type InboundDecision =
  | AcceptedMail
  | { kind: "refuse"; reason: RefusalReason; detail: string }
  // The key could not be resolved (Flair unreachable): retry later.
  | { kind: "unavailable"; detail: string };

export interface DecideOptions {
  // This mailbox's owner — the agent's own TPS id. The envelope must be
  // addressed to it.
  identity: string;
  // The allow-list, exact match on the verified id.
  senders: ReadonlySet<string>;
  resolveKey: KeyResolver;
}

const refuse = (reason: RefusalReason, detail: string): InboundDecision => ({
  kind: "refuse",
  reason,
  detail,
});

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Every header whose name is X-TPS-Sender, case-insensitively (the CLI writes
// "X-TPS-Sender"; the agent runtime also reads the lower-case spelling).
function senderHeaders(record: Record<string, unknown>): unknown[] {
  if (!isObject(record.headers)) return [];
  return Object.entries(record.headers)
    .filter(([name]) => name.toLowerCase() === "x-tps-sender")
    .map(([, value]) => value);
}

interface ChainEntry {
  agent: string;
  kind: "human" | "agent";
  timestamp: string;
  rationale: string;
  signature: string | null;
}

function isChainEntry(v: unknown): v is ChainEntry {
  if (!isObject(v)) return false;
  return (
    typeof v.agent === "string" &&
    (v.kind === "human" || v.kind === "agent") &&
    typeof v.timestamp === "string" &&
    typeof v.rationale === "string" &&
    (v.signature === null || typeof v.signature === "string")
  );
}

// The identity of a verified envelope: its signed content plus the OUTER
// signature as the bytes that verified. The outer signature is the one field
// outside the signed payload, and decodeSignature accepts any base64 encoding
// of it (unpadded, whitespace), so it is replaced by the canonical encoding of
// those bytes — an encoding difference is never mistaken for a different
// envelope. The chain entries' signatures are NOT normalized: they are part of
// what the outer signature covers, so their exact strings are signed content
// (a re-encoded one does not verify at all).
function envelopeDigest(envelope: Record<string, unknown>): string {
  const bytes = decodeSignature(envelope.signature);
  const identity = {
    ...envelope,
    signature: bytes ? `ed25519:${bytes.toString("base64")}` : envelope.signature,
  };
  return createHash("sha256").update(canonicalize(identity), "utf8").digest("hex");
}

// Decide one maildir record. Never throws: every outcome is a decision.
//
// RETRY IS RESERVED FOR THE KEY SERVICE (Gauge round 4, blocker 4). Only a key
// lookup that cannot answer yields `unavailable`; that is caught where the
// lookup happens. Anything ELSE that throws while checking a record is a
// property of the record, not of the moment — above all a value canonicalize
// refuses (JSON.parse("1e400") is Infinity, and RFC 8785 has no Infinity), which
// would throw on every retry forever. So it is REFUSED as malformed and moved
// to refused/, never left in new/ to loop.
export async function decideInbound(
  record: unknown,
  opts: DecideOptions,
): Promise<InboundDecision> {
  try {
    return await decideRecord(record, opts);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return refuse(
      "malformed",
      /^canonicalize:/.test(why)
        ? `the envelope cannot be canonicalized (${why.slice("canonicalize: ".length)}), so it cannot be verified`
        : "the record could not be checked",
    );
  }
}

async function decideRecord(record: unknown, opts: DecideOptions): Promise<InboundDecision> {
  if (!isObject(record) || typeof record.from !== "string" || typeof record.body !== "string") {
    return refuse("malformed", "the record is not a TPS mail record (from/body missing)");
  }

  // The inner envelope. A body that is not a v1 signed envelope is unsigned
  // mail, which is refused outright (the CLI dead-letters it the same way).
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(record.body);
    if (!isObject(parsed)) throw new Error("not an object");
    envelope = parsed;
  } catch {
    return refuse("unsigned", "the body is not a signed envelope");
  }
  if (
    typeof envelope.v !== "number" ||
    !Array.isArray(envelope.delegationChain) ||
    typeof envelope.signature !== "string"
  ) {
    return refuse("unsigned", "the body is not a v1 signed envelope");
  }

  // 1. Verify the envelope (the CLI's verifyEnvelope, step for step).
  if (envelope.v !== 1) return refuse("bad-signature", "unsupported envelope version");
  const from = envelope.from;
  if (typeof from !== "string" || !TPS_AGENT_ID.test(from)) {
    return refuse("malformed", "the envelope's from is not a TPS agent id");
  }
  const chain = envelope.delegationChain as unknown[];
  if (chain.length === 0) return refuse("bad-signature", "empty delegation chain");
  if (chain.length > 16) return refuse("bad-signature", "delegation chain too long");
  if (!chain.every(isChainEntry)) return refuse("bad-signature", "malformed delegation chain");
  const entries = chain as ChainEntry[];
  if (entries[entries.length - 1].agent !== from) {
    return refuse("bad-signature", "delegation chain tip does not match the envelope's from");
  }
  for (const entry of entries) {
    if (entry.kind === "human" && entry.signature !== null) {
      return refuse("bad-signature", "a human chain entry carries a signature");
    }
  }

  // Resolve every signing principal's registered key.
  const principals = new Set<string>([from]);
  for (const entry of entries) if (entry.kind === "agent") principals.add(entry.agent);
  const keys = new Map<string, Buffer>();
  for (const principal of principals) {
    let key: Buffer | null;
    try {
      key = await opts.resolveKey(principal);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { kind: "unavailable", detail: `could not resolve the key for ${principal}: ${why}` };
    }
    if (key === null) {
      return refuse("unpinned-key", `${principal} has no registered key`);
    }
    keys.set(principal, key);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.kind !== "agent") continue;
    const sig = decodeSignature(entry.signature);
    const payload = canonicalize({
      prior: entries.slice(0, i),
      entry: {
        agent: entry.agent,
        kind: entry.kind,
        timestamp: entry.timestamp,
        rationale: entry.rationale,
        signature: undefined,
      },
    });
    const key = keys.get(entry.agent);
    if (!sig || !key || !verifySig(payload, sig, key)) {
      return refuse("bad-signature", `delegation chain entry ${i} does not verify`);
    }
  }

  const outerSig = decodeSignature(envelope.signature);
  const { signature: _omit, ...unsigned } = envelope;
  const fromKey = keys.get(from);
  if (!outerSig || !fromKey || !verifySig(canonicalize(unsigned), outerSig, fromKey)) {
    return refuse("bad-signature", "the envelope signature does not verify");
  }

  // 2. Bind the verified `from` to the record's `from` and to X-TPS-Sender. A
  //    relayed record may carry no headers at all (the relay writes none), so
  //    the header binds only when it is present — but when present it must agree.
  if (record.from !== from) {
    return refuse("from-mismatch", `record from ${record.from} != signed from ${from}`);
  }
  for (const header of senderHeaders(record)) {
    if (header !== from) {
      return refuse("from-mismatch", `X-TPS-Sender ${String(header)} != signed from ${from}`);
    }
  }

  // The verified recipient must be this mailbox's owner.
  if (envelope.to !== opts.identity) {
    return refuse("wrong-recipient", `the envelope is addressed to ${String(envelope.to)}`);
  }

  // The signed id and timestamp have a shape (the marker and the reply's
  // threading key on the id).
  const messageId = envelope.messageId;
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) {
    return refuse("malformed", "the envelope messageId is missing or not a safe id");
  }
  if (typeof envelope.timestamp !== "string" || Number.isNaN(Date.parse(envelope.timestamp))) {
    return refuse("malformed", "the envelope timestamp is missing or not ISO-8601");
  }
  if (typeof envelope.body !== "string") {
    return refuse("malformed", "the envelope body is not a string");
  }

  // 3. The allow-list, on the VERIFIED id, exact match.
  if (!opts.senders.has(from)) {
    return refuse("sender-not-allowed", `${from} is not in tps-mail senders`);
  }

  const digest = envelopeDigest(envelope);
  return { kind: "accept", sender: from, messageId, body: envelope.body, digest };
}
