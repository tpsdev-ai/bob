// Bob capability: observatory (team-view producer) — a pi extension.
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => Promise<void>`. pi loads this via jiti (no build) when
// Bob adds its path to the resource loader's extension sources. This file is the
// thin adapter: read config (env) → construct the ObservatoryHttpClient (which
// reads the OFFICE key from the configured FILE PATH) + the reader (fs seam) →
// hand both to the testable core (wireObservatoryCapability). All logic + tests
// live in capability.ts / client.ts / snapshot.ts / sanitize.ts / reader.ts.
//
// SECURITY: the OFFICE private key is read from a file path (config.officeKeyFile)
// and lives only inside the ObservatoryHttpClient. It is never logged, echoed,
// returned in a tool result, or placed in the session transcript. This is the
// OFFICE key (verified against ObsOffice.publicKey), NOT an agent's Flair key.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { wireObservatoryCapability } from "./capability.js";
import { ObservatoryHttpClient } from "./client.js";
import { loadConfigFromEnv } from "./config.js";
import { readSignals } from "./reader.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = loadConfigFromEnv();
  const client = new ObservatoryHttpClient({
    url: config.observatoryUrl,
    officeId: config.officeId,
    officeKeyFile: config.officeKeyFile,
  });
  // The real ExtensionAPI satisfies the structural PiLike the core needs.
  // wireObservatoryCapability registers the tool synchronously — no gateway to
  // open (serves:false), so (unlike cap-discord) there's nothing to await/connect.
  wireObservatoryCapability({
    pi: pi as unknown as Parameters<typeof wireObservatoryCapability>[0]["pi"],
    client,
    readSignals: () => readSignals(config),
    staleThresholdSeconds: config.staleThresholdSeconds,
  });
}

export {
  type PiLike,
  type WireOptions,
  wireObservatoryCapability,
} from "./capability.js";
export {
  type IngestBatch,
  type IngestResult,
  type ObservatoryClient,
  ObservatoryHttpClient,
  type ObservatoryHttpClientOptions,
} from "./client.js";
export {
  CONFIG_ENV_VAR,
  CONFIG_SCHEMA,
  loadConfigFromEnv,
  type ObservatoryCapabilityConfig,
  type SnapshotSource,
} from "./config.js";
export { observatoryManifest } from "./manifest.js";
export {
  extractBeadsSummary,
  extractEvents,
  type ReaderDeps,
  readSignal,
  readSignals,
} from "./reader.js";
export {
  REDACTED,
  sanitize,
  sanitizeAgent,
  sanitizeEvent,
  sanitizeString,
} from "./sanitize.js";
export {
  type AgentEventInput,
  type AgentLiveStatus,
  type AgentSignal,
  type AgentStatus,
  type BuildOptions,
  buildAgentStatus,
  buildBatch,
  buildEvents,
  deriveStatus,
  type OrgEventRecord,
} from "./snapshot.js";
