// bob#356 V1: a skipped isolation proof never passes a release. The gate turns
// a skip into a failure under BOB_REQUIRE_ISOLATION_PROOFS=1, and the release
// check script fails on any skip or failure it sees in the report.
import { describe, expect, it } from "bun:test";
import { proofCounts, verdict } from "../../../scripts/check-reachy-isolation.mjs";
import { proofDisposition, REQUIRE_ENV } from "./isolation-gate.js";

describe("bob#356 — the isolation-proof release gate", () => {
  it("a proof that can run, runs; one that cannot SKIPS locally and FAILS when required", () => {
    expect(proofDisposition("", {})).toBe("run");
    expect(proofDisposition("", { [REQUIRE_ENV]: "1" })).toBe("run");
    expect(proofDisposition("no sidecar user", {})).toBe("skip");
    expect(proofDisposition("no sidecar user", { [REQUIRE_ENV]: "1" })).toBe("fail");
    expect(proofDisposition("no sidecar user", { [REQUIRE_ENV]: "0" })).toBe("skip");
  });

  it("the release check passes only when every proof RAN and passed", () => {
    const report = (pass: number, skip: number, fail: number) =>
      `\n ${pass} pass\n ${skip} skip\n ${fail} fail\nRan ${pass + skip + fail} tests`;
    expect(proofCounts(report(6, 0, 0))).toEqual({ pass: 6, skip: 0, fail: 0 });
    expect(verdict(0, report(6, 0, 0)).ok).toBe(true);
    expect(verdict(0, report(2, 4, 0))).toMatchObject({ ok: false });
    expect(verdict(0, report(2, 4, 0)).why).toContain("skipped");
    expect(verdict(1, report(5, 0, 1)).ok).toBe(false);
    expect(verdict(0, report(0, 0, 0)).ok).toBe(false);
  });
});
