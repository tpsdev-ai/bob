#!/usr/bin/env bun
// bob#356 V1: the RELEASE check for the reachy-voice sidecar's isolation proofs.
//
// Run on the release host (the macOS machine the sidecar ships to, with the
// jarvis-sidecar user and its constrained `sudo -n` path provisioned — see
// sidecar/reachy-voice/RUNBOOK.md), from a checkout of the reviewed commit:
//
//   BOB_ISOLATION_ADMIN_PASS=<admin-pass path> \
//   BOB_ISOLATION_AGENT_KEY=<agent key path> \
//   bun run check:reachy-isolation
//
// It runs the isolation proofs with BOB_REQUIRE_ISOLATION_PROOFS=1, under which
// a proof that cannot run FAILS instead of skipping, and it fails again on any
// skip it sees in the report. A skipped proof never passes a release.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
export const PROOFS = ["test/capabilities/reachy/isolation.test.ts"];

/** The counts bun prints at the end of a run (`N pass`, `N skip`, `N fail`). */
export function proofCounts(report) {
  const count = (word) => {
    const m = new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(report);
    return m ? Number(m[1]) : 0;
  };
  return { pass: count("pass"), skip: count("skip"), fail: count("fail") };
}

/** The verdict on one run: ok only with every proof RUN and passing. */
export function verdict(status, report) {
  const { pass, skip, fail } = proofCounts(report);
  if (status !== 0 || fail > 0) return { ok: false, why: `${fail} proof(s) failed` };
  if (skip > 0)
    return { ok: false, why: `${skip} proof(s) skipped — a skipped proof fails release` };
  if (pass === 0) return { ok: false, why: "no proof ran" };
  return { ok: true, why: `${pass} proof(s) ran and passed` };
}

if (import.meta.main) {
  const r = spawnSync("bun", ["test", ...PROOFS], {
    cwd: ROOT,
    env: { ...process.env, BOB_REQUIRE_ISOLATION_PROOFS: "1" },
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
