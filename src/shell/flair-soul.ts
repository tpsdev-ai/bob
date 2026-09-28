// Flair soul — mirror the agent's persona into the Flair Soul table (#94).
//
// Before this, the persona lived ONLY in ~/agents/<name>/soul.md, a file the
// launcher pastes in via --append-system-prompt. That file is invisible to
// everything else: the agent's own `bootstrap` returned "no soul text", the
// persona did not travel to another machine running the same identity, and it
// could not federate. The identity and the self were stored in two unrelated
// places.
//
// ─── MIRROR DIRECTION (the design decision this module encodes) ─────────────
//
// Flair is the source of truth for CONSUMERS; soul.md is the source of truth
// for AUTHORING. Bob mirrors one way — local file → Flair — and only at the
// points where bob is already authoring a persona: `bob onboard` and
// `bob align`. It is the "edit here, publish there" model.
//
//   * Why not pull on launch. Launch reads the local soul.md and hands it to pi
//     as the session's appended system prompt, in-process. Fetching the soul
//     from Flair on every start would put a network round-trip on the hot path
//     of every agent invocation and make a Flair outage boot a persona-less
//     agent. A stale local file is a strictly better failure than an agent
//     that does not know who it is. So launch NEVER syncs, in either direction.
//
//   * Why local wins at authoring points. Both writers of soul.md are local:
//     the hiring interview (the agent writes the file itself with its Write
//     tool) and a human with an editor. If Flair won, the interview's output
//     would be discarded by the very command that produced it.
//
//   * What happens on divergence. Never silently resolved. Bob reads Flair's
//     current persona entry BEFORE writing; if it differs from the local file,
//     bob saves the Flair copy next to soul.md as soul.flair.bak.md and warns,
//     naming both. So "local wins" is loud and lossless — the operator can diff
//     and re-apply. A local edit reaches Flair on the next onboard/align, not
//     before, and bob says so.
//
// Ordering: every push takes a FlairRegistration (see flair-pair.ts). Onboard
// registers the agent first; align verifies it first. Soul writes use the
// operator's credential, while the divergence read uses the agent's key.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FlairHttpClient } from "../capabilities/flair/client.js";
import {
  adminPassPath,
  assertOperatorAuthTarget,
  type FlairRegistration,
  flairOperatorBasicAuth,
} from "./flair-pair.js";

// Soul keys bob owns. Anything else in an agent's soul (set by hand, by
// `flair soul set`, or promoted from a memory candidate) is left alone —
// bob overwrites these three and nothing more.
export const SOUL_KEY_PERSONA = "persona";
export const SOUL_KEY_NAME = "name";
export const SOUL_KEY_ROLE = "role";

// Written beside soul.md when Flair's persona differs from the local file.
export const SOUL_DIVERGENCE_BACKUP = "soul.flair.bak.md";

export interface SoulEntryResult {
  key: string;
  id: string;
}

export interface SoulPushResult {
  agentId: string;
  entries: SoulEntryResult[];
  // True when Flair already held a persona that differed from the local file.
  diverged: boolean;
  // Where the superseded Flair copy was saved. Set only when diverged.
  backupPath?: string;
}

export interface PushSoulOptions {
  // Absolute path to the agent's soul.md. Its full contents become the
  // `persona` entry.
  soulPath: string;
  // Display name for the `name` entry (e.g. "Pulse"). Omitted → not written.
  displayName?: string;
  // Role for the `role` entry (e.g. "ea"). Omitted → not written.
  role?: string;
  // Path to the agent's Ed25519 private key, used for the divergence read.
  keyFile: string;
  // Operator credential file for Soul writes. Defaults to ~/.flair/admin-pass.
  adminPassFile?: string;
  // Harper's Basic admin username. Defaults to the same "admin" used for registration.
  adminUser?: string;
  // Seams (tests).
  fetchImpl?: ConstructorParameters<typeof FlairHttpClient>[0]["fetchImpl"];
  now?: () => number;
  uuid?: () => string;
  readFile?: (path: string) => Buffer;
  writeFile?: (path: string, contents: string) => void;
  // Where warnings go. Defaults to console.error.
  warn?: (message: string) => void;
}

