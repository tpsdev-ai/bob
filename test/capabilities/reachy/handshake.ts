// Test helper (bob#356): bring a wired reachy core to a READY link through the
// real reachy-voice/1 handshake — bob's `configure`, then a matching health line.

import type { ReachyCommands, WiredReachy } from "../../../src/capabilities/reachy/capability.js";
import { VOICE_PROTOCOL } from "../../../src/capabilities/reachy/wire.js";

export const TEST_SIDECAR_VERSION = "test-sidecar-1";
export const TEST_MODEL_HASH = "a".repeat(64);

/** A reachy-voice/1 health line for this link (overridable field by field). */
export function healthLine(
  wired: WiredReachy,
  state: { profile: string; wakeName: string },
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "health",
    protocol: VOICE_PROTOCOL,
    version: TEST_SIDECAR_VERSION,
    profile: state.profile,
    generation: wired.link().generation,
    wakeName: state.wakeName,
    mode: "off",
    trainedPhrase: null,
    modelHash: null,
    muted: false,
    ok: true,
    ...over,
  };
}

/** The handshake, synchronously: `connected()` and the health line's acceptance
 *  both complete before their first await (the recorder's `send` resolves at
 *  once). The `configure` command is removed from a recorder's log, so a test's
 *  command assertions see only what it caused. */
export function handshakeNow(
  wired: WiredReachy,
  state: { profile: string; wakeName: string },
  commands?: ReachyCommands & { sent?: unknown[] },
): void {
  void wired.connected();
  void wired.handleLine(healthLine(wired, state));
  if (wired.link().phase !== "ready") throw new Error("test handshake did not reach ready");
  if (commands?.sent) commands.sent.length = 0;
}

/** The handshake, awaited (for tests that check what it sends and audits). */
export async function handshake(
  wired: WiredReachy,
  state: { profile: string; wakeName: string },
  over: Record<string, unknown> = {},
) {
  await wired.connected();
  return wired.handleLine(healthLine(wired, state, over));
}

/** The value, or a thrown error naming what was missing (instead of `!`). */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing: ${what}`);
  return value;
}
