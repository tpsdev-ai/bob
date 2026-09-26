// reachy/index.ts — the pi extension factory for the `reachy` capability.
//
// Thin adapter: read config (env) → build the socket client + the memory writer
// (over the flair capability client) → hand both to the testable core
// (wireReachyCapability). All policy + tests live in policy.ts / capability.ts.
//
// SECURITY: the capability holds no keys and reads no key files. It talks to the
// sidecar only through the socket; the sidecar runs as its own user and cannot
// read bob's keys or config.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FlairHttpClient } from "../flair/client.js";
import { loadConfigFromEnv as loadFlairConfig } from "../flair/config.js";
import { type PiLike, wireReachyCapability } from "./capability.js";
import { collectingEmitter, flairMemoryWriter, UnixSocketReachyClient } from "./client.js";
import { loadConfigFromEnv } from "./config.js";
import type { OrgEvent } from "./policy.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = loadConfigFromEnv();

  const commands = new UnixSocketReachyClient({ socket: config.socket });

  // The memory writer runs over the flair capability client (spec §3.4). Reach
  // reads flair's own resolved config; if it is unset the capability still
  // registers its tools but memory writes fail closed (the gate never opens).
  let memory: ReturnType<typeof flairMemoryWriter> | null = null;
  try {
    const flairConfig = loadFlairConfig();
    memory = flairMemoryWriter(new FlairHttpClient(flairConfig));
  } catch (err) {
    console.error(
      `reachy capability: no flair config — memory writes disabled (${err instanceof Error ? err.message : err})`,
    );
  }

  // S3 records OrgEvents locally; routing them to the observatory is a later
  // slice. The sink is a seam so tests collect the trail.
  const orgEvents: OrgEvent[] = [];
  const emit = collectingEmitter(orgEvents);

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
    memory: memory ?? {
      writePrivate: async () => {
        throw new Error("reachy: memory writes disabled (no flair config)");
      },
    },
    emit,
    state,
  });

  if (!config.mute) {
    try {
      await commands.connect();
      commands.onLine((line) => {
        void wired.handleEvent(line as never, line.type);
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
