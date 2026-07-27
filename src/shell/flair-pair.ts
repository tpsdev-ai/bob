// Flair pair — generate an Ed25519 keypair for the agent and register
// the public key with Flair so other agents can verify signed dispatches.
//
// Keys live at:
//   ~/.flair/keys/<name>.key   (private, chmod 0600)
//   ~/.flair/keys/<name>.pub   (public)
//
// Registration POSTs the pub key to Flair's Agent table. Idempotent: if
// the Agent record already exists, we update its publicKey field;
// otherwise we create. The flairUrl + adminPass are config — tests run
// against a stub.

import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_NAME = /^[a-z0-9-]+$/;

export interface FlairPairOptions {
  name: string;
  // Where keys live. Defaults to ~/.flair/keys/. Tests override.
  keysDir?: string;
  // Flair admin endpoint (e.g., http://127.0.0.1:9926). If empty, only
  // generates the keypair on disk and skips registration.
  flairUrl?: string;
  // Path to admin password file. Defaults to ~/.flair/admin-pass.
  adminPassFile?: string;
  // If true, overwrite existing key files. Defaults to false (refuse).
  force?: boolean;
}

export interface FlairPairResult {
  privateKeyPath: string;
  publicKeyPath: string;
  publicKeyBase64: string;
  registered: boolean;
  // If registered=false, this is the reason; if true, the Flair response.
  note: string;
}

// Generate (or load) an Ed25519 keypair on disk + optionally register
// the pub key with Flair as the agent's identity.
export function flairPair(opts: FlairPairOptions): FlairPairResult {
  if (!AGENT_NAME.test(opts.name)) {
    throw new Error(`invalid agent name: ${opts.name} (must match ${AGENT_NAME})`);
  }
  const keysDir = opts.keysDir ?? join(homedir(), ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });

  const privPath = join(keysDir, `${opts.name}.key`);
  const pubPath = join(keysDir, `${opts.name}.pub`);

  let publicKeyBase64: string;
  if (existsSync(privPath) && !opts.force) {
    publicKeyBase64 = readFileSync(pubPath, "utf8").trim();
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
  }

  if (!opts.flairUrl) {
    return {
      privateKeyPath: privPath,
      publicKeyPath: pubPath,
      publicKeyBase64,
      registered: false,
      note: "no flairUrl — keys generated, registration skipped",
    };
  }

  const adminPassFile = opts.adminPassFile ?? join(homedir(), ".flair", "admin-pass");
  if (!existsSync(adminPassFile)) {
    return {
      privateKeyPath: privPath,
      publicKeyPath: pubPath,
      publicKeyBase64,
      registered: false,
      note: `admin pass file missing at ${adminPassFile} — registration skipped`,
    };
  }

  // Registration is sync-shaped from the caller's POV but uses fetch under
  // the hood. We perform it in an IIFE so the caller can await; for PR-3
  // we expose a separate async function to keep flairPair() sync-friendly
  // for tests. See registerWithFlair below.
  return {
    privateKeyPath: privPath,
    publicKeyPath: pubPath,
    publicKeyBase64,
    registered: false,
    note: "keypair ready; call registerWithFlair() to push to Flair",
  };
}

// POST the agent's public key to Flair's Agent record. Idempotent —
// uses Flair's admin upsert_agent operation.
export async function registerWithFlair(args: {
  name: string;
  publicKeyBase64: string;
  flairUrl: string;
  adminPassFile?: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const adminPassFile = args.adminPassFile ?? join(homedir(), ".flair", "admin-pass");
  if (!existsSync(adminPassFile)) {
    throw new Error(`admin pass file missing: ${adminPassFile}`);
  }
  const adminPass = readFileSync(adminPassFile, "utf8").trim();

  // Flair admin REST API uses Basic auth on the admin endpoint.
  const url = `${args.flairUrl.replace(/\/$/, "")}/api/Agent/${encodeURIComponent(args.name)}`;
  const body = JSON.stringify({
    id: args.name,
    name: args.name,
    publicKey: args.publicKeyBase64,
  });
  const auth = Buffer.from(`admin:${adminPass}`).toString("base64");
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}
