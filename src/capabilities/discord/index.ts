// Bob capability: discord — a pi extension.
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => Promise<void>`. pi loads this via jiti (no build) when
// Bob adds its path to the resource loader's extension sources. The async
// factory opens the gateway before startup completes (pi awaits the promise),
// so the inbound listener and the registered tools are live for a persistent
// session.
//
// This file is the thin adapter: read config (env) → read token (file) →
// construct the real DiscordJsClient → hand both to the testable core
// (wireDiscordCapability). All logic + every test lives in capability.ts; this
// file only does the wiring the tests can't (real env + real discord.js).
//
// SECURITY: the token is read from a file path (config.tokenFile) and lives
// only inside the DiscordJsClient. It is never logged, echoed, returned in a
// tool result, or placed in the session transcript.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireDiscordCapability } from "./capability.js";
import { loadConfigFromEnv, readToken } from "./config.js";
import { DiscordJsClient } from "./discord-js-client.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = loadConfigFromEnv();
  const token = readToken(config.tokenFile);

  const client = new DiscordJsClient({ token, botUserId: config.botUserId });

  // The real ExtensionAPI satisfies the structural PiLike the core needs.
  // wireDiscordCapability registers the tools + listener SYNCHRONOUSLY before
  // returning, so the outbound tools surface even if the gateway is briefly
  // unreachable.
  const wired = wireDiscordCapability({
    pi: pi as unknown as Parameters<typeof wireDiscordCapability>[0]["pi"],
    client,
    config,
  });

  // Open the gateway (inbound listener) ONLY in the persistent runtime. A
  // one-shot `bob run` keeps run minimal: it gets the outbound REST tools (which
  // need no login) but opens no gateway — so it never duplicates the persistent
  // session's bot login (the second-connection conflict) or pays the connect
  // cost for a task that never receives a message. Bob sets BOB_PERSISTENT=1 in
  // the persistent runtime (createPiRunSession); it's unset for `bob run`.
  if (process.env.BOB_PERSISTENT === "1") {
    // A connect failure is logged but NOT fatal: the session + outbound tools
    // still come up. The error never includes the token (it lives only inside
    // the client; login errors name only the cause).
    try {
      await wired.start();
    } catch (err) {
      const reason = err instanceof Error ? err.message : "gateway connect failed";
      console.error(`discord capability: gateway connect failed (continuing): ${reason}`);
    }
  } else {
    console.error("discord capability: run mode — outbound REST tools only, gateway not opened");
  }
}

export { type WiredCapability, wireDiscordCapability } from "./capability.js";
// Re-export the manifest + config surface so a consumer (Bob's catalog, doctor)
// can import everything from the package root.
export { CONFIG_ENV_VAR, CONFIG_SCHEMA, type DiscordCapabilityConfig } from "./config.js";
export { discordManifest } from "./manifest.js";
