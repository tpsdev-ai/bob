// bob#356 round 3 — the ACTUAL release-host gate (scripts/check-reachy-isolation.mjs),
// run as a process with a poisoned environment:
//   * a substitute HOME is REFUSED before any proof runs (the account home comes
//     from the OS account database, not from HOME);
//   * a poisoned PATH is IGNORED: the gate pins PATH for the proofs, and every
//     proof calls host binaries by absolute path — programs planted first on the
//     caller's PATH are never executed;
//   * the account is the deployment record's, not the caller's: without a
//     trusted record naming the running account, the proofs that read bob's
//     tree FAIL (a caller-supplied account name is ignored).
// Locally the proofs themselves fail (no sidecar user), which is the gate's
// correct verdict here; what these tests check is what the gate does with the
// environment it is given.
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountHome, DEPLOYMENT_RECORD } from "../../../scripts/check-reachy-isolation.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const GATE = join(REPO, "scripts", "check-reachy-isolation.mjs");
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function gate(env: Record<string, string>) {
  return spawnSync(process.execPath, [GATE], {
    cwd: REPO,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("bob#356 round 3 — the actual release-host gate under a poisoned environment", () => {
  it("a POISONED HOME is refused before any proof runs", () => {
    const home = accountHome();
    expect(home).toBeDefined();
    const substitute = mkdtempSync(join(tmpdir(), "rv-substitute-home-"));
    scratch.push(substitute);
    const r = gate({
      HOME: substitute,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      BOB_ISOLATION_AGENT: "rocky",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      `reachy-voice isolation release check: FAIL — HOME (${substitute}) conflicts with the account home (${home})`,
    );
    expect(r.stdout).not.toContain("Ran "); // no proof ran
  });

  it("a POISONED PATH is ignored: no program planted on the caller's PATH runs", () => {
    const home = accountHome();
    const poison = mkdtempSync(join(tmpdir(), "rv-poison-path-"));
    scratch.push(poison);
    const marker = join(poison, "INVOKED");
    for (const name of ["id", "sudo", "python3", "sandbox-exec", "true", "bun", "getent"]) {
      const f = join(poison, name);
      writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${marker}"\nexit 0\n`);
      chmodSync(f, 0o755);
    }
    const r = gate({
      HOME: String(home),
      PATH: `${poison}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: tmpdir(),
    });
    expect(r.stdout).toContain("Ran "); // the proofs did run
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe(""); // nothing planted ran
    if (process.platform === "darwin") expect(r.stdout).toMatch(/^\(pass\) .*\[P1\]/m);
    expect(r.status).toBe(1); // here: the separate-user proofs cannot run
  }, 120_000);

  it("an interpreter other than the pinned /usr/bin/python3 is refused before any proof runs", () => {
    const r = gate({
      HOME: String(accountHome()),
      PATH: "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      BOB_REACHY_VOICE_PYTHON: "/opt/homebrew/bin/python3", // any other interpreter
    });
    expect(r.stdout).toContain(
      "the release host's interpreter is pinned to /usr/bin/python3; unset BOB_REACHY_VOICE_PYTHON",
    );
    expect(r.stdout).not.toContain("Ran ");
    expect(r.status).toBe(1);
  });

  it("without a trusted deployment record naming the running account, the proofs that read bob's tree FAIL", () => {
    // A caller cannot name an account: the gate has no such input. Here (no
    // record, or one naming another account) the root-reading proofs fail
    // with the record's reason, and the gate fails.
    const r = gate({
      HOME: String(accountHome()),
      PATH: "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      BOB_ISOLATION_AGENT: "rocky",
      BOB_ISOLATION_AGENT_USER: "root", // an attempt to name an account: ignored
    });
    expect(r.status).toBe(1);
    const why = existsSync(DEPLOYMENT_RECORD)
      ? "from the deployment record"
      : `the deployment record ${DEPLOYMENT_RECORD} is missing`;
    const p6 = r.stdout.split("\n").filter((l) => l.includes("[P6]"));
    expect(
      p6.some((l) => l.includes("REQUIRED, cannot run:") && l.includes(why)),
      p6.join("\n"),
    ).toBe(true);
    expect(r.stdout).toMatch(/reachy-voice isolation release check: FAIL/);
  }, 120_000);
});
