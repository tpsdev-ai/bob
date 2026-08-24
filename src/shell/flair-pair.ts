// Flair identity — generate an Ed25519 keypair for the agent and register it
// as a Flair Agent record, so the agent's signed memory/soul requests verify.
//
// Keys live at:
//   ~/.flair/keys/<name>.key   (private, chmod 0600)
//   ~/.flair/keys/<name>.pub   (public)
//
// Two halves, deliberately separate:
//   flairPair()              — filesystem only, sync, no network, no creds.
//   registerWithFlair()      — seeds the Agent record. Needs ADMIN creds.
//   verifyRegisteredWithFlair() — read-only check signed with the agent's OWN
//                              key. No admin creds. Used by `bob align`.
//
// SECURITY: the admin password is read from a file path or an env var, held
// only long enough to build one Basic header, and never logged, echoed, or
// placed in an error message or in argv. Every error here names the env var or
// the FILE PATH, never a value.

import { generateKeyPairSync, webcrypto } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadFlairPrivateKey, tpsEd25519AuthHeader } from "../capabilities/flair/client.js";

const AGENT_NAME = /^[a-z0-9-]+$/;

export interface FlairPairOptions {
  name: string;
  // Where keys live. Defaults to ~/.flair/keys/. Tests override.
  keysDir?: string;
  // If true, overwrite existing key files. Defaults to false (reuse).
  force?: boolean;
}

export interface FlairPairResult {
  privateKeyPath: string;
  publicKeyPath: string;
  publicKeyBase64: string;
  // True when this call generated a NEW keypair; false when it reused the one
  // already on disk. Not a registration signal — registerWithFlair owns that.
  generated: boolean;
}

// Generate (or load) the agent's Ed25519 keypair on disk.
//
// #93: this used to accept a `flairUrl` it never acted on and return
// `registered: false` with a note reading "registration skipped" — a function
// that reported on a step it had no code to perform. Registration now lives
// entirely in registerWithFlair(), which either registers or throws; there is
// no longer a shape in which "skipped" is a value bob can return and a caller
// can ignore.
export function flairPair(opts: FlairPairOptions): FlairPairResult {
  if (!AGENT_NAME.test(opts.name)) {
    throw new Error(`invalid agent name: ${opts.name} (must match ${AGENT_NAME})`);
  }
  const keysDir = opts.keysDir ?? join(homedir(), ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });

  const privPath = join(keysDir, `${opts.name}.key`);
  const pubPath = join(keysDir, `${opts.name}.pub`);

  let publicKeyBase64: string;
  let generated: boolean;
  if (existsSync(privPath) && !opts.force) {
    publicKeyBase64 = readFileSync(pubPath, "utf8").trim();
    generated = false;
  } else {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const pubRaw = publicKey.export({ format: "der", type: "spki" });
    // Strip the SPKI header (12 bytes) to get the 32-byte raw Ed25519 key.
    const pubRawBytes = pubRaw.slice(pubRaw.length - 32);
    publicKeyBase64 = pubRawBytes.toString("base64");
    writeFileSync(privPath, privPem);
    chmodSync(privPath, 0o600);
    writeFileSync(pubPath, `${publicKeyBase64}\n`);
    chmodSync(pubPath, 0o644);
    generated = true;
  }

  return {
    privateKeyPath: privPath,
    publicKeyPath: pubPath,
    publicKeyBase64,
    generated,
  };
}

// ─── Flair connection resolution ────────────────────────────────────────────

// Env var carrying the admin password, mirroring flair's own name for it
// (src/lib/auth-resolve.ts resolveLocalAdminPass). NAME only ever appears in
// bob's output — never the value.
export const ADMIN_PASS_ENV = "FLAIR_ADMIN_PASS";
// Explicit ops-API URL override, mirroring `flair agent add --ops-target`.
export const OPS_TARGET_ENV = "FLAIR_OPS_TARGET";
// Harper's ops API when the REST URL carries no explicit port. Matches flair's
// DEFAULT_OPS_PORT (its DEFAULT_PORT 19926 minus one).
const DEFAULT_OPS_PORT = 19925;

