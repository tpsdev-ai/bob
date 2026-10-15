// bob#356 V1: a skipped or missing isolation proof never passes the release-host
// check. The gate turns a skip into a failure under BOB_REQUIRE_ISOLATION_PROOFS=1,
// and the check script requires every PINNED proof id to have passed.
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ACL_UNCHECKED,
  accountHome,
  CHECK_ENV,
  checkEnv,
  DEPLOYMENT_RECORD,
  EXPECTED_PROOFS,
  PINNED_PATH,
  PINNED_PYTHON,
  passedProofs,
  proofCounts,
  readDeploymentRecord,
  refusal,
  SUBSTITUTE_ROOTS,
  verdict,
} from "../../../scripts/check-reachy-isolation.mjs";
import {
  PINNED_INSTALL_DIR,
  PINNED_STATE_DIR,
  proofDisposition,
  REQUIRE_ENV,
  releaseRoots,
} from "./isolation-gate.js";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "check-reachy-isolation.mjs");
const report = (lines: string[], counts: { pass: number; skip: number; fail: number }) =>
  `${lines.join("\n")}\n\n ${counts.pass} pass\n ${counts.skip} skip\n ${counts.fail} fail\n`;
const ALL = EXPECTED_PROOFS.map((id) => `(pass) isolation > [${id}] a proof [1.0ms]`);

