#!/usr/bin/env bun
// bob#356 V1: the RELEASE check for the reachy-voice sidecar's isolation proofs.
//
// Run on the release host (the macOS machine the sidecar ships to, with the
// jarvis-sidecar user, its group, its constrained `sudo -n` path, the installed
// sidecar and its running launch job — see sidecar/reachy-voice/RUNBOOK.md),
// from a checkout of the reviewed commit, in bob's account session, naming the
// agent and the pinned interpreter:
//
//   BOB_ISOLATION_AGENT=<the agent's name> \
//   BOB_REACHY_VOICE_PYTHON=<the interpreter the sudoers rule names> \
//   bun run check:reachy-isolation
//
// It runs the isolation proofs with BOB_REQUIRE_ISOLATION_PROOFS=1, under which
// a proof that cannot run FAILS instead of skipping; it fails again on any skip
// it sees in the report, and it requires EVERY pinned proof id below to have
// passed — a proof deleted or renamed fails the check even with zero skips.
// The check is bound to BOB'S OS account as the host's DEPLOYMENT RECORD names
// it — never to an account the caller names. The admin writes that record at
// install (RUNBOOK step 4: DEPLOYMENT_RECORD, root-owned, naming AGENT_USER).
// The check refuses to start as root, and every proof that reads bob's tree
// FAILS unless the record is trusted (a regular file, it and every directory
// above it root-owned and writable by no one else), names a non-root account,
// and that account is the one running (same uid in the OS account database).
// The proofs run with a MINIMAL environment (checkEnv): PATH is PINNED (the
// caller's is ignored), HOME is the running account's home as the account
// database records it (never the inherited HOME), and the check refuses when
// the inherited HOME conflicts with it or a substitute root is set: the install
// root, the state root and the agents root (<bob's home>/agents) are pinned.
// This is a MANUAL release-host prerequisite: no CI workflow runs it (CI runs
// on Linux, where the seatbelt proofs cannot exist).

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
export const PROOFS = ["test/capabilities/reachy/isolation.test.ts"];
// The pinned proof set (isolation.test.ts names each with its id).
export const EXPECTED_PROOFS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];
// The only caller variables the proofs inherit (PATH and HOME are SET by the
// check, never inherited).
export const CHECK_ENV = ["TMPDIR", "LANG", "BOB_ISOLATION_AGENT", "BOB_REACHY_VOICE_PYTHON"];
// Substitute roots the release-host check refuses outright.
export const SUBSTITUTE_ROOTS = ["BOB_REACHY_VOICE_DIR", "BOB_ISOLATION_AGENTS_ROOT"];
// The command search path the proofs run with, whatever the caller's was.
export const PINNED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// The host's deployment record: the macOS account bob runs as (the runbook's
// AGENT_USER), written by the admin under the pinned state root at install.
export const DEPLOYMENT_RECORD = "/usr/local/var/bob/reachy-voice/agent-user";
const ACCOUNT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,254}$/;

/**
 * bob's account from the deployment record, or why it cannot be trusted: the
 * record must be a regular file (not a symlink), and it and EVERY directory
 * above it must be root-owned and writable by no group or other — so only root
 * can have written or swapped it. Its content is exactly one account name.
 */
export function readDeploymentRecord(path = DEPLOYMENT_RECORD) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { reason: `the deployment record ${path} is missing (RUNBOOK step 4)` };
  }
  if (!st.isFile()) return { reason: `the deployment record ${path} is not a regular file` };
  for (let p = path; ; p = dirname(p)) {
    let s;
    try {
      s = lstatSync(p);
    } catch {
      return { reason: `${p} cannot be read` };
    }
    if (s.isSymbolicLink()) return { reason: `${p} (above the deployment record) is a symlink` };
    if (s.uid !== 0)
      return { reason: `${p} is not root-owned, so the deployment record is untrusted` };
    if ((s.mode & 0o022) !== 0) {
      return {
        reason: `${p} is writable by group or other, so the deployment record is untrusted`,
      };
    }
    if (p === dirname(p)) break;
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { reason: `the deployment record ${path} cannot be read` };
  }
  const user = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!ACCOUNT_NAME.test(user)) {
    return { reason: `the deployment record ${path} does not hold exactly one account name` };
  }
  return { user };
}

/**
 * One account from the OS ACCOUNT DATABASE, by name or uid, read with an
 * absolute binary and an EMPTY environment, so no inherited HOME, USER or PATH
 * can change it (Bun's os.userInfo().homedir follows HOME, so it is not used).
 * Undefined when it cannot be read.
 */
