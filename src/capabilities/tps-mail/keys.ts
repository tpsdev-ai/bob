// The sender's pinned key: the Ed25519 public key REGISTERED for that principal
// in the agent's own Flair — the same source the TPS CLI's verify adapter reads
// (cli packages/cli/src/utils/mail-verify.ts: a signed `GET /Agent/<id>` as the
// mailbox owner). The GAL maps agents to branches and carries no keys, so it is
// not a key source.
//
// Three outcomes, kept distinct because they mean different things:
//   * a 32-byte key          → verify against it;
//   * null (404)             → the principal is not registered here: an
//                              UNPINNED key, a terminal refusal;
//   * a throw                → Flair did not answer usefully (down, 5xx, auth):
//                              a retryable outage, never a verdict about the mail.
//
// No cache: a rotated key takes effect on the next message.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadFlairPrivateKey, tpsEd25519AuthHeader } from "../flair/client.js";
import { expandHome } from "./config.js";
import type { KeyResolver } from "./envelope.js";

export interface FlairKeyResolverOptions {
  flairUrl: string;
  // The mailbox owner — the identity that signs the lookup.
  agentId: string;
  // The owner's private key file (bob.yaml flair.keyFile, `~/` expanded).
  keyFile: string;
  fetchImpl?: (
    url: string,
    init: { method: string; headers: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now?: () => number;
  readFile?: (path: string) => Buffer;
  timeoutMs?: number;
}

export function createFlairKeyResolver(opts: FlairKeyResolverOptions): KeyResolver {
  const base = opts.flairUrl.replace(/\/+$/, "");
  const keyFile = expandHome(opts.keyFile);
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p));
  const doFetch =
    opts.fetchImpl ??
    ((url, init) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      }) as unknown as ReturnType<NonNullable<FlairKeyResolverOptions["fetchImpl"]>>);

  return async (agentId: string): Promise<Buffer | null> => {
    const path = `/Agent/${encodeURIComponent(agentId)}`;
    const authorization = tpsEd25519AuthHeader({
      agentId: opts.agentId,
      key: loadFlairPrivateKey(readFile(keyFile), keyFile),
      method: "GET",
      path,
      tsMs: (opts.now ?? Date.now)(),
      nonce: randomUUID(),
    });
    const res = await doFetch(`${base}${path}`, {
      method: "GET",
      headers: { Authorization: authorization },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Flair answered HTTP ${res.status} for ${path}`);
    const record = (await res.json()) as { publicKey?: unknown } | null;
    if (!record || typeof record.publicKey !== "string" || record.publicKey.length === 0) {
      // A registered principal with no key cannot sign anything: unpinned.
      return null;
    }
    const key = Buffer.from(record.publicKey, "base64");
    if (key.length !== 32) {
      throw new Error(`Flair's key for ${agentId} is not a raw 32-byte Ed25519 key`);
    }
    return key;
  };
}
