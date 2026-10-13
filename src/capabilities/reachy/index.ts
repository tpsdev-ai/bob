// reachy/index.ts — the pi extension factory for the `reachy` capability.
//
// Thin adapter: read config (env) → build the socket client + the durable
// OrgEvent store + the memory writer (all over the flair capability client) →
// hand them to the testable core (wireReachyCapability). Inbound socket lines are
// decoded by wire.ts (one shape, schema-checked) before policy.
//
// SECURITY: the capability holds no keys and reads no key files; it talks to the
// sidecar only through the socket. bob never launches the sidecar: it runs as its
// own OS user under a deny-default sandbox profile, started by the operator's
// launcher (sidecar/reachy-voice/RUNBOOK.md). bob only connects.
//
// bob#356 V1: every connection begins with the reachy-voice/1 handshake
// (capability.ts `connected`), and a dropped or refused connection is retried
// with a bounded backoff — each retry is a fresh handshake.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTurnAdmission } from "../../shell/turn-admission.js";
import { FlairHttpClient } from "../flair/client.js";
import { loadConfigFromEnv as loadFlairConfig } from "../flair/config.js";
import {
  type MemoryWriter,
  type OrgEventStore,
  type PiLike,
  wireReachyCapability,
} from "./capability.js";
import {
  flairMemoryWriter,
  flairOrgEventStore,
  superviseLink,
  UnixSocketReachyClient,
} from "./client.js";
import { loadConfigFromEnv } from "./config.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = loadConfigFromEnv();
  const commands = new UnixSocketReachyClient({ socket: config.socket });

  // The durable audit + the memory both go over the flair capability client
  // (spec §3.4). If flair's config is unset the capability still registers its
  // tools, but memory writes AND their audit fail closed — and since speech is
  // sent only after a successful audit, so does every action.
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
    profile: config.profile,
    wakeName: config.wakeName,
    enrolment: config.enrolledSpeakers,
    mute: config.mute,
    roomSpeechOrigins: config.roomSpeechOrigins,
    nowMs: () => Date.now(),
    lastAcknowledgeAtMs: undefined as number | undefined,
  };

  // The runtime-owned turn admission, read from pi's per-loader event bus. Its
  // `readOrigin` names the admitted turn a tool call runs inside — the CALLER
  // of `reachy_say`. Absent in a one-shot `bob run` (an operator's run).
  const admission = getTurnAdmission(pi);

  const wired = wireReachyCapability({
    pi: pi as unknown as PiLike,
    commands,
    memory,
    store,
    state,
    sidecarVersion: config.sidecarVersion,
    ...(admission ? { readOrigin: () => admission.readOrigin() } : {}),
  });

  if (config.mute) {
    console.error("reachy capability: mute — events dropped, no sidecar connection");
    return;
  }

  commands.onLine((line) => {
    // Never fire-and-forget: a rejected handler would be an unhandled
    // rejection. Log it; the run continues.
    void wired.handleLine(line).catch((err: unknown) => {
      console.error(`reachy: line handler failed: ${err instanceof Error ? err.message : err}`);
    });
  });

  await superviseLink({ client: commands, wired }).start();
}
