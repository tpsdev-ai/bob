// Bob capability: tps-mail — a pi extension (bob#200).
//
// Like every Bob capability this is a pi extension, loaded through the blessed
// catalog. Its only job IN a session is to refuse to load on a bad config
// block (a missing or empty `senders:` allow-list above all): pi records the
// throw, and bob's assertCapabilitiesLoaded fails the session naming the
// capability. It registers no tools and never touches the session.
//
// The inbox consumer is NOT started here. The persistent runtime (`bob run
// <name>`, src/shell/persistent.ts) runs it, because it owns the agent's
// identity, its launcher and its lifecycle; the consumer answers each mail with
// ONE turn in a FRESH session through the launcher, so mail never enters the
// warm session and nothing here needs a session at all.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfigFromEnv } from "./config.js";

export default function (_pi: ExtensionAPI): void {
  const config = loadConfigFromEnv();
  if (process.env.BOB_PERSISTENT === "1") {
    console.error(
      `tps-mail capability: config valid (${config.senders.length} allow-listed sender(s)); the persistent runtime runs the inbox consumer`,
    );
  }
}

export {
  CONFIG_ENV_VAR,
  CONFIG_SCHEMA,
  TPS_MAIL_CAPABILITY,
  type TpsMailCapabilityConfig,
} from "./config.js";
export { tpsMailManifest } from "./manifest.js";
