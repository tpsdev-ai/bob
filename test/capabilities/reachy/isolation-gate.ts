// The release gate for the reachy-voice isolation proofs (bob#356 V1).
//
// An isolation proof that cannot run where it is run (no sidecar user, no
// `sudo -n` path, not macOS) SKIPS, visibly, with its reason in the test name.
// On the release host the operator runs `bun run check:reachy-isolation` — a
// MANUAL prerequisite, no CI workflow runs it — which sets
// BOB_REQUIRE_ISOLATION_PROOFS=1: a proof that would skip FAILS instead, and the
// check also fails on any pinned proof that did not pass.

import { it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** The release-host roots, PINNED (RUNBOOK step 0). */
export const PINNED_INSTALL_DIR = "/usr/local/libexec/bob/reachy-voice";
export const PINNED_STATE_DIR = "/usr/local/var/bob/reachy-voice";
export const ROOT_OVERRIDES = ["BOB_REACHY_VOICE_DIR", "BOB_ISOLATION_AGENTS_ROOT"] as const;

/** The roots the proofs read. Outside required mode a developer may point them
 *  elsewhere; in required mode they are the pinned ones, and a set override is
 *  a reason the proofs that read a root cannot run (so they FAIL). */
export function releaseRoots(env: NodeJS.ProcessEnv = process.env): {
  installDir: string;
  agentsRoot: string;
  skip: string;
} {
  const pinnedAgents = join(homedir(), "agents");
  if (env[REQUIRE_ENV] !== "1") {
    return {
      installDir: env.BOB_REACHY_VOICE_DIR ?? PINNED_INSTALL_DIR,
      agentsRoot: env.BOB_ISOLATION_AGENTS_ROOT ?? pinnedAgents,
      skip: "",
    };
  }
  const set = ROOT_OVERRIDES.filter((k) => env[k] !== undefined);
  return {
    installDir: PINNED_INSTALL_DIR,
    agentsRoot: pinnedAgents,
    skip:
      set.length > 0
        ? `a substitute root is set (${set.join(", ")}); the release-host check uses only the pinned roots`
        : "",
  };
}
