// reachy/index.ts — the pi extension factory for the `reachy` capability.
//
// Thin adapter: read config (env) → build the socket client + the durable
// OrgEvent store + the memory writer (all over the flair capability client) →
// hand them to the testable core (wireReachyCapability). Inbound socket lines are
// decoded by wire.ts (one shape, schema-checked) before policy.
//
// SECURITY: the capability holds no key of its own, but its Flair client's
// signer reads the agent's key file to sign the audit and memory writes; it talks
// to the sidecar only through the socket. bob never launches the sidecar: it runs
// as its own OS user under a deny-default sandbox profile, started by the
// operator's launch job (sidecar/reachy-voice/RUNBOOK.md). bob only connects.
//
// bob#356 V1: every connection begins with the reachy-voice/1 handshake
// (capability.ts `connected`), and a dropped or refused connection is retried
// with a bounded backoff — each retry is a fresh handshake.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boundOrigin, getSessionOrigin, getTurnAdmission } from "../../shell/turn-admission.js";
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

  // The CALLER of `reachy_say` (bob#356): the origin the runtime binds a tool
  // call to, read from pi's per-loader event bus. In the persistent runtime
  // only an admitted turn binds one; in a one-shot `bob run` the runtime
  // declares `run` for the session; anywhere else nothing is bound and speech
  // refuses. A missing admission never passes as `run`.
  const admission = getTurnAdmission(pi);
  const sessionOrigin = getSessionOrigin(pi);

  const wired = wireReachyCapability({
    pi: pi as unknown as PiLike,
    commands,
    memory,
    store,
    state,
    sidecarVersion: config.sidecarVersion,
    readOrigin: () =>
      boundOrigin({
        ...(admission ? { admission } : {}),
        ...(sessionOrigin ? { sessionOrigin } : {}),
      }),
  });

  if (config.mute) {
    console.error("reachy capability: mute — events dropped, no sidecar connection");
    return;
  }

  commands.onLine((line) => {
    // Detached on purpose (lines are handled as they arrive), but never
    // unobserved: a rejected handler is caught and logged — no unhandled
    // rejection — and the run continues.
    void wired.handleLine(line).catch((err: unknown) => {
      console.error(`reachy: line handler failed: ${err instanceof Error ? err.message : err}`);
    });
  });

  const supervisor = superviseLink({ client: commands, wired });
  // The sidecar serves ONE connection at a time: when pi ends this session
  // (shutdown, reload, a replacement session), release it, and stop retrying,
  // so the next session's link can connect.
  pi.on("session_shutdown", () => {
    supervisor.stop();
    wired.disconnected();
    commands.close();
  });
  await supervisor.start();
}
