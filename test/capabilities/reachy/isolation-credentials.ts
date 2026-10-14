// bob#356: the credential files the key-read proof checks are DERIVED from bob's
// own resolution of the agent — the same configuration a session treats as
// credentials — plus the Flair admin password at bob's own default path
// (`adminPassPath`). The release host names the agent; the account is the one
// the root-owned deployment record names (checked by releaseRoots), and no
// caller can substitute a file of its choosing.
//
// Provenance is kept: the files the agent's bob.yaml CONFIGURES come from
// `collectConfiguredCredentials` (one entry per configured value), and pi's
// provider stores are added apart. A configured key is required to exist even
// when its path is the same as a provider store's — it is never reclassified
// as an optional store because of where it points. A configured key given as
// a RELATIVE path is refused outright: the capability opens it against its
// process cwd, which the proof cannot know, so no candidate may stand in for it.
// A credential path that exists must be a REGULAR file (after symlinks): a
// directory, socket or device in its place is reported, never counted.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  collectConfiguredCredentials,
  PROVIDER_LOGIN_STORE,
  PROVIDER_MODELS_STORE,
} from "../../../src/shell/confined-read.js";
import { adminPassPath } from "../../../src/shell/flair-pair.js";
import { resolveRunConfig } from "../../../src/shell/run.js";

export interface ActiveCredentials {
  /** Every credential path bob derived for the agent (configured, stores, admin pass). */
  derived: string[];
  /** The ones that exist on disk (relative readings excluded) — each must be a
   *  regular file, 0600, agent-owned, and denied. */
  present: string[];
  /** Present credential paths that are NOT regular files: the proof fails on any. */
  notFiles: string[];
  /** The configured key or token files that exist as regular files. */
  agentKeys: string[];
  /** Configured key or token files with NO existing candidate path: the proof
   *  fails on any. Only the provider stores may be absent. */
  missingKeys: string[];
  /** Configured key or token fields given as RELATIVE paths: the proof fails on
   *  any (write the absolute path); neither reading is a key or `present`. */
  relativeKeys: string[];
  /** bob's admin-password path for this user. */
  adminPass: string;
}

export function deriveActiveCredentials(opts: {
  name: string;
  agentsRoot: string;
  adminPass?: string;
}): ActiveCredentials {
  const resolved = resolveRunConfig({ name: opts.name, agentsRoot: opts.agentsRoot });
  const { agentDir, capabilities } = resolved;
  const configured = collectConfiguredCredentials({
    yamlText: readFileSync(join(agentDir, "bob.yaml"), "utf8"),
    capabilities,
    piAgentDir: join(agentDir, ".pi-agent"),
    workspaceRoot: join(agentDir, "work"),
  });
  if (!configured.ok) {
    throw new Error(`bob could not derive ${opts.name}'s credential paths: ${configured.reason}`);
  }
  const stores = [
    join(agentDir, ".pi-agent", PROVIDER_LOGIN_STORE),
    join(agentDir, ".pi-agent", PROVIDER_MODELS_STORE),
  ];
  const adminPass = opts.adminPass ?? adminPassPath();
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const agentKeys: string[] = [];
  const missingKeys: string[] = [];
  const relativeKeys: string[] = [];
  for (const entry of configured.entries) {
    if (entry.relative) {
      relativeKeys.push(entry.field);
      continue;
    }
    const existing = entry.candidates.filter((p) => existsSync(p));
    if (existing.length > 0) agentKeys.push(...existing.filter(isFile));
    else missingKeys.push(...entry.candidates);
  }
  const absolute = configured.entries.filter((e) => !e.relative).flatMap((e) => e.candidates);
  const derived = [
    ...new Set([...configured.entries.flatMap((e) => e.candidates), ...stores, adminPass]),
  ];
  const present = [...new Set([...absolute, ...stores, adminPass])].filter((p) => existsSync(p));
  const notFiles = present.filter((p) => !isFile(p));
  return { derived, present, notFiles, agentKeys, missingKeys, relativeKeys, adminPass };
}
