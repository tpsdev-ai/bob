// bob#356 round 1: the credential files the key-read proof checks are DERIVED
// from bob's own resolution of the agent — the same paths a session treats as
// credentials (`resolveRunConfig` → `collectCredentialPaths`: the provider
// stores and every key or token file the parsed config names) plus the Flair
// admin password at bob's own default path (`adminPassPath`). The release host
// names only the AGENT; no caller can substitute a file of its choosing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_LOGIN_STORE, PROVIDER_MODELS_STORE } from "../../../src/shell/confined-read.js";
import { adminPassPath } from "../../../src/shell/flair-pair.js";
import { resolveRunConfig } from "../../../src/shell/run.js";

export interface ActiveCredentials {
  /** Every credential path bob derived for the agent. */
  derived: string[];
  /** The ones that exist on disk — each must be 0600, agent-owned, denied. */
  present: string[];
  /** The agent's own key or token files present (not the provider stores). */
  agentKeys: string[];
  /** bob's admin-password path for this user. */
  adminPass: string;
}

export function deriveActiveCredentials(opts: {
  name: string;
  agentsRoot: string;
  adminPass?: string;
}): ActiveCredentials {
  const { agentDir, config } = resolveRunConfig({ name: opts.name, agentsRoot: opts.agentsRoot });
  if (!config.credentialPaths) {
    throw new Error(
      `bob could not derive ${opts.name}'s credential paths: ${config.credentialPathsUnavailable ?? "unknown"}`,
    );
  }
  const stores = new Set([
    join(agentDir, ".pi-agent", PROVIDER_LOGIN_STORE),
    join(agentDir, ".pi-agent", PROVIDER_MODELS_STORE),
  ]);
  const adminPass = opts.adminPass ?? adminPassPath();
  const derived = [...config.credentialPaths, adminPass];
  const present = derived.filter((p) => existsSync(p));
  const agentKeys = config.credentialPaths.filter((p) => !stores.has(p) && existsSync(p));
  return { derived, present, agentKeys, adminPass };
}
