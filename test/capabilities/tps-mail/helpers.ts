// Shared fixtures for the tps-mail tests (bob#200): throwaway Ed25519 keys, a
// test signer that builds TPS v1 envelopes exactly as the CLI's signEnvelope
// does, and a maildir record writer. No real key, no real mail, no real tps.
//
// The signer uses bob's own canonicalize — so on its own it would only prove
// bob agrees with bob. That circle is broken by
// test/fixtures/tps-mail/cli-signed-envelopes.json, envelopes the CLI's OWN
// signEnvelope produced, which envelope.test.ts verifies.

import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, type KeyResolver } from "../../../src/capabilities/tps-mail/envelope.js";

export interface TestKey {
  privateKey: KeyObject;
  // Raw 32-byte public key (what Flair registers).
  publicKey: Buffer;
}

export function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  return { privateKey, publicKey: Buffer.from(x, "base64url") };
}

export interface ChainEntry {
  agent: string;
  kind: "human" | "agent";
  timestamp: string;
  rationale: string;
  signature: string | null;
}

export interface EnvelopeFields {
  from: string;
  to: string;
  body: string;
  messageId?: string;
  timestamp?: string;
  subject?: string;
  // Extra agent hops BEFORE `from` (each signed with its own key).
  priorAgents?: Array<{ agent: string; key: TestKey }>;
}

const TS = "2026-09-28T12:00:00.000Z";

// Build and sign a v1 envelope the way @tpsdev-ai/agent's signEnvelope does.
export function signTestEnvelope(
  fields: EnvelopeFields,
  fromKey: TestKey,
): Record<string, unknown> {
  const ts = fields.timestamp ?? TS;
  const chain: ChainEntry[] = [
    { agent: "system", kind: "human", timestamp: ts, rationale: "test origin", signature: null },
    ...(fields.priorAgents ?? []).map((p) => ({
      agent: p.agent,
      kind: "agent" as const,
      timestamp: ts,
      rationale: "hop",
      signature: null,
    })),
    { agent: fields.from, kind: "agent", timestamp: ts, rationale: "test send", signature: null },
  ];
  const keyFor = (agent: string): TestKey => {
    if (agent === fields.from) return fromKey;
    const hop = fields.priorAgents?.find((p) => p.agent === agent);
    if (!hop) throw new Error(`no key for ${agent}`);
    return hop.key;
  };
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (entry.kind !== "agent") continue;
    const payload = canonicalize({
      prior: chain.slice(0, i),
      entry: { ...entry, signature: undefined },
    });
    entry.signature = `ed25519:${sign(null, Buffer.from(payload), keyFor(entry.agent).privateKey).toString("base64")}`;
  }
  const envelope: Record<string, unknown> = {
    v: 1,
    from: fields.from,
    to: fields.to,
    subject: fields.subject ?? `mail to ${fields.to}`,
    body: fields.body,
    messageId: fields.messageId ?? "0b4f6a8e-1c2d-4e5f-9a0b-1c2d3e4f5a6b",
    timestamp: ts,
    delegationChain: chain,
  };
  envelope.signature = `ed25519:${sign(null, Buffer.from(canonicalize(envelope)), fromKey.privateKey).toString("base64")}`;
  return envelope;
}

// A maildir record wrapping an envelope, as `tps mail send` writes one.
export function mailRecord(
  envelope: Record<string, unknown> | string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const body = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
  const from = typeof envelope === "string" ? "tester-a" : String(envelope.from);
  return {
    id: "11111111-2222-4333-8444-555555555555",
    from,
    to: typeof envelope === "string" ? "testbot" : String(envelope.to),
    body,
    timestamp: TS,
    read: false,
    headers: { "X-TPS-Trust": "user", "X-TPS-Sender": from },
    ...overrides,
  };
}

export function writeRecord(inbox: string, file: string, record: Record<string, unknown>): string {
  mkdirSync(join(inbox, "new"), { recursive: true });
  const path = join(inbox, "new", file);
  writeFileSync(path, JSON.stringify(record, null, 2));
  return path;
}

// An in-memory key registry standing in for Flair.
export function keyResolver(keys: Record<string, TestKey | Buffer>): KeyResolver & {
  calls: string[];
} {
  const calls: string[] = [];
  const resolver = (async (agent: string) => {
    calls.push(agent);
    const k = keys[agent];
    if (!k) return null;
    return Buffer.isBuffer(k) ? k : k.publicKey;
  }) as KeyResolver & { calls: string[] };
  resolver.calls = calls;
  return resolver;
}
