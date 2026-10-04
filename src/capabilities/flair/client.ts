// Ed25519-authenticated HTTP client for a Flair store, decoupled from the pi
// ExtensionAPI so it can be unit-tested with injected fetch/clock/key. This is
// the flair analog of the discord capability's DiscordJsClient, but the wire
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
//   soul  : PUT  /Soul/<agentId:key> {id, agentId, key, value, durability, createdAt}
//           GET  /Soul/<agentId:key>
//
// SECURITY: the private key is read from a FILE PATH once, parsed into a
// node KeyObject, and used only to sign. It is never logged, echoed, returned
// in a tool result, or placed in an error message.

import { createPrivateKey, type KeyObject, sign as signEd25519, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { normalizeEd25519PrivateKey } from "../../lib/ed25519-key.js";

// Thrown (as a plain Error) by signedFetch when a response exceeds the size
// bound a caller passed; bootstrap maps it to a typed FlairBootstrapError so no
// other call path sees a bootstrap-specific type.
const RESPONSE_TOO_LARGE_MARKER = "flair response exceeded the size bound";

/** UTF-8 byte length of `text` — the unit the response bound counts. */
function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Read a response body as text, refusing it once its UTF-8 BYTES exceed
 * `maxBytes`. With a byte stream (`res.body`, which a real fetch response
 * carries) each chunk's bytes are checked BEFORE it is retained: once the total
 * passes the bound the stream is cancelled, and the earlier chunks — not the
 * whole body — are what was held. A fake without a stream falls back to
 * `text()`, whose complete body is received before its byte length is checked.
 * Throws RESPONSE_TOO_LARGE_MARKER past the bound.
 */
async function readBodyTextBounded(
  res: { text(): Promise<string>; body?: ResponseBody | null },
  maxBytes: number,
): Promise<string> {
  // `res` is the injected fetch result; a real fetch Response carries `body`, a
  // test fake may not. Read it if present.
  const body = res.body;
  if (body === undefined || body === null) {
    const text = await res.text();
    if (utf8ByteLength(text) > maxBytes) throw new Error(RESPONSE_TOO_LARGE_MARKER);
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(RESPONSE_TOO_LARGE_MARKER);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

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

// bob#254 — the session bootstrap (POST /BootstrapMemories). `context` is
// candidate content: Flair's rendered block, which bob may append under its own
// heading, or omit — a blank or web-session response yields nothing to append,
// and an over-budget one is replaced by a failure note. Its sections (an
// Identity section, "## Active Skills", predicted context) MAY appear, and a
// long Active Skills section can exceed Flair's own selection budget, so the
// CALLER bounds what it appends. `tokenEstimate` measures the whole response
// Flair serialized, optional because the caller does not rely on it.
export interface FlairBootstrap {
  context: string;
  tokenEstimate?: number;
}

// Default bounds on one bootstrap request: a host that accepts the request and
// never finishes cannot hold session start past the timeout, and an oversized
// body is refused rather than parsed and appended.
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;
export const DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES = 1_000_000;

export interface FlairBootstrapOptions {
  // Flair's own cap on its CONTENT SELECTION (POST /BootstrapMemories
  // maxTokens). It does NOT bound the rendered context; the caller does.
  maxTokens?: number;
  channel?: string;
  surface?: string;
  // Whether Flair includes the soul. Left at Flair's default (true): with
  // `false` Flair also drops the skill-assignment scan that builds the "Active
  // Skills" section (resources/MemoryBootstrap.ts), so the manifest this
  // feature exists to load would vanish.
  includeSoul?: boolean;
  // Per-call overrides of the client's bounds (tests). Omitted → the client's
  // configured values, defaulting to the constants above.
  timeoutMs?: number;
  maxResponseBytes?: number;
}

// Why a bootstrap call produced no context. Code-owned, so a session's failure
// line can name the cause without ever echoing server text (which can carry a
// reflected credential).
export type FlairBootstrapFailure =
  | "unreachable"
  | "timeout"
  | "http_error"
  | "too_large"
  | "invalid_response";

export class FlairBootstrapError extends Error {
  readonly failure: FlairBootstrapFailure;
  readonly status?: number;
  constructor(failure: FlairBootstrapFailure, status?: number) {
    super(
      failure === "unreachable"
        ? "flair bootstrap: the request did not complete"
        : failure === "timeout"
          ? "flair bootstrap: the request timed out"
          : failure === "http_error"
            ? `flair bootstrap: HTTP ${status ?? "error"}`
            : failure === "too_large"
              ? "flair bootstrap: the response exceeded the size bound"
              : "flair bootstrap: the response carried no context",
    );
    this.name = "FlairBootstrapError";
    this.failure = failure;
    if (status !== undefined) this.status = status;
  }
}

export interface FlairSoulEntry {
  id: string;
  agentId?: string;
  key?: string;
  value: string;
  durability?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

export type Durability = "ephemeral" | "standard" | "persistent" | "permanent";

// The presence activity enum. Mirrors PresenceActivity in capabilities/presence
// (the same five values); kept in sync by construction, defined here (not
// imported from the presence package) to avoid a circular dependency: the
// presence capability depends on this client, not the other way around.
export type PresenceActivity = "coding" | "reviewing" | "planning" | "debugging" | "idle";

export interface FlairWriteOptions {
  id?: string;
  durability?: Durability;
  supersedes?: string;
  visibility?: string;
  authorId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  subject?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface FlairReadOptions {
  // Per-call request bounds (bob#185 item 5). See FlairWriteOptions.
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface FlairClient {
  search(query: string, limit?: number): Promise<FlairSearchHit[]>;
  write(content: string, opts?: FlairWriteOptions): Promise<{ id: string }>;
  get(id: string, opts?: FlairReadOptions): Promise<FlairMemory | null>;
  bootstrap(opts?: FlairBootstrapOptions): Promise<FlairBootstrap>;
}

// The slice of a streaming body the bounded reader needs (structural, so no DOM
// lib type is required): a real fetch response carries one. Kept OFF FetchLike so
// the fetch seam every caller injects stays the minimal { ok, status, text() }
// shape; signedFetch reads the stream off the response object directly.
interface ResponseBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}
interface ResponseBody {
  getReader(): ResponseBodyReader;
}

// Minimal fetch shape we depend on (so tests pass a fake without DOM lib types).
// `signal` is passed for the bootstrap timeout; a fake that ignores it is fine
// because the timeout is also race-enforced by the caller. The size bound is
// counted off the response's byte stream when it has one (a real fetch
// response), else off the decoded text's UTF-8 byte length.
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface FlairHttpClientOptions {
  url: string;
  agentId: string;
  // Path to the Ed25519 private key. Read once, lazily. The FILE BYTES go
  // through normalizeEd25519PrivateKey, which accepts the raw 32-byte seed that
  // `flair agent add` writes, base64 of that seed, base64 PKCS8 DER, and PEM
  // PKCS8 (the form `bob flair-pair` writes).
  keyFile: string;
  // Seams (tests). Production uses global fetch, Date.now, randomUUID, fs.
  fetchImpl?: FetchLike;
  now?: () => number;
  uuid?: () => string;
  // Returns the key file's raw BYTES — the normalizer needs the byte length to
  // tell a raw seed from text, so this seam must NOT decode to a string.
  readFile?: (path: string) => Buffer;
  // Bounds on one bootstrap call (bob#254). Defaults: the constants above.
  bootstrapTimeoutMs?: number;
  bootstrapMaxResponseBytes?: number;
}

// ─── Signing primitives (exported for reuse by the shell) ───────────────────
//
// Bob signs Flair requests from this capability (the agent's memory tools at
// runtime) and the shell's read-only registration and Soul checks. Soul writes
// in onboard/align use operator Basic auth through the shell provisioning path.
// A second hand-rolled copy is how the tsMs-in-seconds 1000x defect called out
// at the top of this file gets reintroduced somewhere else.

// Parse an on-disk Flair private key into a node KeyObject. `bytes` are the raw
// file CONTENT and `path` is used only to name the file in an error. All shape
// handling lives in normalizeEd25519PrivateKey (raw 32-byte seed, base64 of the
// seed, base64 PKCS8 DER, PEM PKCS8); this only re-parses the DER it returns.
//
// SECURITY: takes the key MATERIAL, returns an opaque KeyObject. It never
// stringifies, logs or returns the input.
export function loadFlairPrivateKey(bytes: Buffer, path: string): KeyObject {
  return createPrivateKey({
    key: normalizeEd25519PrivateKey(bytes, path),
    format: "der",
    type: "pkcs8",
  });
}

// Build the `Authorization: TPS-Ed25519 …` header for one request. tsMs is in
// MILLISECONDS (a seconds value is a 1000x error the server answers with 401).
// The signature binds agentId + ts + nonce + METHOD + path, so a header cannot
// be replayed against a different route.
export function tpsEd25519AuthHeader(args: {
  agentId: string;
  key: KeyObject;
  method: string;
  path: string;
  tsMs: number;
  nonce: string;
}): string {
  const ts = String(args.tsMs);
  const payload = `${args.agentId}:${ts}:${args.nonce}:${args.method}:${args.path}`;
  // Ed25519 sign: the algorithm is the key, so the first arg MUST be null.
  // signEd25519 returns a Buffer (the 64-byte raw signature).
  const sig = signEd25519(null, Buffer.from(payload, "utf8"), args.key);
  return `TPS-Ed25519 ${args.agentId}:${ts}:${args.nonce}:${Buffer.from(sig).toString("base64")}`;
}

export class FlairHttpClient implements FlairClient {
  private readonly url: string;
  private readonly agentId: string;
  private readonly keyFile: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly readFile: (path: string) => Buffer;
  private readonly bootstrapTimeoutMs: number;
  private readonly bootstrapMaxResponseBytes: number;
  // Parsed once; reused across requests.
  private keyObject?: KeyObject;

  constructor(opts: FlairHttpClientOptions) {
    // Drop trailing slashes so `${url}${path}` never doubles them. A linear
    // loop (not a `/\/+$/` regex) — the regex form is a polynomial-ReDoS class
    // on uncontrolled (config) input that CodeQL rightly flags.
    let base = opts.url;
    while (base.endsWith("/")) base = base.slice(0, -1);
    this.url = base;
    this.agentId = opts.agentId;
    // Expand a leading ~/ so configs can use the ~/.flair/keys/<name>.key
    // convention (what `bob init` emits) without the caller pre-resolving it.
    this.keyFile = opts.keyFile.startsWith("~/")
      ? `${homedir()}/${opts.keyFile.slice(2)}`
      : opts.keyFile;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i) as unknown as ReturnType<FetchLike>);
    this.now = opts.now ?? (() => Date.now());
    this.uuid = opts.uuid ?? (() => webcrypto.randomUUID());
    this.readFile = opts.readFile ?? ((p) => readFileSync(p));
    this.bootstrapTimeoutMs = opts.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
    this.bootstrapMaxResponseBytes =
      opts.bootstrapMaxResponseBytes ?? DEFAULT_BOOTSTRAP_MAX_RESPONSE_BYTES;
  }

  // Parse the on-disk private key into a node KeyObject. See
  // loadFlairPrivateKey (module scope) for the shape-handling rationale;
  // this only adds per-instance caching.
  private loadKey(): KeyObject {
    if (!this.keyObject) {
      this.keyObject = loadFlairPrivateKey(this.readFile(this.keyFile), this.keyFile);
    }
    return this.keyObject;
  }

  private async signedFetch(
    method: string,
    path: string,
    body?: unknown,
    // Reads may surface a bounded 404 response as null.
    nullOnStatus?: readonly number[],
    extra?: { signal?: AbortSignal; maxResponseBytes?: number },
    strictBody = false,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: tpsEd25519AuthHeader({
        agentId: this.agentId,
        key: this.loadKey(),
        method,
        path,
        tsMs: this.now(),
        nonce: this.uuid(),
      }),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
    });
    const text =
      extra?.maxResponseBytes !== undefined
        ? await readBodyTextBounded(res, extra.maxResponseBytes)
        : await res.text();
    if (!res.ok) {
      if (nullOnStatus?.includes(res.status)) return null;
      // Never include request body or auth header — only status + a short,
      // server-provided reason (which names no secret).
      throw new Error(`flair ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    if (text.trim() === "") {
      if (strictBody) throw new Error("flair read returned an empty body");
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    if (parsed === null && strictBody) throw new Error("flair read returned null");
    return parsed;
  }

  // bob#185 item 5 — a signed request under optional bounds: an abort + a
  // deadline race, and a byte-bounded response read (past
  // `maxResponseBytes` the stream is cancelled and the call fails). With no
  // bounds it is exactly `signedFetch`.
  private async signedFetchWithBounds(
    method: string,
    path: string,
    body: unknown,
    bounds: { timeoutMs?: number; maxResponseBytes?: number },
    nullOnStatus?: readonly number[],
    strictBody = false,
  ): Promise<unknown> {
    if (bounds.timeoutMs === undefined) {
      // No deadline: still honor a byte bound by forwarding it to signedFetch.
      return this.signedFetch(
        method,
        path,
        body,
        nullOnStatus,
        bounds.maxResponseBytes !== undefined
          ? { maxResponseBytes: bounds.maxResponseBytes }
          : undefined,
        strictBody,
      );
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("flair request timed out"));
      }, bounds.timeoutMs);
    });
    try {
      const pending = this.signedFetch(
        method,
        path,
        body,
        nullOnStatus,
        {
          signal: controller.signal,
          ...(bounds.maxResponseBytes !== undefined
            ? { maxResponseBytes: bounds.maxResponseBytes }
            : {}),
        },
        strictBody,
      );
      pending.catch(() => {}); // the race below owns the rejection
      return await Promise.race([pending, timedOut]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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

  async write(content: string, opts: FlairWriteOptions = {}): Promise<{ id: string }> {
    // A record id is UNIQUE PER WRITE, across PROCESSES too: an explicit `id`,
    // else agent + a random UUID. NEVER a per-process counter and NEVER the
    // wall clock — two processes with the same agentId both started a counter at
    // 0, so their first records deterministically collided and overwrote each
    // other (bob#180 round 4).
    const id = opts.id ?? `${this.agentId}-${this.uuid()}`;
    const body: Record<string, unknown> = {
      id,
      agentId: opts.authorId ?? this.agentId,
      content,
      durability: opts.durability ?? "standard",
      createdAt: new Date(this.now()).toISOString(),
    };
    if (opts.supersedes) body.supersedes = opts.supersedes;
    // Optional provenance (reachy S3): visibility / author label / metadata.
    // The signature is still over the agent's own key — authorId is a label.
    if (opts.visibility) body.visibility = opts.visibility;
    if (opts.metadata) body.metadata = opts.metadata;
    if (opts.tags && opts.tags.length > 0) body.tags = opts.tags;
    if (opts.subject) body.subject = opts.subject;
    await this.signedFetchWithBounds("PUT", `/Memory/${encodeURIComponent(id)}`, body, opts);
    return { id };
  }

  async get(id: string, opts: FlairReadOptions = {}): Promise<FlairMemory | null> {
    // A 404 within the response bound is absent history.
    const r = (await this.signedFetchWithBounds(
      "GET",
      `/Memory/${encodeURIComponent(id)}`,
      undefined,
      opts,
      [404],
      true,
    )) as FlairMemory | null | undefined;
    if (r === undefined || (r !== null && (typeof r !== "object" || Array.isArray(r))))
      throw new Error("flair read returned an invalid body");
    return r;
  }

  // ── Session bootstrap (POST /BootstrapMemories) ───────────────────────────
  //
  // Signed as this agent, like every other call. A non-2xx, a response that
  // never arrives (timeout), one over the size bound, or a body whose `context`
  // is missing or not a string is an ERROR (a typed FlairBootstrapError). A
  // `context` that is present but BLANK is a successful empty response; the
  // caller decides what to do with it (it appends nothing).
  async bootstrap(opts: FlairBootstrapOptions = {}): Promise<FlairBootstrap> {
    const body: Record<string, unknown> = { agentId: this.agentId };
    if (opts.maxTokens !== undefined) body.maxTokens = opts.maxTokens;
    if (opts.channel !== undefined) body.channel = opts.channel;
    if (opts.surface !== undefined) body.surface = opts.surface;
    if (opts.includeSoul !== undefined) body.includeSoul = opts.includeSoul;
    const timeoutMs = opts.timeoutMs ?? this.bootstrapTimeoutMs;
    const maxResponseBytes = opts.maxResponseBytes ?? this.bootstrapMaxResponseBytes;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race-enforced as well as aborted: a fetch seam that ignores `signal`
    // (tests) still cannot hold the caller, and the real fetch is released by
    // the abort.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new FlairBootstrapError("timeout"));
      }, timeoutMs);
    });
    let r: unknown;
    try {
      const pending = this.signedFetch("POST", "/BootstrapMemories", body, undefined, {
        signal: controller.signal,
        maxResponseBytes,
      });
      pending.catch(() => {}); // the race below owns the rejection
      r = await Promise.race([pending, timedOut]);
    } catch (err) {
      if (err instanceof FlairBootstrapError) throw err; // timeout
      // signedFetch's message names the status and a slice of the server body;
      // that body can carry a reflected credential, so the status is parsed out
      // and the message is dropped, never re-thrown.
      const message = err instanceof Error ? err.message : "";
      if (message.startsWith(RESPONSE_TOO_LARGE_MARKER)) {
        throw new FlairBootstrapError("too_large");
      }
      const m = /^flair POST \/BootstrapMemories -> (\d{3})/.exec(message);
      throw m
        ? new FlairBootstrapError("http_error", Number(m[1]))
        : new FlairBootstrapError("unreachable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (
      r === null ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      typeof (r as { context?: unknown }).context !== "string"
    ) {
      throw new FlairBootstrapError("invalid_response");
    }
    const rec = r as { context: string; tokenEstimate?: unknown };
    return {
      context: rec.context,
      ...(typeof rec.tokenEstimate === "number" ? { tokenEstimate: rec.tokenEstimate } : {}),
    };
  }

  // ── Presence heartbeats (POST /Presence) ──────────────────────────────────
  //
  // A presence beat is a liveness + activity report for the roster. The body
  // carries ONLY { activity?, currentTask? }:
  //   * a beat with NEITHER field is a liveness-only beat — the server preserves
  //     the prior activity stamp (natural presence), so the beacon can't erase a
  //     busy stamp.
  //   * the fields are runtime-authored (a busy label, or "idle") — never a
  //     prompt, model output, or tool output. See the presence capability for the
  //     content-decision rationale.
  //
  // Verified against Flair's Presence.post: it reads exactly these two fields,
  // merges them into buildPresenceRecord, enforces the activity enum server-side,
  // caps currentTask at 200 chars, and only lets an agent write its OWN record
  // (403 cross-agent).
  async presenceBeat(opts: {
    activity?: PresenceActivity;
    currentTask?: string | null;
  }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts.activity !== undefined) body.activity = opts.activity;
    // Send currentTask whenever the caller passes it — INCLUDING an explicit
    // `null`, which the idle beat uses to CLEAR the running task on the server.
    // Omit it ONLY when the caller did not pass it at all (the liveness-only
    // beacon), so an empty body (no currentTask key) is the only thing that
    // lets the server preserve the prior activity stamp (natural presence).
    // The prior `!= null && !== ""` guard dropped the explicit idle `null`, so
    // settled never cleared `currentTask` and the roster stayed "busy" until the
    // next turn started.
    if (opts.currentTask !== undefined) body.currentTask = opts.currentTask;
    await this.signedFetch("POST", "/Presence", body);
  }

  // ── Soul (per-identity persona/context entries) ───────────────────────────
  //
  // Soul rows are keyed `<agentId>:<key>` and are written by PUT on that id —
  // the Soul table resource has no collection POST, so a bare `POST /Soul`
  // 405s (flair#498). Current Flair refuses this agent-signed write with
  // soul_write_requires_operator. Provisioning uses a separate shell-only
  // operator write; no runtime tool calls this method.
  //
  // Durability defaults to `permanent` server-side: a soul entry is identity,
  // not working memory, and must not age out of bootstrap.

  soulEntryId(key: string): string {
    return `${this.agentId}:${key}`;
  }

  async soulSet(key: string, value: string): Promise<{ id: string }> {
    const id = this.soulEntryId(key);
    await this.signedFetch("PUT", `/Soul/${encodeURIComponent(id)}`, {
      id,
      agentId: this.agentId,
      key,
      value,
      durability: "permanent",
      createdAt: new Date(this.now()).toISOString(),
    });
    return { id };
  }

  async soulGet(key: string): Promise<FlairSoulEntry | null> {
    const id = this.soulEntryId(key);
    const r = (await this.signedFetch(
      "GET",
      `/Soul/${encodeURIComponent(id)}`,
      undefined,
      [404],
    )) as FlairSoulEntry | null | undefined;
    // A verified read of a missing row can come back as null, undefined, or an
    // empty object depending on the Harper version — treat all three as "absent"
    // rather than as an entry whose value happens to be undefined.
    if (!r || typeof r.value !== "string") return null;
    return r;
  }

  // ── Agent record read (GET /Agent/<name>) ─────────────────────────────────
  //
  // Read a Flair Agent record by id. A 404 (the record is not registered yet)
  // is an ordinary answer to a read, not a failure, so it is surfaced as null
  // via signedFetch's nullOnStatus. Used to verify the signing identity exists
  // before emitting presence beats (and exercised by the client's protocol test).
  async agentGet(name: string): Promise<Record<string, unknown> | null> {
    const r = (await this.signedFetch(
      "GET",
      `/Agent/${encodeURIComponent(name)}`,
      undefined,
      [404],
    )) as Record<string, unknown> | undefined;
    return r ?? null;
  }
}
