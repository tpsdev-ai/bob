// The release gate for the reachy-voice isolation proofs (bob#356 V1).
//
// An isolation proof that cannot run where it is run (no sidecar user, no
// `sudo -n` path, not macOS) SKIPS, visibly, with its reason in the test name.
// On the release host the operator sets BOB_REQUIRE_ISOLATION_PROOFS=1
// (`bun run check:reachy-isolation` does), and then a proof that would skip
// FAILS instead: a skipped proof never passes a release.

import { it } from "bun:test";

export const REQUIRE_ENV = "BOB_REQUIRE_ISOLATION_PROOFS";

/** What a proof does here: run, skip (with its reason), or fail (required). */
export function proofDisposition(
  skipReason: string,
  env: NodeJS.ProcessEnv = process.env,
): "run" | "skip" | "fail" {
  if (skipReason === "") return "run";
  return env[REQUIRE_ENV] === "1" ? "fail" : "skip";
}

/** Register one isolation proof under the gate. */
export function proof(
  name: string,
  skipReason: string,
  fn: () => unknown | Promise<unknown>,
  timeoutMs?: number,
): void {
  const disposition = proofDisposition(skipReason);
  if (disposition === "run") {
    it(name, fn, timeoutMs);
  } else if (disposition === "fail") {
    it(`${name} — REQUIRED, cannot run: ${skipReason}`, () => {
      throw new Error(
        `isolation proof required (${REQUIRE_ENV}=1) but it cannot run here: ${skipReason}`,
      );
    });
  } else {
    it.skip(`${name} — skipped: ${skipReason}`, fn);
  }
}
