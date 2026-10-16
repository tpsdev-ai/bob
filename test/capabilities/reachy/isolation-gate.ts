// The release gate for the reachy-voice isolation proofs (bob#356 V1).
//
// An isolation proof that cannot run where it is run (no sidecar user, no
// `sudo -n` path, not macOS) SKIPS, visibly, with its reason in the test name.
// On the release host the operator runs `bun run check:reachy-isolation` — a
// MANUAL prerequisite, no CI workflow runs it — which sets
// BOB_REQUIRE_ISOLATION_PROOFS=1: a proof that would skip FAILS instead, and the
// check also fails on any pinned proof that did not pass.

import { it } from "bun:test";
import { join } from "node:path";
import { accountOf, readDeploymentRecord } from "../../../scripts/check-reachy-isolation.mjs";

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
export const PINNED_PIPER_DIR = "/usr/local/libexec/bob/piper";
export const ROOT_OVERRIDES = ["BOB_REACHY_VOICE_DIR", "BOB_ISOLATION_AGENTS_ROOT"] as const;

/** The roots the proofs read. Outside required mode a developer may point them
 *  elsewhere. In required mode they belong to BOB'S account as the host's
 *  root-owned DEPLOYMENT RECORD names it (never an account the caller names):
 *  the record must be trusted (readDeploymentRecord), name a non-root account
 *  in the OS account database, and that account must be the one running (same
 *  uid), with its own HOME (never an inherited one). The agents root is <that
 *  home>/agents and the install root is pinned. An override, root, or any
 *  record, account or HOME mismatch is a reason the proofs that read a root
 *  cannot run (so they FAIL). `selfUid`, `lookup` and `record` are test seams. */
export function releaseRoots(
  env: NodeJS.ProcessEnv = process.env,
  selfUid: number | undefined = process.getuid?.(),
  lookup: (nameOrUid: string) => { uid: number; home: string } | undefined = accountOf,
  record: () => { user?: string; reason?: string } = readDeploymentRecord,
): {
  installDir: string;
  agentsRoot: string;
  home: string;
  skip: string;
} {
  if (env[REQUIRE_ENV] !== "1") {
    const home =
      env.HOME ?? (selfUid === undefined ? undefined : lookup(String(selfUid))?.home) ?? "/";
    return {
      installDir: env.BOB_REACHY_VOICE_DIR ?? PINNED_INSTALL_DIR,
      agentsRoot: env.BOB_ISOLATION_AGENTS_ROOT ?? join(home, "agents"),
      home,
      skip: "",
    };
  }
  const set = ROOT_OVERRIDES.filter((k) => env[k] !== undefined);
  const rec = record();
  const bob = rec.user ? lookup(rec.user) : undefined;
  const home = bob?.home ?? "/nonexistent-account-home";
  const skip =
    set.length > 0
      ? `a substitute root is set (${set.join(", ")}); the release-host check uses only the pinned roots`
      : selfUid === 0
        ? "the proofs never run as root"
        : rec.reason
          ? rec.reason
          : !bob
            ? `the account the deployment record names (${rec.user}) is not in the OS account database`
            : bob.uid === 0
              ? "the deployment record names root; it must name bob's own account"
              : selfUid !== bob.uid
                ? `the proofs must run as bob's account ${rec.user} (uid ${bob.uid}, from the deployment record), not uid ${selfUid}`
                : env.HOME !== bob.home
                  ? `HOME (${env.HOME ?? "unset"}) conflicts with the account home (${bob.home})`
                  : "";
  return { installDir: PINNED_INSTALL_DIR, agentsRoot: join(home, "agents"), home, skip };
}