// Derive the Harper operations-API URL from the Flair REST URL.
//
// The Agent table is seeded through the ops API, not REST: flair's own
// `agent add` goes through seedAgentViaOpsApi(), and src/cli.ts carries an
// explicit "do not reintroduce a REST-root insert path" note (flair#499).
// REST cannot do this job at all — resources/Agent.ts's put() does
// `delete content.publicKey` ("key rotation goes through dedicated endpoint"),
// so a REST PUT registers a record whose signatures can never verify.
//
// Port convention is flair's (resolveOpsUrlFromTarget): explicit port minus
// one; no port on http means the default. An https URL on the implicit 443 is
// NOT guessed — on a managed instance the ops API is on a well-known port
// unrelated to REST, so bob asks rather than silently targeting :442.
export function resolveFlairOpsUrl(flairUrl: string, override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  const normalised = flairUrl.includes("://") ? flairUrl : `http://${flairUrl}`;
  const url = new URL(normalised);
  if (url.port === "") {
    if (url.protocol === "https:") {
      throw new Error(
        `cannot derive the Flair ops-API URL from ${flairUrl}: an https URL with no explicit port ` +
          `does not imply a REST-adjacent ops port. Set ${OPS_TARGET_ENV} to the instance's ` +
          `operations-API URL.`,
      );
    }
    url.port = String(DEFAULT_OPS_PORT);
    return url.toString().replace(/\/+$/, "");
  }
  const port = Number.parseInt(url.port, 10);
  const opsPort = port - 1;
  if (!Number.isFinite(opsPort) || opsPort < 1) {
    throw new Error(
      `cannot derive the Flair ops-API URL from ${flairUrl}: derived port ${opsPort} is out of range ` +
        `(the REST port must be greater than 1). Set ${OPS_TARGET_ENV} explicitly.`,
    );
  }
  url.port = String(opsPort);
  return url.toString().replace(/\/+$/, "");
}

// Thrown when registration cannot proceed for want of an admin credential.
// Distinct type so callers can render the actionable block without pattern-
// matching a message; the message itself is the operator-facing instruction.
//
// #93 exists because onboard did nothing here and said nothing. The one
// outcome this class rules out is a bob that keeps going with an agent that
// has a key and no Agent record.
export class FlairAdminCredentialError extends Error {
  readonly agentId: string;
  constructor(agentId: string, adminPassFile: string, keyPath: string) {
    super(
      [
        `cannot register Flair agent '${agentId}': no admin credential available.`,
        "",
        "Flair's Agent table is admin-only to write, so onboarding cannot register the",
        "identity without one. Until the record exists the agent's Ed25519-signed memory",
        "and soul requests are rejected as unknown_agent.",
        "",
        "Provide one of:",
        `  - ${ADMIN_PASS_ENV} in the environment (never as a command-line flag — argv is`,
        "    world-readable on this machine and lands in shell history)",
        `  - ${adminPassFile} (mode 0600) — written by \`flair init\``,
        "",
        "Or register by hand and re-run onboard; re-running is idempotent:",
        `  flair agent add ${agentId}`,
        "",
        `The keypair is already on disk at ${keyPath} — registration is the only missing step.`,
        `To scaffold without a Flair identity at all, re-run with --no-flair.`,
      ].join("\n"),
    );
    this.name = "FlairAdminCredentialError";
    this.agentId = agentId;
  }
}

export interface AdminPassSources {
  // Path to the admin password file. Defaults to ~/.flair/admin-pass.
  adminPassFile?: string;
  // Environment to read ADMIN_PASS_ENV from. Defaults to process.env.
  env?: NodeJS.ProcessEnv;
}

// Resolve the admin password, or undefined when none is available.
//
// Precedence mirrors flair's resolveLocalAdminPass: env first, then the 0600
// file `flair init` writes. There is deliberately NO command-line flag and no
// prompt — a flag puts the secret in argv, and bob's non-interactive path (the
// one fleets use) has no one to prompt.
//
// Deliberately does NOT fall back to Harper's `authorizeLocal` ambient
// loopback elevation. That path would let bob register with no credential at
// all on a default install and silently fail on a hardened one — a control
// that works only where it isn't needed.
export function resolveFlairAdminPass(opts: AdminPassSources = {}): string | undefined {
  const env = opts.env ?? process.env;
  const fromEnv = env[ADMIN_PASS_ENV];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  const file = adminPassPath(opts.adminPassFile);
  if (!existsSync(file)) return undefined;
  const contents = readFileSync(file, "utf8").trim();
  return contents === "" ? undefined : contents;
}

