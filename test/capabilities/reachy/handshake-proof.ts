// Refs #360 — the release-host handshake proof helper. As bob's own account,
// open the socket the agent's `bob.yaml` names (`reachy.socket`), send the
// `reachy-voice/1` `configure`, and read the strict health line back; it
// PASSES only when that line reports the configured `sidecarVersion`, within a
// fixed time limit. Every wait is bounded, and each failure carries a NAMED
// reason:
//
//   no-listener        nothing accepted the connect (a refused connect or a
//                      missing path — Bun reports a refused UNIX-socket connect
//                      as ENOENT where Node reports ECONNREFUSED, so the
//                      reasons are classified by BEHAVIOUR, never by errno);
//   busy               the listener is already serving its one connection, so a
//                      further connect is refused (the sidecar serves ONE
//                      connection at a time: `server.listen(1)` + `accept()`);
//   handshake-timeout  a listener accepted but did not answer within the limit;
//   version-mismatch   a health line arrived naming another version.
//
// The `busy` probe keys on the sidecar's single-session design: while it serves
// a client it is not calling `accept()`, so a second connect is refused rather
// than answered. That is why the proof requires bob's reachy capability —
// which holds that one connection — to be STOPPED while it runs.

import { createConnection } from "node:net";
import { UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import type { ReachyProfile } from "../../../src/capabilities/reachy/config.js";
import {
  configureArgs,
  decodeLine,
  type SidecarHealth,
} from "../../../src/capabilities/reachy/wire.js";

/** The fixed limit on a completed handshake (the configure write plus its
 *  health line). */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3_000;
/** The bound on one connect attempt. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 1_500;

export type HandshakeFailure = "no-listener" | "busy" | "handshake-timeout" | "version-mismatch";

export interface HandshakeProof {
  ok: boolean;
  reason?: HandshakeFailure;
  /** The version the sidecar reported, when a health line arrived. */
  version?: string;
  detail?: string;
}

export interface HandshakeProofOptions {
  /** The fixed handshake limit (default DEFAULT_HANDSHAKE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** The bound on each connect (default DEFAULT_CONNECT_TIMEOUT_MS). */
  connectMs?: number;
  profile?: ReachyProfile;
  wakeName?: string;
  generation?: number;
}

const CLOSED = Symbol("closed");
const TIMED_OUT = Symbol("timed-out");

/** Connect bob's real client within `ms`; "refused" is any connect failure
 *  (including a connect that never completes — both mean nothing accepted us). */
async function connectClient(
  client: UnixSocketReachyClient,
  ms: number,
): Promise<"ok" | "refused" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const attempt = client.connect().then(
    () => "ok" as const,
    () => "refused" as const,
  );
  const result = await Promise.race([attempt, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

type RawConnect = { kind: "refused" } | { kind: "timeout" } | { kind: "open"; close: () => void };

/** A bare connect, used only to see whether a SECOND connection is accepted. */
function connectRaw(socket: string, ms: number): Promise<RawConnect> {
  return new Promise((resolve) => {
    const sock = createConnection(socket);
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: RawConnect): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      sock.destroy();
      finish({ kind: "timeout" });
    }, ms);
    sock.once("connect", () => finish({ kind: "open", close: () => sock.destroy() }));
    sock.once("error", () => {
      sock.destroy();
      finish({ kind: "refused" });
    });
  });
}

/**
 * Complete the `reachy-voice/1` handshake with the listener on `socket` and
 * check its version against `expectedVersion`. Never throws and never hangs:
 * every wait is bounded, and the result names the failure.
 */
export async function probeVoiceHandshake(
  socket: string,
  expectedVersion: string,
  opts: HandshakeProofOptions = {},
): Promise<HandshakeProof> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const connectMs = opts.connectMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const client = new UnixSocketReachyClient({ socket });
  let deliverHealth: (health: SidecarHealth) => void = () => {};
  const health = new Promise<SidecarHealth>((resolve) => {
    deliverHealth = resolve;
  });
  let deliverClosed: () => void = () => {};
  const closed = new Promise<typeof CLOSED>((resolve) => {
    deliverClosed = () => resolve(CLOSED);
  });
  client.onLine((line) => {
    const decoded = decodeLine(line);
    if (decoded.kind === "health") deliverHealth(decoded.health);
  });
  client.onClose(deliverClosed);

  const opened = await connectClient(client, connectMs);
  if (opened !== "ok") {
    client.disconnect();
    return {
      ok: false,
      reason: "no-listener",
      detail: `no listener on ${socket} (the connect was ${opened === "refused" ? "refused" : "not completed"})`,
    };
  }

  try {
    await client.send(
      "configure",
      configureArgs({
        version: expectedVersion,
        profile: opts.profile ?? "voice",
        wakeName: opts.wakeName ?? "jarvis",
        generation: opts.generation ?? 1,
      }),
    );
  } catch {
    client.disconnect();
    return {
      ok: false,
      reason: "handshake-timeout",
      detail: `the configure write on ${socket} did not complete`,
    };
  }

  const result = await Promise.race([
    health,
    closed,
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
  ]);

  if (result !== CLOSED && result !== TIMED_OUT) {
    client.disconnect();
    if (result.version === expectedVersion) return { ok: true, version: result.version };
    return {
      ok: false,
      reason: "version-mismatch",
      version: result.version,
      detail: `the sidecar on ${socket} reports version ${result.version}, not the configured ${expectedVersion}`,
    };
  }
  if (result === CLOSED) {
    client.disconnect();
    return {
      ok: false,
      reason: "handshake-timeout",
      detail: `the sidecar on ${socket} closed the connection before its health line`,
    };
  }

  // No health line within the limit. A listener already serving its one
  // connection refuses a further connect; a listener that accepted and never
  // answered accepts it. That is the only observable distinguishing them.
  const canary = await connectRaw(socket, connectMs);
  client.disconnect();
  if (canary.kind === "open") {
    canary.close();
    return {
      ok: false,
      reason: "handshake-timeout",
      detail: `no reachy-voice/1 health line on ${socket} within ${timeoutMs} ms`,
    };
  }
  return {
    ok: false,
    reason: "busy",
    detail: `${socket} is already serving a connection (a further connect was ${canary.kind === "refused" ? "refused" : "not accepted"}); stop bob's reachy capability before this proof runs`,
  };
}
