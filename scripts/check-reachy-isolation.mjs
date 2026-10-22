#!/usr/bin/env bun
// bob#356 V1: the RELEASE check for the reachy-voice sidecar's isolation proofs.
//
// Run on the release host (the macOS machine the sidecar ships to, with the
// jarvis-sidecar user, its group, its constrained `sudo -n` path, the installed
// sidecar and its running launch job — see sidecar/reachy-voice/RUNBOOK.md),
// from a checkout of the reviewed commit, in bob's account session, naming the
// agent:
//
//   BOB_ISOLATION_AGENT=<the agent's name> bun run check:reachy-isolation
//
// The interpreter is PINNED to /usr/bin/python3 -I (PINNED_PYTHON); a caller's
// BOB_REACHY_VOICE_PYTHON naming anything else is refused.
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
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
export const PROOFS = ["test/capabilities/reachy/isolation.test.ts"];
// The pinned proof set (isolation.test.ts names each with its id).
export const EXPECTED_PROOFS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];
// The only caller variables the proofs inherit (PATH and HOME are SET by the
// check, never inherited).
export const CHECK_ENV = ["TMPDIR", "LANG", "BOB_ISOLATION_AGENT"];
// The release host's interpreter: Apple's system python3, always run with -I
// (ignores PYTHON* variables; no user site or script directory on sys.path). The
// sudoers rule names exactly this path; on macOS it is the Command Line Tools
// shim, whose RESOLVED interpreter and import tree [P7] verifies.
export const PINNED_PYTHON = "/usr/bin/python3";
export const PINNED_DEVELOPER_DIR = "/Library/Developer/CommandLineTools";

export function checkLaunchJob({
  python = PINNED_PYTHON,
  launchPath = join(ROOT, "sidecar/reachy-voice/launch.py"),
  plist = "/Library/LaunchDaemons/dev.tps.reachy-voice.plist",
} = {}) {
  return JSON.parse(
    execFileSync(
      python,
      [
        "-I",
        "-c",
        'import json,runpy,sys; launch=runpy.run_path(sys.argv[1]); json.dump({"interpreter":launch["check_job"](sys.argv[2])},sys.stdout)',
        launchPath,
        plist,
      ],
      { env: { DEVELOPER_DIR: PINNED_DEVELOPER_DIR }, encoding: "utf8" },
    ),
  );
}
// Substitute roots the release-host check refuses outright.
export const SUBSTITUTE_ROOTS = ["BOB_REACHY_VOICE_DIR", "BOB_ISOLATION_AGENTS_ROOT"];
// The command search path the proofs run with, whatever the caller's was.
export const PINNED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// The host's deployment record: the macOS account bob runs as (the runbook's
// AGENT_USER), written by the admin under the pinned state root at install.
export const DEPLOYMENT_RECORD = "/usr/local/var/bob/reachy-voice/agent-user";
const ACCOUNT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,254}$/;

// ─── Trusted paths (owner, mode, write ACLs) ────────────────────────────────

// ACL permissions that let someone change a file or a directory's entries
// (macOS `ls -le` names). An `allow` entry naming any of them is refused.
const WRITE_PERMS = new Set([
  "write",
  "append",
  "delete",
  "delete_child",
  "add_file",
  "add_subdirectory",
  "writeattr",
  "writeextattr",
  "writesecurity",
  "chown",
]);

/** The write-granting `allow` entries in `ls -le` output (pure). */
export function writeGrantingAcls(lsOutput) {
  const out = [];
  for (const line of lsOutput.split("\n")) {
    if (!/^\s*\d+:/.test(line)) continue;
    const m = /^\s*\d+:\s+(.+?)\s+(?:inherited\s+)?(allow|deny)\s+(\S+)\s*$/.exec(line);
    if (!m) {
      out.push("unrecognized ACL entry");
      continue;
    }
    if (m?.[2] !== "allow") continue;
    const perms = m[3].split(",").filter((p) => WRITE_PERMS.has(p));
    if (perms.length > 0) out.push(`${m[1]} allow ${perms.join(",")}`);
  }
  return out;
}

// Elsewhere than macOS the ACL check cannot run, and every trust check FAILS
// with this one line (fail closed; the release host is macOS).
export const ACL_UNCHECKED = "write ACLs are checked only on macOS";

/** The write-granting ACL entries on one path (not followed), or why they
 *  cannot be read (macOS; see ACL_UNCHECKED elsewhere). */
