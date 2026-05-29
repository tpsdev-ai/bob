// Ed25519-authenticated HTTP client for a Flair store, decoupled from the pi
// ExtensionAPI so it can be unit-tested with injected fetch/clock/key. This is
// the flair analog of @tpsdev-ai/bob-discord's DiscordJsClient, but the wire
// protocol is plain HTTP + a TPS-Ed25519 signature (no heavy dep), so it lives
// inline in the capability package.
//
// PROTOCOL (mirrors flair's canonical scripts/flair-client.mjs):
//   Authorization: TPS-Ed25519 <agentId>:<tsMs>:<nonce>:<sigB64>
//   signature = Ed25519( "<agentId>:<tsMs>:<nonce>:<METHOD>:<path>" )
//   - tsMs is Date.now() in MILLISECONDS (NOT seconds — a 1000x error → 401).
//   search: POST /SemanticSearch {agentId, q, limit} -> { results:[{id,content,createdAt,_score}] }
//   write : PUT  /Memory/<id> {id, agentId, content, durability, createdAt, supersedes?}
//   get   : GET  /Memory/<id>
//
// SECURITY: the private key is read from a FILE PATH once, imported as a
// non-extractable CryptoKey, and used only to sign. It is never logged, echoed,
// returned in a tool result, or placed in an error message.

import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

const { subtle } = webcrypto;

export interface FlairSearchHit {
  id: string;
  content: string;
  createdAt?: string;
  score?: number;
}

export interface FlairMemory {
  id: string;
  content?: string;
  createdAt?: string;
  durability?: string;
  [k: string]: unknown;
}

export type Durability = "ephemeral" | "standard" | "persistent" | "permanent";

export interface FlairClient {
  search(query: string, limit?: number): Promise<FlairSearchHit[]>;
  write(content: string, opts?: { durability?: Durability; supersedes?: string }): Promise<{ id: string }>;
  get(id: string): Promise<FlairMemory | null>;
}

// Minimal fetch shape we depend on (so tests pass a fake without DOM lib types).
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface FlairHttpClientOptions {
  url: string;
  agentId: string;
  // Path to the base64-PKCS8 Ed25519 private key. Read once, lazily.
  keyFile: string;
  // Seams (tests). Production uses global fetch, Date.now, randomUUID, fs.
  fetchImpl?: FetchLike;
  now?: () => number;
  uuid?: () => string;
  readFile?: (path: string) => string;
}

export class FlairHttpClient implements FlairClient {
  private readonly url: string;
  private readonly agentId: string;
  private readonly keyFile: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly readFile: (path: string) => string;
  // Imported once; reused across requests.
  private keyPromise?: Promise<webcrypto.CryptoKey>;

  constructor(opts: FlairHttpClientOptions) {
    // Drop a trailing slash so `${url}${path}` never doubles it.
    this.url = opts.url.replace(/\/+$/, "");
    this.agentId = opts.agentId;
    this.keyFile = opts.keyFile;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i) as unknown as ReturnType<FetchLike>);
    this.now = opts.now ?? (() => Date.now());
    this.uuid = opts.uuid ?? (() => webcrypto.randomUUID());
    this.readFile = opts.readFile ?? ((p) => readFileSync(p, "utf8"));
  }

  private loadKey(): Promise<webcrypto.CryptoKey> {
    if (!this.keyPromise) {
      const b64 = this.readFile(this.keyFile).trim();
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

  private async signedFetch(method: string, path: string, body?: unknown): Promise<unknown> {
    const key = await this.loadKey();
    const ts = String(this.now());
    const nonce = this.uuid();
    // tsMs in MILLISECONDS — see protocol note. Signature binds method + path.
    const payload = `${this.agentId}:${ts}:${nonce}:${method}:${path}`;
    const sig = await subtle.sign("Ed25519", key, new TextEncoder().encode(payload));
    const headers: Record<string, string> = {
      Authorization: `TPS-Ed25519 ${this.agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      // Never include request body or auth header — only status + a short,
      // server-provided reason (which names no secret).
      throw new Error(`flair ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async search(query: string, limit = 5): Promise<FlairSearchHit[]> {
    const r = (await this.signedFetch("POST", "/SemanticSearch", {
      agentId: this.agentId,
      q: query,
      limit,
    })) as { results?: Array<Record<string, unknown>> } | undefined;
    const results = r?.results ?? [];
    return results.map((x) => ({
      id: String(x.id ?? ""),
      content: typeof x.content === "string" ? x.content : "",
      createdAt: typeof x.createdAt === "string" ? x.createdAt : undefined,
      score: typeof x._score === "number" ? x._score : undefined,
    }));
  }

  async write(
    content: string,
    opts: { durability?: Durability; supersedes?: string } = {},
  ): Promise<{ id: string }> {
    const id = `${this.agentId}-${this.now()}`;
    const body: Record<string, unknown> = {
      id,
      agentId: this.agentId,
      content,
      durability: opts.durability ?? "standard",
      createdAt: new Date(this.now()).toISOString(),
    };
    if (opts.supersedes) body.supersedes = opts.supersedes;
    await this.signedFetch("PUT", `/Memory/${encodeURIComponent(id)}`, body);
    return { id };
  }

  async get(id: string): Promise<FlairMemory | null> {
    const r = (await this.signedFetch("GET", `/Memory/${encodeURIComponent(id)}`)) as
      | FlairMemory
      | undefined;
    return r ?? null;
  }
}