describe("bob#356 — the isolation-proof release gate", () => {
  it("a proof that can run, runs; one that cannot SKIPS locally and FAILS when required", () => {
    expect(proofDisposition("", {})).toBe("run");
    expect(proofDisposition("", { [REQUIRE_ENV]: "1" })).toBe("run");
    expect(proofDisposition("no sidecar user", {})).toBe("skip");
    expect(proofDisposition("no sidecar user", { [REQUIRE_ENV]: "1" })).toBe("fail");
    expect(proofDisposition("no sidecar user", { [REQUIRE_ENV]: "0" })).toBe("skip");
  });

  it("the check passes only when EVERY pinned proof ran and passed", () => {
    const full = report(ALL, { pass: ALL.length, skip: 0, fail: 0 });
    expect(proofCounts(full)).toEqual({ pass: ALL.length, skip: 0, fail: 0 });
    expect(verdict(0, full).ok).toBe(true);
    // a skip fails it
    expect(verdict(0, report(ALL.slice(0, 2), { pass: 2, skip: 5, fail: 0 })).why).toContain(
      "skipped",
    );
    // a failure fails it
    expect(verdict(1, report(ALL, { pass: 6, skip: 0, fail: 1 })).ok).toBe(false);
    // a MISSING proof fails it, even with zero skips and zero failures
    const minusP4 = ALL.filter((l) => !l.includes("[P4]"));
    const v = verdict(0, report(minusP4, { pass: minusP4.length, skip: 0, fail: 0 }));
    expect(v).toEqual({ ok: false, why: "proof(s) missing: P4" });
    // a `(fail)` line naming a proof does not count as passed
    expect(passedProofs("(fail) x > [P1] y").has("P1")).toBe(false);
  });

  it("the pinned ids are exactly the ids isolation.test.ts declares", () => {
    const src = readFileSync(join(import.meta.dirname, "isolation.test.ts"), "utf8");
    const declared = [...src.matchAll(/^\s*[`"]\[(P\d+)\]/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...EXPECTED_PROOFS].sort());
  });

  // A fake account database for the pure checks: bob (uid 501), another
  // account (502) and root; and fake deployment records.
  const db = (n: string) =>
    ({
      bob: { uid: 501, home: "/Users/bob" },
      "501": { uid: 501, home: "/Users/bob" },
      other: { uid: 502, home: "/Users/other" },
      "502": { uid: 502, home: "/Users/other" },
      root: { uid: 0, home: "/var/root" },
      "0": { uid: 0, home: "/var/root" },
    })[n];
  const names = (user: string) => () => ({ user });
  const RECORD_BOB = names("bob");

  it("the proofs inherit only a minimal environment: PATH pinned, HOME the account's, roots never", () => {
    const env = checkEnv(
      {
        PATH: "/private/tmp/poison:/usr/bin",
        HOME: "/private/tmp/substitute",
        BOB_ISOLATION_AGENT: "rocky",
        BOB_REACHY_VOICE_DIR: "/tmp/fake-install",
        BOB_ISOLATION_AGENTS_ROOT: "/tmp/fake-agents",
        TPS_VAULT_KEY: "secret",
      },
      "/Users/bob",
    );
    expect(env).toEqual({
      BOB_REQUIRE_ISOLATION_PROOFS: "1",
      PATH: PINNED_PATH,
      HOME: "/Users/bob",
      BOB_ISOLATION_AGENT: "rocky",
    });
    for (const k of SUBSTITUTE_ROOTS) expect(CHECK_ENV).not.toContain(k);
  });

  it("the gate never starts as root, and only with the running account's own HOME", () => {
    expect(refusal({ HOME: "/Users/bob" }, 501, db)).toBe("");
    // the interpreter is pinned: naming another is refused, naming it is not
    expect(
      refusal(
        { HOME: "/Users/bob", BOB_REACHY_VOICE_PYTHON: "/opt/homebrew/bin/python3" },
        501,
        db,
      ),
    ).toContain("pinned to /usr/bin/python3");
    expect(refusal({ HOME: "/Users/bob", BOB_REACHY_VOICE_PYTHON: PINNED_PYTHON }, 501, db)).toBe(
      "",
    );
    // root naming itself, with root's own HOME: refused
    expect(refusal({ HOME: "/var/root" }, 0, db)).toContain("never runs as root");
    expect(refusal({ HOME: "/Users/bob" }, 777, db)).toContain("not in the OS account database");
    expect(refusal({ HOME: "/private/tmp/substitute" }, 501, db)).toContain("conflicts");
    expect(refusal({ HOME: "/Users/bob", BOB_REACHY_VOICE_DIR: "/x" }, 501, db)).toContain(
      "substitute root",
    );
  });

  it("in required mode the roots are PINNED and a substitute root makes the proofs that read it fail", () => {
    const sub = { BOB_REACHY_VOICE_DIR: "/tmp/fake", BOB_ISOLATION_AGENTS_ROOT: "/tmp/agents" };
    const dev = releaseRoots({ ...sub, HOME: "/Users/bob" }, 501, db, RECORD_BOB);
    expect(dev).toMatchObject({ installDir: "/tmp/fake", agentsRoot: "/tmp/agents", skip: "" });
    const bob = { HOME: "/Users/bob", [REQUIRE_ENV]: "1" };
    const required = releaseRoots({ ...sub, ...bob }, 501, db, RECORD_BOB);
    expect(required.installDir).toBe(PINNED_INSTALL_DIR);
    expect(required.agentsRoot).toBe("/Users/bob/agents");
    expect(required.skip).toContain("BOB_REACHY_VOICE_DIR, BOB_ISOLATION_AGENTS_ROOT");
    expect(proofDisposition(required.skip, { [REQUIRE_ENV]: "1" })).toBe("fail");
    expect(releaseRoots(bob, 501, db, RECORD_BOB).skip).toBe("");
  });

  it("in required mode bob's account comes from the DEPLOYMENT RECORD: root, another account naming itself, or no record fails", () => {
    const req = { [REQUIRE_ENV]: "1" };
    const fails = (skip: string) =>
      expect(proofDisposition(skip, { [REQUIRE_ENV]: "1" })).toBe("fail");
    // root, even with a record naming root and root's own HOME
    const root = releaseRoots({ ...req, HOME: "/var/root" }, 0, db, names("root"));
    expect(root.skip).toBe("the proofs never run as root");
    fails(root.skip);
    // a record that names root is refused for any runner
    expect(releaseRoots({ ...req, HOME: "/Users/bob" }, 501, db, names("root")).skip).toContain(
      "names root",
    );
    // ANOTHER account, with its own HOME: the record names bob, so it fails
    const other = releaseRoots({ ...req, HOME: "/Users/other" }, 502, db, RECORD_BOB);
    expect(other.skip).toContain(
      "must run as bob's account bob (uid 501, from the deployment record), not uid 502",
    );
    expect(other.agentsRoot).toBe("/Users/bob/agents"); // never the runner's tree
    fails(other.skip);
    // no (or an untrusted) record
    const missing = () => ({ reason: "the deployment record /x is missing (RUNBOOK step 4)" });
    expect(releaseRoots({ ...req, HOME: "/Users/bob" }, 501, db, missing).skip).toContain(
      "missing",
    );
    expect(releaseRoots({ ...req, HOME: "/Users/bob" }, 501, db, names("ghost")).skip).toContain(
      "not in the OS account database",
    );
    // the right account, a poisoned HOME
    const poisoned = releaseRoots({ ...req, HOME: "/private/tmp/substitute" }, 501, db, RECORD_BOB);
    expect(poisoned.agentsRoot).toBe("/Users/bob/agents");
    expect(poisoned.skip).toContain(
      "HOME (/private/tmp/substitute) conflicts with the account home",
    );
    fails(poisoned.skip);
  });

  it("the deployment record rejects an untrusted owner, symlink, missing file or invalid content", () => {
    expect(DEPLOYMENT_RECORD).toBe(join(PINNED_STATE_DIR, "agent-user"));
    const dir = mkdtempSync(join(tmpdir(), "rv-record-"));
    try {
      const mine = join(dir, "agent-user");
      writeFileSync(mine, "bob\n");
      expect(
        readDeploymentRecord(mine, {
          owners: [(process.getuid?.() ?? 0) + 1],
          from: dir,
        }).reason,
      ).toContain("is not root-owned");
      const link = join(dir, "link");
      symlinkSync(mine, link);
      expect(readDeploymentRecord(link).reason).toContain("not a regular file");
      expect(readDeploymentRecord(join(dir, "absent")).reason).toContain("is missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // a root-owned chain passes the trust checks, and the content is then
    // checked: /private/etc/shells (or /etc/shells) holds many lines, not one name
    const rootOwned = existsSync("/private/etc/shells") ? "/private/etc/shells" : "/etc/shells";
    if (existsSync(rootOwned) && !lstatSync(dirname(rootOwned)).isSymbolicLink()) {
      expect(readDeploymentRecord(rootOwned).reason).toContain(
        process.platform === "darwin" ? "does not hold exactly one account name" : ACL_UNCHECKED, // elsewhere the ACL check cannot run: untrusted
      );
    }
  });

  it("accountHome reads the OS account database, unmoved by HOME, USER or PATH", () => {
    const home = accountHome();
    expect(home).toBeDefined();
    // the same lookup in a child whose HOME/USER/PATH are poisoned
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(SCRIPT)}).then((m) => process.stdout.write(String(m.accountHome())))`,
      ],
      {
        env: { HOME: "/private/tmp/substitute", USER: "nobody", PATH: "/nonexistent" },
        encoding: "utf8",
      },
    );
    expect(r.stdout).toBe(String(home));
  });

  it("the proofs call sudo, id and sandbox-exec by ABSOLUTE path (the interpreter is pinned in required mode)", () => {
    const src = readFileSync(join(import.meta.dirname, "isolation.test.ts"), "utf8");
    expect(src).toContain('const SUDO = "/usr/bin/sudo";');
    expect(src).toContain('const ID = "/usr/bin/id";');
    expect(src).toContain('const SANDBOX_EXEC = "/usr/bin/sandbox-exec";');
    // no bare command names handed to a spawn
    expect(src).not.toMatch(/(spawn|spawnSync|execFileSync)\(\s*"(sudo|id|sandbox-exec)"/);
    expect(src).not.toMatch(/\[\s*"sudo",/);
  });
});
