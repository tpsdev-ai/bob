// Bob capability: presence — a pi extension.
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => Promise<void>`. pi loads this via jiti (no build) when
// Bob adds its path to the resource loader's extension sources. This file is the
// thin adapter: read config (env) → construct the real FlairHttpClient (the same
// one signed client the flair capability uses) → hand it + the resolved config to
// the testable core (wirePresence). All logic + every test lives in
// capability.ts / config.ts / ../shell/turn-origin.ts; this file only does the
// wiring the tests can't (real env + real FlairHttpClient).
//
// SECURITY: the agent's private key is read from a file path (config.keyFile)
// and lives only inside the FlairHttpClient. It is never logged, echoed,
// returned in a beat, placed in a turn summary, or put in the session
// transcript.
//
// GATE: presence "serves" (a persistent beacon + turn-end writes), so it only
// wires under BOB_PERSISTENT (the persistent runtime). A one-shot `bob run`
// stays outbound-only — same gate as discord's gateway (see discord/index.ts).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FlairHttpClient } from "../flair/client.js";
import { wirePresence } from "./capability.js";
import { loadConfigFromEnv } from "./config.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  // Presence only wires in the persistent runtime. Bob sets
  // BOB_PERSISTENT=1 there (createPiRunSession); a one-shot run leaves it
  // unset, so this is a silent no-op — no beacon, no turn summary — exactly
  // as the design's "one-shot runs stay outbound-only" requires.
  if (process.env.BOB_PERSISTENT !== "1") return;

  const config = loadConfigFromEnv();
  const flair = new FlairHttpClient({
    url: config.url,
    agentId: config.agentId,
    keyFile: config.keyFile,
  });

  // The real ExtensionAPI satisfies the structural PresencePiLike the core
  // needs. wirePresence wires the four subscriptions + the beacon.
  wirePresence({
    pi: pi as unknown as Parameters<typeof wirePresence>[0]["pi"],
    flair,
    config,
  });
}

export {
  type BeaconHandle,
  type BeaconScheduler,
  type BuildTurnSummaryArgs,
  buildTurnSummary,
  DEFAULT_BEACON_INTERVAL_MS,
  DEFAULT_CURRENT_TASK_MAX,
  DEFAULT_SUMMARY_DURABILITY,
  DEFAULT_SUMMARY_MAX_CHARS,
  type PresenceFlairClient,
  type PresenceHandle,
  type PresenceMessage,
  type PresencePiLike,
  SUMMARY_MAX_RETRIES,
  SUMMARY_RETRY_DELAY_MS,
  type WirePresenceOptions,
  wirePresence,
} from "./capability.js";
export {
  CONFIG_ENV_VAR,
  CONFIG_SCHEMA,
  loadConfigFromEnv,
  type PresenceActivity,
  type PresenceCapabilityConfig,
} from "./config.js";
export { presenceManifest } from "./manifest.js";
