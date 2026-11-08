import { it } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REQUIRE_ENV = "BOB_REQUIRE_RUNBOOK_PIP";

type PipProbe = { python?: string; reason: string };

export function pythonWithPip(
  candidates: readonly string[] = ["/usr/bin/python3", "python3"],
): PipProbe {
  const prefix = join(tmpdir(), "rv-pip-probe-prefix");
  const failures: string[] = [];
  for (const py of candidates) {
    const r = spawnSync(
      py,
      [
        "-I",
        "-B",
        "-X",
        `pycache_prefix=${prefix}`,
        "-c",
        `import sys, pip; assert sys.pycache_prefix == ${JSON.stringify(prefix)}`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (r.status === 0) return { python: py, reason: "" };
    failures.push(
      `${py}: ${r.error?.message ?? `exit ${r.status}, signal ${r.signal ?? "none"}`}${r.stderr?.trim() ? `: ${r.stderr.trim()}` : ""}`,
    );
  }
  return { reason: failures.join("; ") };
}

export function pipCase(
  name: string,
  probe: PipProbe,
  fn: () => unknown | Promise<unknown>,
  timeoutMs?: number,
): void {
  if (probe.python) {
    it(name, fn, timeoutMs);
  } else if (process.env[REQUIRE_ENV] === "1") {
    it(`${name} — REQUIRED, cannot run: ${probe.reason}`, () => {
      throw new Error(`real pip required (${REQUIRE_ENV}=1) but the probe failed: ${probe.reason}`);
    });
  } else {
    it.skip(`${name} (skipped: Python/pip probe failed)`, fn);
  }
}
