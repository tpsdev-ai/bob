// reachy/index.ts — the pi extension factory for the `reachy` capability.
//
// Thin adapter: read config (env) → build the socket client + the durable
// OrgEvent store + the memory writer (all over the flair capability client) →
// hand them to the testable core (wireReachyCapability). Inbound socket lines are
// decoded by wire.ts (one shape, schema-checked) before policy.
//
// SECURITY: the capability holds no keys and reads no key files; it talks to the
// sidecar only through the socket. The STUB sidecar is NOT run as its own user
// (S2) — the key-read proof runs the read PATH as a different OS user, but the
// stub itself is launched as the agent's own user.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FlairHttpClient } from "../flair/client.js";
import { loadConfigFromEnv as loadFlairConfig } from "../flair/config.js";
import {
  type MemoryWriter,
  type OrgEventStore,
  type PiLike,
  wireReachyCapability,
} from "./capability.js";
import { flairMemoryWriter, flairOrgEventStore, UnixSocketReachyClient } from "./client.js";
import { loadConfigFromEnv } from "./config.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = loadConfigFromEnv();
  const commands = new UnixSocketReachyClient({ socket: config.socket });

  // The durable audit + the memory both go over the flair capability client
  // (spec §3.4). If flair's config is unset the capability still registers its
  // tools, but memory writes AND their audit fail closed.
  let memory: MemoryWriter = {
    writePrivate: async () => {
      throw new Error("reachy: memory writes disabled (no flair config)");
    },
  };
  let store: OrgEventStore = {
    write: async () => {
      throw new Error("reachy: audit disabled (no flair config)");
    },
    getById: async () => null,
  };
  try {
    const client = new FlairHttpClient(loadFlairConfig());
    memory = flairMemoryWriter(client);
    store = flairOrgEventStore(client);
  } catch (err) {
    console.error(
      `reachy capability: no flair config — memory writes and audit disabled (${err instanceof Error ? err.message : err})`,
    );
  }

  const state = {
    wakeName: config.wakeName,
    enrolment: config.enrolledSpeakers,
    mute: config.mute,
    nowMs: () => Date.now(),
    lastAcknowledgeAtMs: undefined as number | undefined,
  };

  const wired = wireReachyCapability({
    pi: pi as unknown as PiLike,
    commands,
    memory,
    store,
    state,
  });

  if (!config.mute) {
    try {
      await commands.connect();
      commands.onLine((line) => {
        // Never fire-and-forget: a rejected handler would be an unhandled
        // rejection. Log it; the run continues.
        void wired.handleLine(line).catch((err: unknown) => {
          console.error(`reachy: line handler failed: ${err instanceof Error ? err.message : err}`);
        });
      });
    } catch (err) {
      console.error(
        `reachy capability: sidecar connect failed (tools still registered): ${err instanceof Error ? err.message : err}`,
      );
    }
  } else {
    console.error("reachy capability: mute — events dropped, no sidecar connection");
  }
}
