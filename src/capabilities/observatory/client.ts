// Ed25519-authenticated HTTP client for the observatory, decoupled from the pi
// ExtensionAPI so it can be unit-tested with injected fetch/clock/key. This is
// the observatory analog of cap-flair's FlairHttpClient — same TPS-Ed25519 wire
// protocol — with TWO deliberate differences:
//   1. it signs with the OFFICE key (not a per-agent Flair key): the endpoint
//      verifies ObsOffice.publicKey (see tps-observatory/resources/IngestEvents.ts).
//   2. it POSTs ONE batched call per office per tick to /IngestEvents (the
//      endpoint rate-limits 1 call/10s per office and accepts arrays).
//
// PROTOCOL (mirrors flair's canonical scripts/flair-client.mjs + IngestEvents):
//   Authorization: TPS-Ed25519 <officeId>:<tsMs>:<nonce>:<sigB64>
//   signature = Ed25519( "<officeId>:<tsMs>:<nonce>:POST:/IngestEvents" )
//   - tsMs is Date.now() in MILLISECONDS (NOT seconds — a 1000x error → 401).
//   - the server enforces a ±window on tsMs + (by CP2) nonce dedup; each record
//     ALSO carries its own nonce+tsMs for the per-record replay store.
//   body: { officeId, events: OrgEventRecord[], agents: AgentStatus[], syncedAt }
//
// SECURITY:
//   * The OFFICE private key is read from a FILE PATH once, imported as a
//     non-extractable CryptoKey, and used only to sign. It is never logged,
//     echoed, returned in a tool result, or placed in an error message.
//   * sanitize() runs HERE, immediately before the POST is assembled, so there
//     is exactly one path to the wire and it is always redacted (defense in
//     depth — the builder already passes summaries only).

import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { sanitize } from "./sanitize.js";
import type { AgentStatus, OrgEventRecord } from "./snapshot.js";

const { subtle } = webcrypto;

// The signed POST path — bound into the signature payload (so a signature for
// one endpoint can't be replayed against another).
const INGEST_PATH = "/IngestEvents";

export interface IngestBatch {
  events: OrgEventRecord[];
  agents: AgentStatus[];
}

export interface IngestResult {
  ok: boolean;
  events: number;
  agents: number;
}

export interface ObservatoryClient {
  // POST one batched, signed, sanitized call for the whole office.
  post(batch: IngestBatch): Promise<IngestResult>;
}

// Minimal fetch shape we depend on (so tests pass a fake without DOM lib types).
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ObservatoryHttpClientOptions {
  url: string;
  officeId: string;
  // Path to the base64-PKCS8 OFFICE Ed25519 private key. Read once, lazily.
  officeKeyFile: string;
  // Seams (tests). Production uses global fetch, Date.now, randomUUID, fs.
  fetchImpl?: FetchLike;
  now?: () => number;
  uuid?: () => string;
  readFile?: (path: string) => string;
}

export class ObservatoryHttpClient implements ObservatoryClient {
  private readonly url: string;
  private readonly officeId: string;
  private readonly officeKeyFile: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly readFile: (path: string) => string;
  // Imported once; reused across requests.
  private keyPromise?: Promise<webcrypto.CryptoKey>;

  constructor(opts: ObservatoryHttpClientOptions) {
    // Drop trailing slashes so `${url}${path}` never doubles them. A linear loop
    // (not a `/\/+$/` regex) — the regex form is a polynomial-ReDoS class on
    // uncontrolled (config) input that CodeQL rightly flags.
    let base = opts.url;
    while (base.endsWith("/")) base = base.slice(0, -1);
    this.url = base;
    this.officeId = opts.officeId;
    // Expand a leading ~/ so configs can use the ~/.flair/keys/<name>.key
    // convention without the caller pre-resolving it.
    this.officeKeyFile = opts.officeKeyFile.startsWith("~/")
      ? `${homedir()}/${opts.officeKeyFile.slice(2)}`
      : opts.officeKeyFile;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i) as unknown as ReturnType<FetchLike>);
    this.now = opts.now ?? (() => Date.now());
    this.uuid = opts.uuid ?? (() => webcrypto.randomUUID());
    this.readFile = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
  }

  private loadKey(): Promise<webcrypto.CryptoKey> {
    if (!this.keyPromise) {
      const b64 = this.readFile(this.officeKeyFile).trim();
      this.keyPromise = subtle.importKey(
        "pkcs8",
        Buffer.from(b64, "base64"),
        { name: "Ed25519" },
        false,
        ["sign"],
      );
    }
    return this.keyPromise;
  }

  // post — sanitize → sign with the OFFICE key → POST one batched call.
  async post(batch: IngestBatch): Promise<IngestResult> {
    // REDACTION BOUNDARY: the only path to the wire, always sanitized.
    const clean = sanitize(batch);

    const key = await this.loadKey();
    const ts = String(this.now());
    const nonce = this.uuid();
    // tsMs in MILLISECONDS. Signature binds officeId + ts + nonce + METHOD+path,
    // so a captured signature can't be replayed against another endpoint/office.
    const payload = `${this.officeId}:${ts}:${nonce}:POST:${INGEST_PATH}`;
    const sig = await subtle.sign("Ed25519", key, new TextEncoder().encode(payload));

    const body = JSON.stringify({
      officeId: this.officeId,
      events: clean.events,
      agents: clean.agents,
      syncedAt: new Date(Number(ts)).toISOString(),
    });

    const headers: Record<string, string> = {
      Authorization: `TPS-Ed25519 ${this.officeId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`,
      "Content-Type": "application/json",
    };

    const res = await this.fetchImpl(`${this.url}${INGEST_PATH}`, {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      // Never include the request body or auth header — only status + a short,
      // server-provided reason (which names no secret).
      throw new Error(`observatory POST ${INGEST_PATH} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    let parsed: { ok?: boolean; events?: number; agents?: number } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // Endpoint returned non-JSON 200 — treat as success with unknown counts.
    }
    return {
      ok: parsed.ok ?? true,
      events: typeof parsed.events === "number" ? parsed.events : clean.events.length,
      agents: typeof parsed.agents === "number" ? parsed.agents : clean.agents.length,
    };
  }
}
