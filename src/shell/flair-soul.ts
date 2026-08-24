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
//   * Why not pull on launch. The launcher is a POSIX sh script whose whole
//     job is `pi --append-system-prompt "$(cat soul.md)"`. Fetching the soul
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
// Ordering: every function here takes a FlairRegistration (see flair-pair.ts).
// That is not decoration. Flair's Soul.put() attributes the row to the SIGNING
// identity and rejects a body whose agentId does not match, so an unregistered
// agent's soul write is refused as unknown_agent. Requiring the token makes the
// dependency structural — a soul write cannot be spelled without a completed
// registration in front of it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FlairHttpClient } from "../capabilities/flair/client.js";
import type { FlairRegistration } from "./flair-pair.js";

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
  // Path to the agent's Ed25519 private key — the soul write is signed AS the
  // agent, so this is the agent's own key, never an admin credential.
  keyFile: string;
  // Seams (tests).
  fetchImpl?: ConstructorParameters<typeof FlairHttpClient>[0]["fetchImpl"];
  now?: () => number;
  uuid?: () => string;
  readFile?: (path: string) => string;
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
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile =
    opts.writeFile ?? ((p: string, contents: string) => writeFileSync(p, contents, "utf8"));
  const warn = opts.warn ?? ((m: string) => console.error(m));

  const persona = readFile(opts.soulPath);
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

  const entries: SoulEntryResult[] = [];
  // Identity keys first, persona last: if the run dies partway, the cheap
  // facts that make an agent findable (name, role) are already in place.
  if (opts.displayName) {
    entries.push({
      key: SOUL_KEY_NAME,
      id: (await client.soulSet(SOUL_KEY_NAME, opts.displayName)).id,
    });
  }
  if (opts.role) {
    entries.push({ key: SOUL_KEY_ROLE, id: (await client.soulSet(SOUL_KEY_ROLE, opts.role)).id });
  }
  entries.push({
    key: SOUL_KEY_PERSONA,
    id: (await client.soulSet(SOUL_KEY_PERSONA, persona)).id,
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