// Push the local persona into the agent's Flair soul.
//
// Takes the registration token first, positionally, so the ordering
// dependency reads at every call site.
export async function pushSoulToFlair(
  registration: FlairRegistration,
  opts: PushSoulOptions,
): Promise<SoulPushResult> {
  assertOperatorAuthTarget(registration.flairUrl, registration.agentId);
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p));
  const writeFile =
    opts.writeFile ?? ((p: string, contents: string) => writeFileSync(p, contents, "utf8"));
  const warn = opts.warn ?? ((m: string) => console.error(m));

  const persona = readFile(opts.soulPath).toString("utf8");
  if (persona.trim() === "") {
    throw new Error(
      `refusing to write an empty soul for '${registration.agentId}': ${opts.soulPath} is empty. ` +
        `Flair's soul is what every session of this identity starts from — an empty entry would ` +
        `overwrite a good persona with nothing.`,
    );
  }

  const client = new FlairHttpClient({
    url: registration.flairUrl,
    agentId: registration.agentId,
    keyFile: opts.keyFile,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
    uuid: opts.uuid,
    readFile: opts.readFile,
  });

  // Read before write — this is the whole divergence check. A read failure is
  // NOT swallowed: if bob cannot tell whether it is about to overwrite
  // something, it must not claim it checked.
  const existing = await client.soulGet(SOUL_KEY_PERSONA);
  let diverged = false;
  let backupPath: string | undefined;
  if (existing && existing.value !== persona) {
    diverged = true;
    backupPath = join(dirname(opts.soulPath), SOUL_DIVERGENCE_BACKUP);
    writeFile(backupPath, existing.value);
    warn(
      [
        `⚠ soul divergence for '${registration.agentId}': the persona in Flair differs from ${opts.soulPath}.`,
        `  Bob mirrors local → Flair, so the local file wins and Flair is being overwritten.`,
        `  The superseded Flair copy was saved to ${backupPath} — diff it before discarding.`,
      ].join("\n"),
    );
  }

  // Read only in this local provisioning call, after the divergence check.
  // Never put the credential in an agent session, config, environment or log.
  const adminPassFile = adminPassPath(opts.adminPassFile);
  let adminPass: string;
  try {
    adminPass = readFileSync(adminPassFile, "utf8").trim();
  } catch {
    throw new Error(
      `cannot write Flair soul for '${registration.agentId}': operator password file ${adminPassFile} could not be read. ` +
        `Run 'flair init' or provide --admin-pass-file <path> to a readable admin-pass file (mode 0600), then re-run onboard/align.`,
    );
  }
  if (!adminPass) {
    throw new Error(
      `cannot write Flair soul for '${registration.agentId}': operator password file ${adminPassFile} is empty. ` +
        `Run 'flair init' or provide --admin-pass-file <path> to a nonempty admin-pass file (mode 0600), then re-run onboard/align.`,
    );
  }
  const authorization = flairOperatorBasicAuth(adminPass, opts.adminUser);
  const doFetch =
    opts.fetchImpl ??
    ((
      u: string,
      i: { method: string; headers: Record<string, string>; body?: string; redirect?: "error" },
    ) => fetch(u, i));
  const base = registration.flairUrl.replace(/\/+$/, "");
  const soulSet = async (key: string, value: string): Promise<string> => {
    const id = `${registration.agentId}:${key}`;
    const res = await doFetch(`${base}/Soul/${encodeURIComponent(id)}`, {
      method: "PUT",
      redirect: "error",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        agentId: registration.agentId,
        key,
        value,
        durability: "permanent",
        createdAt: new Date((opts.now ?? Date.now)()).toISOString(),
      }),
    });
    if (!res.ok) {
      // The server's response could echo a header. Never print it or the secret.
      throw new Error(
        `flair Soul PUT ${id} -> ${res.status}: operator write failed; check ${adminPassFile} and the target Flair instance.`,
      );
    }
    return id;
  };

  const entries: SoulEntryResult[] = [];
  // Identity keys first, persona last: if the run dies partway, the cheap
  // facts that make an agent findable (name, role) are already in place.
  if (opts.displayName) {
    entries.push({
      key: SOUL_KEY_NAME,
      id: await soulSet(SOUL_KEY_NAME, opts.displayName),
    });
  }
  if (opts.role) {
    entries.push({ key: SOUL_KEY_ROLE, id: await soulSet(SOUL_KEY_ROLE, opts.role) });
  }
  entries.push({
    key: SOUL_KEY_PERSONA,
    id: await soulSet(SOUL_KEY_PERSONA, persona),
  });

  return { agentId: registration.agentId, entries, diverged, backupPath };
}

// Read the persona Flair currently holds. Exposed for `bob doctor`-style
// callers and tests; the push path uses the client directly.
export async function readFlairSoul(
  registration: FlairRegistration,
  opts: Pick<PushSoulOptions, "keyFile" | "fetchImpl" | "now" | "uuid" | "readFile">,
): Promise<string | null> {
  const client = new FlairHttpClient({
    url: registration.flairUrl,
    agentId: registration.agentId,
    keyFile: opts.keyFile,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
    uuid: opts.uuid,
    readFile: opts.readFile,
  });
  const entry = await client.soulGet(SOUL_KEY_PERSONA);
  return entry?.value ?? null;
}

// Resolve the soul.md path for an agent dir, asserting it exists. Small, but
// it keeps the "soul.md is the authoring surface" convention in one place.
export function soulPathFor(agentDir: string): string {
  const path = join(agentDir, "soul.md");
  if (!existsSync(path)) {
    throw new Error(`no soul.md at ${path} — run 'bob onboard' first`);
  }
  return path;
}
