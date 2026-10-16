// Refs #360 — the release-host handshake proof helper. As bob's own account,
// open the socket the agent's `bob.yaml` names (`reachy.socket`), send the
// `reachy-voice/1` `configure`, and read the health line back. The proof PASSES
// only when that line passes bob's OWN handshake rules — the shared `checkHealth`
// (version, profile, wake name, generation, `ok`, and the trained-artifact pair)
// applied to the FIRST line, exactly as the capability judges a live link. Every
// wait is bounded, and each failure carries a NAMED reason:
//
//   no-listener         nothing accepted the connect (a refused connect or a
//                       missing path — Bun reports a refused UNIX-socket connect
//                       as ENOENT where Node reports ECONNREFUSED, so the
//                       reasons are classified by BEHAVIOUR, never by errno);
//   handshake-timeout   no line arrived within the handshake limit (the connect
//                       was accepted but the sidecar answered nothing, or it
//                       dropped the connection);
//   handshake-rejected  a line arrived that bob's rules refuse — a first line
//                       that is not a `reachy-voice/1` health line, or a health
//                       line whose fields do not match (`detail` names them).
//
// The limit is ONE budget covering the `configure` write plus its health reply.
// The probe reports what a connect and the wire show; it does not diagnose WHY a
// listener answered nothing. The sidecar serves one connection at a time, so a
// link bob's reachy capability still holds consumes the answer — stop that
// capability before this proof runs.

import { UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import {
  checkHealth,
  configureArgs,
  type DecodedLine,
  decodeLine,
  type HandshakeExpectation,
} from "../../../src/capabilities/reachy/wire.js";

/** The one budget a completed handshake gets: the `configure` write plus its
 *  health reply. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3_000;
/** The bound on one connect attempt. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 1_500;

export type HandshakeFailure = "no-listener" | "handshake-timeout" | "handshake-rejected";

export interface HandshakeProof {
  ok: boolean;
  reason?: HandshakeFailure;
  /** The version the sidecar reported, when a health line arrived. */
  version?: string;
  detail?: string;
}

export interface HandshakeProofOptions {
  /** The one budget for the `configure` write plus its health reply (default
   *  DEFAULT_HANDSHAKE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** The bound on each connect (default DEFAULT_CONNECT_TIMEOUT_MS). */
  connectMs?: number;
}

const CLOSED = Symbol("closed");
const TIMED_OUT = Symbol("timed-out");

/** Connect bob's real client within `ms`. Returns "refused" when the connect
 *  fails and "timeout" when it does not complete within `ms`; the probe maps
 *  both outcomes to `no-listener`. */
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

/**
 * Complete the `reachy-voice/1` handshake with the listener on `socket` and
 * judge its reply by bob's own rules (`expect`). Never throws and never hangs:
 * every wait is bounded, and the result names the failure.
 */
export async function probeVoiceHandshake(
  socket: string,
  expect: HandshakeExpectation,
  opts: HandshakeProofOptions = {},
): Promise<HandshakeProof> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const connectMs = opts.connectMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const client = new UnixSocketReachyClient({ socket });
  // The FIRST line decides the handshake, as the capability's `handleLine` does
  // while handshaking: a health line is judged by `checkHealth`, anything else
  // is refused.
  let deliverLine: (line: DecodedLine) => void = () => {};
  const firstLine = new Promise<DecodedLine>((resolve) => {
    let seen = false;
    deliverLine = (line) => {
      if (seen) return;
      seen = true;
      resolve(line);
    };
  });
  client.onLine((line) => deliverLine(decodeLine(line)));
  let deliverClosed: () => void = () => {};
  const closed = new Promise<typeof CLOSED>((resolve) => {
    deliverClosed = () => resolve(CLOSED);
  });
  client.onClose(deliverClosed);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const opened = await connectClient(client, connectMs);
    if (opened !== "ok") {
      return {
        ok: false,
        reason: "no-listener",
        detail: `no listener on ${socket} accepted the connect (it was ${opened === "refused" ? "refused" : "not completed"}); a sidecar busy with another session can also refuse it, so stop bob's reachy capability before this proof`,
      };
    }

    // ONE deadline for the whole handshake. Both waits race the same timer, so
    // the total is bounded by `timeoutMs`, never by twice it.
    let deliverTimeout: () => void = () => {};
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      deliverTimeout = () => resolve(TIMED_OUT);
    });
    timer = setTimeout(deliverTimeout, timeoutMs);

    // Race the configure write against observed connection closure and the
    // shared deadline. Report a failed write or observed close directly;
    // otherwise the deadline bounds an unsettled write.
    const sent = await Promise.race([
      client.send("configure", configureArgs(expect)).then(
        () => "ok" as const,
        () => "failed" as const,
      ),
      closed,
      timedOut,
    ]);
    if (sent !== "ok") {
      return {
        ok: false,
        reason: "handshake-timeout",
        detail:
          sent === TIMED_OUT
            ? `the configure write on ${socket} did not complete within ${timeoutMs} ms`
            : sent === CLOSED
              ? `the sidecar on ${socket} closed the connection during the configure write`
              : `the configure write on ${socket} failed (the connection closed or errored)`,
      };
    }

    const result = await Promise.race([firstLine, closed, timedOut]);
    if (result === CLOSED) {
      return {
        ok: false,
        reason: "handshake-timeout",
        detail: `the sidecar on ${socket} closed the connection before its health line`,
      };
    }
    if (result === TIMED_OUT) {
      return {
        ok: false,
        reason: "handshake-timeout",
        detail: `no reachy-voice/1 health line on ${socket} within ${timeoutMs} ms`,
      };
    }
    if (result.kind !== "health") {
      return {
        ok: false,
        reason: "handshake-rejected",
        detail: `the sidecar on ${socket} sent ${
          result.kind === "malformed"
            ? `a line bob refuses before the handshake (${result.reason})`
            : `a ${result.kind} line before the handshake`
        }`,
      };
    }
    const bad = checkHealth(result.health, expect);
    if (bad.length > 0) {
      return {
        ok: false,
        reason: "handshake-rejected",
        version: result.health.version,
        detail: `the sidecar on ${socket} reported a health line bob's rules refuse: ${bad.join(", ")}`,
      };
    }
    return { ok: true, version: result.health.version };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    client.disconnect();
  }
}