export function adminPassPath(override?: string): string {
  return override ?? join(homedir(), ".flair", "admin-pass");
}

// ─── Agent registration ─────────────────────────────────────────────────────

// What happened to the Agent record. Reported, never inferred by the caller.
//   created            — no record existed; bob inserted one.
//   already-registered — a record existed carrying exactly this public key.
//   repaired           — a record existed carrying a DIFFERENT public key
//                        (or the "pending" placeholder); bob updated it.
export type RegistrationOutcome = "created" | "already-registered" | "repaired";

// Proof that agent `agentId` is a registered Flair principal.
//
// This is a capability token, not a status report. It is the ONLY way to
// obtain the argument that pushSoulToFlair() requires, so a soul write cannot
// be expressed in code without a completed registration in front of it (#94's
// ordering dependency, made structural rather than incidental). Both producers
// — registerWithFlair (admin, writes) and verifyRegisteredWithFlair (agent-
// signed, read-only) — throw rather than return on the negative case.
export interface FlairRegistration {
  readonly agentId: string;
  readonly flairUrl: string;
  readonly outcome: RegistrationOutcome;
  readonly publicKeyBase64?: string;
}

// Minimal fetch shape (so tests inject a fake without DOM lib types).
export type FlairFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RegisterWithFlairArgs {
  name: string;
  publicKeyBase64: string;
  // Flair REST base URL, e.g. http://127.0.0.1:19926. The ops-API URL is
  // derived from it (resolveFlairOpsUrl) unless opsUrl / FLAIR_OPS_TARGET.
  flairUrl: string;
  opsUrl?: string;
  adminPassFile?: string;
  // Path to the agent's private key. Named only in the missing-credential
  // message so the operator knows what is already done; never read here.
  keyPath?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FlairFetch;
  now?: () => number;
}

// Register (or repair) the agent's Flair Agent record.
//
// IDEMPOTENCE — detect-then-repair, not no-op:
//   A plain "record exists, do nothing" is the defect of #93 wearing a nicer
//   face. If the stored publicKey is not the key on disk (a --force
//   regeneration, a hand-deleted key, an AgentSeed row still holding the
//   literal "pending"), the record exists AND the agent's signatures still do
//   not verify — the exact half-provisioned state onboard is supposed to end.
//   So bob reads first and converges: identical key is a true no-op, a
//   different key is UPDATED and reported as a repair. Writing the record
//   already requires admin credentials, so repair grants no authority the
//   caller did not have; it is never silent.
export async function registerWithFlair(args: RegisterWithFlairArgs): Promise<FlairRegistration> {
  if (!AGENT_NAME.test(args.name)) {
    throw new Error(`invalid agent name: ${args.name} (must match ${AGENT_NAME})`);
  }
  const env = args.env ?? process.env;
  const opsUrl = resolveFlairOpsUrl(args.flairUrl, args.opsUrl ?? env[OPS_TARGET_ENV]);
  const adminPass = resolveFlairAdminPass({ adminPassFile: args.adminPassFile, env });
  if (adminPass === undefined) {
    throw new FlairAdminCredentialError(
      args.name,
      adminPassPath(args.adminPassFile),
      args.keyPath ?? join(homedir(), ".flair", "keys", `${args.name}.key`),
    );
  }
  const post = opsPoster(opsUrl, adminPass, args.fetchImpl);
  const now = args.now ?? (() => Date.now());

  const existing = await readAgentRecord(post, args.name);
  if (existing === null) {
    const inserted = await insertAgentRecord(post, args.name, args.publicKeyBase64, now);
    if (inserted) {
      return {
        agentId: args.name,
        flairUrl: args.flairUrl,
        outcome: "created",
        publicKeyBase64: args.publicKeyBase64,
      };
    }
    // The insert was refused as a duplicate — another process registered this
    // id between our read and our write. Fall through to the reconcile path
    // rather than reporting a creation that did not happen.
  }
  const current = existing ?? (await readAgentRecord(post, args.name));
  if (current?.publicKey === args.publicKeyBase64) {
    return {
      agentId: args.name,
      flairUrl: args.flairUrl,
      outcome: "already-registered",
      publicKeyBase64: args.publicKeyBase64,
    };
  }
  await post({
    operation: "update",
    database: "flair",
    table: "Agent",
    records: [
      {
        id: args.name,
        publicKey: args.publicKeyBase64,
        updatedAt: new Date(now()).toISOString(),
      },
    ],
  });
  return {
    agentId: args.name,
    flairUrl: args.flairUrl,
    outcome: "repaired",
    publicKeyBase64: args.publicKeyBase64,
  };
}

