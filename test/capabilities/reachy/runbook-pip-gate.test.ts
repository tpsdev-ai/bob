import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { REQUIRE_ENV } from "./runbook-pip-gate.js";

it("CI test steps require real pip", () => {
  const workflow = parseYaml(
    readFileSync(join(import.meta.dirname, "../../../.github/workflows/ci.yml"), "utf8"),
  ) as {
    jobs: Record<string, { steps?: { run?: string; env?: Record<string, unknown> }[] }>;
  };
  const steps = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter(
      (step) =>
        typeof step.run === "string" &&
        /(?:^|[;&|\n])\s*bun\s+run\s+test(?:\s|$|[;&|])/.test(step.run),
    );
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) expect(step.env?.[REQUIRE_ENV]).toBe("1");
});

it("a failed Python probe fails the required pip case with its diagnostic", () => {
  const saved = process.env[REQUIRE_ENV];
  const dir = mkdtempSync(join(tmpdir(), "rv-pip-gate-"));
  try {
    const missing = join(dir, "missing-python");
    const fixture = join(dir, "probe.test.ts");
    writeFileSync(
      fixture,
      `import { pipCase, pythonWithPip } from ${JSON.stringify(join(import.meta.dirname, "runbook-pip-gate.ts"))};
pipCase("forced probe", pythonWithPip([${JSON.stringify(missing)}]), () => { throw new Error("case body ran"); });
`,
    );
    process.env[REQUIRE_ENV] = "1";
    const required = spawnSync(process.execPath, ["test", fixture], {
      env: process.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = `${required.stdout}${required.stderr}`;
    expect(required.status).toBe(1);
    expect(output).toContain(`real pip required (${REQUIRE_ENV}=1) but the probe failed:`);
    expect(output).toContain(`${missing}:`);
    expect(output).toContain("ENOENT");
    expect(output).toContain("1 fail");
    expect(output).not.toContain("error: case body ran");

    delete process.env[REQUIRE_ENV];
    const local = spawnSync(process.execPath, ["test", fixture], {
      env: process.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(local.status).toBe(0);
    expect(`${local.stdout}${local.stderr}`).toContain("1 skip");
  } finally {
    if (saved === undefined) delete process.env[REQUIRE_ENV];
    else process.env[REQUIRE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