export function accountOf(nameOrUid) {
  if (nameOrUid === undefined || nameOrUid === "") return undefined;
  try {
    if (process.platform === "darwin") {
      // name:passwd:uid:gid:class:change:expire:gecos:home:shell
      const f = execFileSync("/usr/bin/id", ["-P", String(nameOrUid)], {
        env: {},
        encoding: "utf8",
      })
        .trim()
        .split(":");
      return f.length >= 10 && f[8] ? { name: f[0], uid: Number(f[2]), home: f[8] } : undefined;
    }
    // name:passwd:uid:gid:gecos:home:shell
    const f = execFileSync("/usr/bin/getent", ["passwd", String(nameOrUid)], {
      env: {},
      encoding: "utf8",
    })
      .trim()
      .split(":");
    return f.length >= 7 && f[5] ? { name: f[0], uid: Number(f[2]), home: f[5] } : undefined;
  } catch {
    return undefined;
  }
}

/** The invoking uid's home from the OS account database (see accountOf). */
export function accountHome(uid = process.getuid?.()) {
  return uid === undefined ? undefined : accountOf(String(uid))?.home;
}

/** Why the release-host check must not start, or "" (the caller's env): a
 *  substitute root, running as root, an account the database cannot read, or a
 *  HOME other than the running account's. Which account is bob's is decided by
 *  the deployment record (releaseRoots), never by the caller. `selfUid` and
 *  `lookup` are seams for tests. */
export function refusal(env, selfUid = process.getuid?.(), lookup = accountOf) {
  const substitutes = SUBSTITUTE_ROOTS.filter((k) => env[k] !== undefined);
  if (substitutes.length > 0)
    return `a substitute root is set (${substitutes.join(", ")}); unset it`;
  if (selfUid === undefined) return "the running uid cannot be read";
  if (selfUid === 0) return "the check never runs as root; run it in bob's account session";
  const self = lookup(String(selfUid));
  if (!self) return `uid ${selfUid} is not in the OS account database`;
  if (env.HOME !== self.home) {
    return `HOME (${env.HOME ?? "unset"}) conflicts with the account home (${self.home}); run the check with the account's own HOME`;
  }
  return "";
}

/** The environment the proofs run with: CHECK_ENV from the caller, a PINNED
 *  PATH, the ACCOUNT home as HOME, and the gate. */
export function checkEnv(env, home = accountHome()) {
  const out = { BOB_REQUIRE_ISOLATION_PROOFS: "1", PATH: PINNED_PATH };
  if (home) out.HOME = home;
  for (const k of CHECK_ENV) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/** The counts bun prints at the end of a run (`N pass`, `N skip`, `N fail`). */
export function proofCounts(report) {
  const count = (word) => {
    const m = new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(report);
    return m ? Number(m[1]) : 0;
  };
  return { pass: count("pass"), skip: count("skip"), fail: count("fail") };
}

/** The pinned proof ids that PASSED in a report (`(pass) … [Pn] …` lines). */
export function passedProofs(report) {
  const ids = new Set();
  for (const line of report.split("\n")) {
    if (!line.startsWith("(pass) ")) continue;
    for (const m of line.matchAll(/\[(P\d+)\]/g)) ids.add(m[1]);
  }
  return ids;
}

/** The verdict on one run: ok only with EVERY pinned proof run and passing. */
export function verdict(status, report, expected = EXPECTED_PROOFS) {
  const { skip, fail } = proofCounts(report);
  if (status !== 0 || fail > 0) return { ok: false, why: `${fail} proof(s) failed` };
  if (skip > 0)
    return { ok: false, why: `${skip} proof(s) skipped — a skipped proof fails the check` };
  const passed = passedProofs(report);
  const missing = expected.filter((id) => !passed.has(id));
  if (missing.length > 0) return { ok: false, why: `proof(s) missing: ${missing.join(", ")}` };
  return { ok: true, why: `all ${expected.length} pinned proofs ran and passed` };
}

if (import.meta.main) {
  const refused = refusal(process.env);
  if (refused) {
    process.stdout.write(`reachy-voice isolation release check: FAIL — ${refused}\n`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, ["test", ...PROOFS], {
    cwd: ROOT,
    env: checkEnv(process.env),
    encoding: "utf8",
  });
  const report = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(report);
  const v = verdict(r.status, report);
  process.stdout.write(
    `\nreachy-voice isolation release check: ${v.ok ? "PASS" : "FAIL"} — ${v.why}\n`,
  );
  process.exit(v.ok ? 0 : 1);
}
