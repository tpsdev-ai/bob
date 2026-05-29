// Bob capability: flair (memory) — a pi extension.
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => Promise<void>`. pi loads this via jiti (no build) when
// Bob adds its path to the resource loader's extension sources. This file is the
// thin adapter: read config (env) → construct the FlairHttpClient (which reads
// the agent's key from the configured FILE PATH) → hand both to the testable
// core (wireFlairCapability). All logic + tests live in capability.ts/client.ts.
//
// SECURITY: the agent's private key is read from a file path (config.keyFile)
// and lives only inside the FlairHttpClient. It is never logged, echoed,
// returned in a tool result, or placed in the session transcript.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { wireFlairCapability } from "./capability.js";
import { FlairHttpClient } from "./client.js";
import { loadConfigFromEnv } from "./config.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = loadConfigFromEnv();
  const client = new FlairHttpClient({
    url: config.url,
    agentId: config.agentId,
    keyFile: config.keyFile,
  });
  // The real ExtensionAPI satisfies the structural PiLike the core needs.
  // wireFlairCapability registers the tools synchronously — no gateway to open,
  // so (unlike cap-discord) there's nothing to await/connect.
  wireFlairCapability({
    pi: pi as unknown as Parameters<typeof wireFlairCapability>[0]["pi"],
    client,
  });
}

export { wireFlairCapability, type PiLike, type WireOptions } from "./capability.js";
export {
  FlairHttpClient,
  type FlairClient,
  type FlairSearchHit,
  type FlairMemory,
  type Durability,
} from "./client.js";
export {
  CONFIG_ENV_VAR,
  CONFIG_SCHEMA,
  type FlairCapabilityConfig,
  loadConfigFromEnv,
} from "./config.js";
export { flairManifest } from "./manifest.js";