function aclProblems(path, recursive = false) {
  let out;
  try {
    out = execFileSync("/bin/ls", [recursive ? "-leRA" : "-lde", path], {
      env: {},
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return [`${path}: its ACLs cannot be read`];
  }
  return writeGrantingAcls(out).map((e) => `${path}: a write-granting ACL entry (${e})`);
}

function prefixesOf(path, from) {
  const out = [];
  for (let q = path; ; q = dirname(q)) {
    out.push(q);
    if (q === from || q === dirname(q)) break;
  }
  return out.reverse();
}

/**
 * Why `path` is not trusted, or [] when it is: EVERY component from / down to
 * it — and, for a symlink component, every component of its target — is owned
 * by root, is not group- or other-writable (a symlink's own mode is not
 * checked; its directory and target are), and carries no write-granting ACL
 * entry. `owners` and `from` (where the walk starts) are seams for tests.
 */
export function chainProblems(
  path,
  { owners = [0], from = "/", checked = new Set(), aclTrees = new Set() } = {},
) {
  const allowed = new Set(owners);
  const acls = process.platform === "darwin";
  const seen = checked;
  const problems = [];
  const visit = (p) => {
    for (const q of prefixesOf(p, from)) {
      if (seen.has(q)) continue;
      seen.add(q);
      let st;
      try {
        st = lstatSync(q);
      } catch {
        problems.push(`${q} cannot be read`);
        return;
      }
      if (!allowed.has(st.uid)) problems.push(`${q} is not root-owned (uid ${st.uid})`);
      if (st.isSymbolicLink()) {
        let target;
        try {
          realpathSync(q);
          target = resolve(dirname(q), readlinkSync(q));
        } catch {
          problems.push(`${q} is a dangling symlink`);
          continue;
        }
        visit(target);
        continue;
      }
      if (q !== p && !st.isDirectory()) problems.push(`${q} is not a directory`);
      if (!st.isDirectory() && !st.isFile())
        problems.push(`${q} is not a regular file or directory`);
      if ((st.mode & 0o022) !== 0) problems.push(`${q} is writable by group or other`);
      if (acls && ![...aclTrees].some((tree) => q.startsWith(`${tree}/`))) {
        problems.push(...aclProblems(q));
      }
    }
  };
  visit(resolve(path));
  if (!acls) problems.push(ACL_UNCHECKED); // fail closed, after the real findings
  return problems;
}

/**
 * Why the tree under `dir` is not trusted, or []: its chain (chainProblems),
 * and every entry below it root-owned, not group- or other-writable, a regular
 * file, directory or symlink (a symlink's target checked as a chain, and as a
 * tree when it is a directory outside this one), with no write-granting ACL
 * entry anywhere (one `ls -leR`).
 */
export function treeProblems(
  dir,
  {
    owners = [0],
    from = "/",
    limit = 20,
    seen = new Set(),
    checked = new Set(),
    aclTrees = new Set(),
  } = {},
) {
  const allowed = new Set(owners);
  let root;
  try {
    root = realpathSync(resolve(dir));
  } catch {
    return [`${dir} cannot be read`];
  }
  const problems = [...chainProblems(resolve(dir), { owners, from, checked, aclTrees })];
  if (!statSafe(root)?.isDirectory()) return [...problems, `${dir} is not a directory`];
  if (seen.has(root)) return problems;
  seen.add(root);
  aclTrees.add(root);
  let found = 0;
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      problems.push(`${d} cannot be listed`);
      return;
    }
    for (const name of names) {
      if (found >= limit) return;
      const before = problems.length;
      const p = join(d, name);
      const st = lstatSync(p);
      if (!allowed.has(st.uid)) problems.push(`${p} is not root-owned (uid ${st.uid})`);
      if (st.isSymbolicLink()) {
        problems.push(...chainProblems(p, { owners, from, checked, aclTrees }));
        let target;
        try {
          target = realpathSync(p);
        } catch {
          problems.push(`${p} is a dangling symlink`);
          continue;
        }
        if (target !== root && !target.startsWith(`${root}/`)) {
          problems.push(
            ...(statSync(target).isDirectory()
              ? treeProblems(target, { owners, from, limit, seen, checked, aclTrees })
              : chainProblems(target, { owners, from, checked, aclTrees })),
          );
        }
        continue;
      }
      if ((st.mode & 0o022) !== 0) problems.push(`${p} is writable by group or other`);
      if (!st.isDirectory() && !st.isFile()) {
        problems.push(`${p} is not a regular file or directory`);
      }
      found += problems.length - before;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  if (process.platform === "darwin") problems.push(...aclProblems(root, true));
  return [...new Set(problems)].slice(0, limit * 2);
}

/**
 * [P7] What must be trusted on the release host, and why it is not ([] when it
 * is). Each is checked along its FULL path chain (chainProblems/treeProblems):
 *   - the pinned interpreter (/usr/bin/python3) and, on macOS, the
 *     xcode-select link that decides what it runs;
 *   - what it RESOLVED to, as the proof command reported it through sudo
 *     (`proof.py interp`): the executable, the real interpreter, the whole
 *     base-prefix tree (stdlib, lib-dynload, site-packages, binaries), and
 *     every sys.path entry (a tree; a missing entry's nearest existing
 *     ancestor); it must have run isolated (-I);
 *   - the install directory and each installed file (a regular file);
 *   - the Piper directory tree, and the deployment record.
 * `owners`, `from` and `xcodeSelectLink` are seams for tests.
 */
export function releaseTrustProblems({
  interp,
  installDir,
  installedFiles,
  piperDir,
  record = DEPLOYMENT_RECORD,
  pinnedPython = PINNED_PYTHON,
  xcodeSelectLink = process.platform === "darwin" ? "/var/db/xcode_select_link" : null,
  developerDir = process.platform === "darwin" ? PINNED_DEVELOPER_DIR : null,
  owners,
  from,
}) {
  const o = { owners, from };
  const problems = [...chainProblems(pinnedPython, o)];
  if (!statSafe(pinnedPython)?.isFile()) problems.push(`${pinnedPython} is not a regular file`);
  if (developerDir) {
    const selected = join(developerDir, "usr/bin/python3");
    problems.push(...chainProblems(selected, o));
    if (!statSafe(selected)?.isFile()) problems.push(`${selected} is not a regular file`);
    try {
      if (interp.real !== realpathSync(selected)) {
        problems.push(
          "the proof interpreter differs from the selected Command Line Tools interpreter",
        );
      }
    } catch {
      problems.push(`${selected} cannot be resolved`);
    }
  }
  if (xcodeSelectLink) {
    let linked = false;
    try {
      lstatSync(xcodeSelectLink);
      linked = true;
    } catch {}
    if (linked) problems.push(...chainProblems(xcodeSelectLink, o));
  }
  if (interp.isolated !== 1) problems.push("the proof interpreter did not run isolated (-I)");
  problems.push(...chainProblems(interp.executable, o), ...chainProblems(interp.real, o));
  for (const p of [interp.executable, interp.real]) {
    if (!statSafe(p)?.isFile()) problems.push(`${p} is not a regular file`);
  }
  problems.push(...treeProblems(interp.base, o));
  if (interp.prefix !== interp.base) problems.push(...treeProblems(interp.prefix, o));
  const base = interp.base;
  for (const entry of interp.path) {
    let st;
    try {
      st = statSync(entry);
    } catch {}
    // inside the base tree: verified by its walk (a missing entry's ancestor too)
    if (entry === base || entry.startsWith(`${base}/`)) continue;
    if (st === undefined) {
      let ancestor = dirname(entry);
      while (!statSafe(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
      problems.push(...chainProblems(ancestor, o));
    } else if (st.isDirectory()) {
      problems.push(...treeProblems(entry, o));
    } else {
      problems.push(...chainProblems(entry, o));
    }
  }
  problems.push(...chainProblems(installDir, o));
  for (const f of installedFiles) {
    const p = join(installDir, f);
    problems.push(...chainProblems(p, o));
    if (!statSafe(p)?.isFile()) problems.push(`${p} is not a regular file`);
  }
  if (piperDir) problems.push(...treeProblems(piperDir, o));
  problems.push(...chainProblems(record, o));
  if (!statSafe(record)?.isFile()) problems.push(`${record} is not a regular file`);
  return [...new Set(problems)];
}

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

// The reviewed Piper entry script and its pinned wheel set.
export const PIPER_ENTRY_SOURCE = join(ROOT, "sidecar/reachy-voice/piper-entry.py");
export const PIPER_REQUIREMENTS = join(ROOT, "sidecar/reachy-voice/piper-requirements.txt");

/** The pinned piper-tts version from the requirements file, or undefined. */
export function pinnedPiperVersion(requirements = PIPER_REQUIREMENTS) {
  let text;
  try {
    text = readFileSync(requirements, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const m = /^piper-tts==([0-9][^\s\\;]*)/.exec(line.trim());
    if (m) return m[1];
  }
  return undefined;
}

/**
 * [P7] The installed Piper: `$PIPER_DIR/piper` is byte-identical to the
 * reviewed entry script and root-owned, and the piper-tts distribution under
 * `$PIPER_DIR/lib` reports the pinned version. `owners` is a seam for tests.
 */
export function piperInstallProblems({
  piperDir = "/usr/local/libexec/bob/piper",
  entrySource = PIPER_ENTRY_SOURCE,
  requirements = PIPER_REQUIREMENTS,
  owners = [0],
} = {}) {
  const allowed = new Set(owners);
  const problems = [];
  const entry = join(piperDir, "piper");
  let installed;
  let reviewed;
  try {
    installed = readFileSync(entry);
  } catch {
    problems.push(`${entry} cannot be read`);
  }
  try {
    reviewed = readFileSync(entrySource);
  } catch {
    problems.push(`${entrySource} cannot be read`);
  }
  if (installed && reviewed && !installed.equals(reviewed)) {
    problems.push(`${entry} is not byte-identical to ${entrySource}`);
  }
  let st;
  try {
    st = lstatSync(entry);
  } catch {
    problems.push(`${entry} cannot be read`);
  }
  if (st) {
    if (!allowed.has(st.uid)) problems.push(`${entry} is not root-owned (uid ${st.uid})`);
    if (!st.isFile()) problems.push(`${entry} is not a regular file`);
  }
  const want = pinnedPiperVersion(requirements);
  if (!want) problems.push(`the pinned piper-tts version cannot be read from ${requirements}`);
  const lib = join(piperDir, "lib");
  let names;
  try {
    names = readdirSync(lib);
  } catch {
    problems.push(`${lib} cannot be listed`);
  }
  const dists = (names ?? []).filter((n) => /^piper_tts-.+\.dist-info$/.test(n));
  if (dists.length !== 1) {
    problems.push(`${lib} holds ${dists.length} piper-tts distributions, not one`);
  }
  for (const dist of dists) {
    const metadata = join(lib, dist, "METADATA");
    let body;
    try {
      body = readFileSync(metadata, "utf8");
    } catch {
      problems.push(`${metadata} cannot be read`);
      continue;
    }
    const version = /^Version:\s*(\S+)\s*$/m.exec(body)?.[1];
    if (version !== want) {
      problems.push(
        `the installed piper-tts ${version ?? "has no version"} is not the pinned ${want}`,
      );
    }
  }
  return problems;
}

/**
 * bob's account from the deployment record, or why it cannot be trusted: the
 * record must be a regular file, no component of its path a symlink, and its
 * whole chain trusted (chainProblems: root-owned, not group- or other-writable,
 * no write-granting ACL) — so only root can have written or swapped it. Its
 * content is exactly one account name. `owners` and `from` are test seams.
 */
export function readDeploymentRecord(path = DEPLOYMENT_RECORD, { owners, from } = {}) {
  let text;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) {
        return { reason: `the deployment record ${path} is not a regular file` };
      }
      for (const q of prefixesOf(resolve(path), from ?? "/")) {
        if (lstatSync(q).isSymbolicLink()) {
          return { reason: `${q} (on the deployment record's path) is a symlink` };
        }
      }
      const problems = chainProblems(path, { owners, from });
      if (problems.length > 0) {
        return { reason: `${problems[0]}, so the deployment record is untrusted` };
      }
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        return { reason: `${path} (on the deployment record's path) is a symlink` };
      }
      if (!st.isFile()) {
        return { reason: `the deployment record ${path} is not a regular file` };
      }
      if (opened.dev !== st.dev || opened.ino !== st.ino) {
        return { reason: `the deployment record ${path} changed while checked` };
      }
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return { reason: `the deployment record ${path} is missing (RUNBOOK step 4)` };
    }
    if (error.code === "ELOOP") {
      return { reason: `${path} (on the deployment record's path) is a symlink` };
    }
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
 *  substitute root, an interpreter other than the pinned one, running as root,
 *  an account the database cannot read, or a HOME other than the running
 *  account's. Which account is bob's is decided by
 *  the deployment record (releaseRoots), never by the caller. `selfUid` and
 *  `lookup` are seams for tests. */
export function refusal(env, selfUid = process.getuid?.(), lookup = accountOf) {
  const substitutes = SUBSTITUTE_ROOTS.filter((k) => env[k] !== undefined);
  if (substitutes.length > 0)
    return `a substitute root is set (${substitutes.join(", ")}); unset it`;
  if (env.BOB_REACHY_VOICE_PYTHON !== undefined && env.BOB_REACHY_VOICE_PYTHON !== PINNED_PYTHON) {
    return `the release host's interpreter is pinned to ${PINNED_PYTHON}; unset BOB_REACHY_VOICE_PYTHON`;
  }
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
  // [P9] speaks to the deployed sidecar, which serves ONE connection at a time.
  // A link bob's reachy capability still holds consumes the answer, so stop that
  // capability first; the proof then reports what the connect and the wire show.
  process.stdout.write(
    "reachy-voice isolation release check: [P9] run with bob's reachy capability STOPPED (its live link consumes the sidecar's answer).\n",
  );
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
