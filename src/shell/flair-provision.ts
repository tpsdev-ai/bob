// Flair provisioning — the ordered half of "onboard produces a Flair-native
// agent" (#93 + #94, tracks of epic #96).
//
// `bob onboard` used to leave two of the four things an agent needs undone:
// the Ed25519 keypair was written to disk but no Agent record was ever created
// (#93), and the persona was written to a local file that the memory substrate
// never saw (#94). Both were one function call away, and neither was made.
//
// This module is the call. It exists as its own unit — rather than inline in
// cli.ts — because the ORDER is the contract, and an order that lives inside a
// CLI subcommand cannot be tested without a subprocess:
//
//   1. register the Agent record   (admin credential; writes)
//   2. mirror the soul             (agent's own key; requires 1)
//
// Step 2 physically cannot run first: pushSoulToFlair takes a
// FlairRegistration, and the only producers of one are step 1's
// registerWithFlair and its read-only sibling verifyRegisteredWithFlair. That
// is deliberate. Flair attributes a Soul row to the SIGNING identity and
// refuses a signature it cannot resolve to an Agent record, so a soul write in
// front of registration is not merely out of order — it is a 401 that would
// have to be reported as a warning and ignored, which is how #93 and #94 were
// born in the first place.

import { basename } from "node:path";
import {
  type FlairFetch,
  type FlairRegistration,
  registerWithFlair,
  verifyRegisteredWithFlair,
} from "./flair-pair.js";
import { type PushSoulOptions, pushSoulToFlair, type SoulPushResult } from "./flair-soul.js";

export interface ProvisionFlairIdentityOptions {
  name: string;
  role?: string;
  displayName?: string;
  // Flair REST base URL the agent belongs to (bob.yaml's flair.url).
  flairUrl: string;
  // Public key from flairPair(), base64 raw Ed25519.
  publicKeyBase64: string;
  // Path to the agent's private key — used to SIGN the soul write as the agent.
  keyFile: string;
  // Absolute path to the agent's soul.md.
  soulPath: string;
  // Overrides / seams.
  opsUrl?: string;
  adminPassFile?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FlairFetch;
  now?: () => number;
  uuid?: () => string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
  warn?: (message: string) => void;
}

export interface ProvisionFlairIdentityResult {
  registration: FlairRegistration;
  soul: SoulPushResult;
}

// Onboard path: register the identity with admin credentials, THEN mirror the
// soul. Throws (never warns-and-continues) on a missing admin credential — see
// FlairAdminCredentialError, which carries the operator-facing instructions.
export async function provisionFlairIdentity(
  opts: ProvisionFlairIdentityOptions,
): Promise<ProvisionFlairIdentityResult> {
  const registration = await registerWithFlair({
    name: opts.name,
    publicKeyBase64: opts.publicKeyBase64,
    flairUrl: opts.flairUrl,
    opsUrl: opts.opsUrl,
    adminPassFile: opts.adminPassFile,
    keyPath: opts.keyFile,
    env: opts.env,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
  });
  const soul = await pushSoulToFlair(registration, soulOptions(opts));
  return { registration, soul };
}

export interface SyncFlairSoulOptions
  extends Omit<ProvisionFlairIdentityOptions, "publicKeyBase64" | "opsUrl" | "adminPassFile"> {
  publicKeyBase64?: string;
}

// Align path: the persona changed but the identity already exists. VERIFY
// registration (signed with the agent's own key — no admin credential needed,
// and `bob align` should not require one) and then mirror.
//
// Verification is not skippable here. Writing a soul for an identity Flair
// does not know produces a 401 whose only honest handling is to fail, so bob
// checks first and fails with the fix instead.
export async function syncFlairSoul(
  opts: SyncFlairSoulOptions,
): Promise<ProvisionFlairIdentityResult> {
  const registration = await verifyRegisteredWithFlair({
    name: opts.name,
    flairUrl: opts.flairUrl,
    keyFile: opts.keyFile,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
    uuid: opts.uuid,
    readFile: opts.readFile,
  });
  const soul = await pushSoulToFlair(registration, soulOptions(opts));
  return { registration, soul };
}

function soulOptions(opts: SyncFlairSoulOptions): PushSoulOptions {
  return {
    soulPath: opts.soulPath,
    displayName: opts.displayName ?? capitalize(opts.name),
    role: opts.role,
    keyFile: opts.keyFile,
    fetchImpl: opts.fetchImpl as PushSoulOptions["fetchImpl"],
    now: opts.now,
    uuid: opts.uuid,
    readFile: opts.readFile,
    writeFile: opts.writeFile,
    warn: opts.warn,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// One-line summary of what provisioning did, for the CLI. Says which of the
// three registration outcomes happened rather than a generic "ok" — a repair
// and a no-op are different facts about the machine and the operator should
// not have to guess which one they got.
export function describeProvisioning(result: ProvisionFlairIdentityResult): string {
  const { registration, soul } = result;
  const outcome = {
    created: "Agent record created",
    "already-registered": "Agent record already present (public key matches)",
    repaired: "Agent record REPAIRED — its public key did not match the key on disk",
  }[registration.outcome];
  const keys = soul.entries.map((e) => e.key).join(", ");
  const lines = [
    `  identity  ${registration.agentId} @ ${registration.flairUrl} — ${outcome}`,
    `  soul      ${soul.entries.length} entries written (${keys})`,
  ];
  if (soul.diverged && soul.backupPath) {
    lines.push(`  warning   Flair's previous persona saved to ${basename(soul.backupPath)}`);
  }
  return lines.join("\n");
}
