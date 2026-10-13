// bob#356 V1: a skipped or missing isolation proof never passes the release-host
// check. The gate turns a skip into a failure under BOB_REQUIRE_ISOLATION_PROOFS=1,
// and the check script requires every PINNED proof id to have passed.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHECK_ENV,
  checkEnv,
  EXPECTED_PROOFS,
  passedProofs,
  proofCounts,
  SUBSTITUTE_ROOTS,
  verdict,
} from "../../../scripts/check-reachy-isolation.mjs";
import {
  PINNED_INSTALL_DIR,
  proofDisposition,
  REQUIRE_ENV,
  releaseRoots,
} from "./isolation-gate.js";

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

  it("the proofs inherit only a minimal environment; substitute roots are never among it", () => {
    const env = checkEnv({
      PATH: "/usr/bin",
      HOME: "/Users/a",
      BOB_ISOLATION_AGENT: "rocky",
      BOB_REACHY_VOICE_DIR: "/tmp/fake-install",
      BOB_ISOLATION_AGENTS_ROOT: "/tmp/fake-agents",
      TPS_VAULT_KEY: "secret",
    });
    expect(env).toEqual({
      BOB_REQUIRE_ISOLATION_PROOFS: "1",
      PATH: "/usr/bin",
      HOME: "/Users/a",
      BOB_ISOLATION_AGENT: "rocky",
    });
    for (const k of SUBSTITUTE_ROOTS) expect(CHECK_ENV).not.toContain(k);
  });

  it("in required mode the roots are PINNED and a substitute root makes the proofs that read it fail", () => {
    const sub = { BOB_REACHY_VOICE_DIR: "/tmp/fake", BOB_ISOLATION_AGENTS_ROOT: "/tmp/agents" };
    const dev = releaseRoots(sub);
    expect(dev).toMatchObject({ installDir: "/tmp/fake", agentsRoot: "/tmp/agents", skip: "" });
    const required = releaseRoots({ ...sub, [REQUIRE_ENV]: "1" });
    expect(required.installDir).toBe(PINNED_INSTALL_DIR);
    expect(required.agentsRoot).not.toBe("/tmp/agents");
    expect(required.skip).toContain("BOB_REACHY_VOICE_DIR, BOB_ISOLATION_AGENTS_ROOT");
    expect(proofDisposition(required.skip, { [REQUIRE_ENV]: "1" })).toBe("fail");
    expect(releaseRoots({ [REQUIRE_ENV]: "1" }).skip).toBe("");
  });
});