type OpsPoster = (body: Record<string, unknown>) => Promise<unknown>;

function opsPoster(opsUrl: string, adminPass: string, fetchImpl?: FlairFetch): OpsPoster {
  const doFetch: FlairFetch =
    fetchImpl ?? ((u, i) => fetch(u, i) as unknown as ReturnType<FlairFetch>);
  // Built once, from a value that is never stored anywhere else and never
  // rendered. `admin` is Harper's super_user, matching flair's DEFAULT_ADMIN_USER.
  const authorization = `Basic ${Buffer.from(`admin:${adminPass}`).toString("base64")}`;
  return async (body) => {
    const res = await doFetch(`${opsUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // Status + a short server-provided reason only. Never the request body
      // (it carries no secret today, but the auth header must never join it)
      // and never the operation's records.
      throw new Error(
        `flair ops-API ${String(body.operation)} ${String(body.table)} -> ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
}

interface AgentRecord {
  id: string;
  publicKey?: string;
}

// Primary-key read. `search_by_id` returns [] for a missing id (verified
// against a live Flair 5.2 ops API), which is why a missing record is `null`
// here rather than an error.
async function readAgentRecord(post: OpsPoster, id: string): Promise<AgentRecord | null> {
  const rows = (await post({
    operation: "search_by_id",
    database: "flair",
    table: "Agent",
    ids: [id],
    get_attributes: ["id", "publicKey"],
  })) as AgentRecord[] | undefined;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] ?? null;
}

// Returns false when the insert was refused because the row already exists.
// Harper reports that either as an error status carrying "duplicate"/"already
// exists" or as a 200 listing the id under `skipped_hashes` — a 200 whose body
// says nothing was written is the more dangerous of the two, because a caller
// checking only the status reports a successful registration that never
// happened.
async function insertAgentRecord(
  post: OpsPoster,
  id: string,
  publicKeyBase64: string,
  now: () => number,
): Promise<boolean> {
  const ts = new Date(now()).toISOString();
  // Mirrors flair's seedAgentViaOpsApi exactly. The ops-API insert bypasses
  // the Agent resource layer, so resources/Agent.ts's post() defaults never
  // run; omitting them lands kind=null/status=null and the agent is invisible
  // to roster/presence/Office-Space queries that filter on them (flair#521).
  let result: unknown;
  try {
    result = await post({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [
        {
          id,
          name: id,
          type: "agent",
          kind: "agent",
          status: "active",
          displayName: id,
          admin: false,
          defaultTrustTier: "unverified",
          publicKey: publicKeyBase64,
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate|already exists|\b409\b/i.test(message)) return false;
    throw err;
  }
  const skipped = (result as { skipped_hashes?: unknown[] } | undefined)?.skipped_hashes;
  if (Array.isArray(skipped) && skipped.some((h) => String(h) === id)) return false;
  return true;
}

// ─── Registration verification (no admin credential) ────────────────────────

export type RegistrationState = "registered" | "not-registered" | "unreachable";

// Is this agent registered? Signs `GET /Agent/<id>` with the agent's OWN key,
// which is the check flair's own `checkAgentRegistered` performs.
//
// An UNREGISTERED agent gets 401 {"error":"unknown_agent"} from Flair's signed-
// auth middleware, NOT a 404 — the request never reaches the Agent resource.
// A bare 401/403 without that marker is ambiguous (it can mean an agent that
// exists but failed a resource-level check), so it reports "unreachable": bob
// does not claim not-registered on an answer that cannot support the claim.
export async function checkFlairRegistration(args: {
  name: string;
  flairUrl: string;
  keyFile: string;
  fetchImpl?: FlairFetch;
  now?: () => number;
  uuid?: () => string;
  readFile?: (path: string) => string;
}): Promise<{ state: RegistrationState; detail?: string }> {
  if (!AGENT_NAME.test(args.name)) {
    throw new Error(`invalid agent name: ${args.name} (must match ${AGENT_NAME})`);
  }
  const base = args.flairUrl.replace(/\/+$/, "");
  const path = `/Agent/${encodeURIComponent(args.name)}`;
  const readFile = args.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const keyFile = args.keyFile.startsWith("~/")
    ? join(homedir(), args.keyFile.slice(2))
    : args.keyFile;

  let authorization: string;
  try {
    authorization = tpsEd25519AuthHeader({
      agentId: args.name,
      key: loadFlairPrivateKey(readFile(keyFile)),
      method: "GET",
      path,
      tsMs: (args.now ?? Date.now)(),
      nonce: (args.uuid ?? (() => webcryptoRandomUUID()))(),
    });
  } catch (err: unknown) {
    // Signing happens strictly before the request, so a key problem is never a
    // reachability fact — reporting it as "unreachable" sends the operator to
    // firewalls and ports for a problem on their own disk (flair#1023).
    const message = err instanceof Error ? err.message : String(err);
    return { state: "unreachable", detail: `key at ${keyFile} could not be loaded: ${message}` };
  }

  const doFetch: FlairFetch =
    args.fetchImpl ?? ((u, i) => fetch(u, i) as unknown as ReturnType<FlairFetch>);
  try {
    const res = await doFetch(`${base}${path}`, {
      method: "GET",
      headers: { Authorization: authorization },
    });
    if (res.ok) return { state: "registered" };
    const text = await res.text().catch(() => "");
    if (res.status === 404) return { state: "not-registered" };
    if ((res.status === 401 || res.status === 403) && /unknown_agent/i.test(text)) {
      return { state: "not-registered", detail: `HTTP ${res.status} ${text.slice(0, 80)}` };
    }
    return { state: "unreachable", detail: `HTTP ${res.status} ${text.slice(0, 80)}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: "unreachable", detail: `instance unreachable: ${message.slice(0, 120)}` };
  }
}

// Same check, but yields the FlairRegistration token a soul write requires —
// or throws. Used by `bob align`, which has the agent's own key but no admin
// credential and so cannot (and must not need to) create anything.
export async function verifyRegisteredWithFlair(args: {
  name: string;
  flairUrl: string;
  keyFile: string;
  fetchImpl?: FlairFetch;
  now?: () => number;
  uuid?: () => string;
  readFile?: (path: string) => string;
}): Promise<FlairRegistration> {
  const { state, detail } = await checkFlairRegistration(args);
  if (state === "registered") {
    return { agentId: args.name, flairUrl: args.flairUrl, outcome: "already-registered" };
  }
  const because = detail ? ` (${detail})` : "";
  if (state === "not-registered") {
    throw new Error(
      `Flair agent '${args.name}' is not registered at ${args.flairUrl}${because}. ` +
        `Its soul cannot be written until it is — Flair attributes a soul entry from the ` +
        `SIGNING identity and rejects an unknown one. Fix with: bob onboard ${args.name} --force ` +
        `(idempotent), or: flair agent add ${args.name}`,
    );
  }
  throw new Error(
    `could not verify whether Flair agent '${args.name}' is registered at ${args.flairUrl}${because}. ` +
      `Refusing to write its soul on an unverified identity. Check the instance is up ` +
      `(flair status) and that ${args.keyFile} is this agent's key.`,
  );
}

function webcryptoRandomUUID(): string {
  return webcrypto.randomUUID();
}
