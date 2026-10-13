// bob#355: `bob doctor` reports the host's bun version against the version
// package.json's packageManager declares (the version bob's lockfile is written
// with). A mismatch, a bun that cannot be read, and an absent or unparseable
// declaration each become a named finding before an install can fail.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUN_VERSION_CHECK,
  bunVersionFinding,
  declaredBunVersion,
  probeInstalledBun,
  runDoctor,
} from "../../src/shell/doctor.js";

describe("declaredBunVersion", () => {
  it("reads the version out of a bun packageManager", () => {
    expect(declaredBunVersion("bun@1.3.10")).toBe("1.3.10");
    expect(declaredBunVersion("  bun@1.3.10  ")).toBe("1.3.10");
    expect(declaredBunVersion("bun@1.3.10-rc.1")).toBe("1.3.10-rc.1");
  });

  it("is undefined for anything that is not a pinned bun", () => {
    expect(declaredBunVersion(undefined)).toBeUndefined();
    expect(declaredBunVersion(42)).toBeUndefined();
    expect(declaredBunVersion("pnpm@8.0.0")).toBeUndefined();
    expect(declaredBunVersion("bun")).toBeUndefined();
  });
});

describe("bunVersionFinding", () => {
  it("OK when the installed bun matches the declared one", () => {
    expect(
      bunVersionFinding({ packageManager: "bun@1.3.10", probe: { version: "1.3.10" } }),
    ).toEqual({
      name: BUN_VERSION_CHECK,
      status: "ok",
      detail: "bun 1.3.10 matches packageManager in package.json",
    });
  });

  it("FAILs a mismatch, naming the declared version's remedy", () => {
    const finding = bunVersionFinding({
      packageManager: "bun@1.3.10",
      probe: { version: "1.4.2" },
    });
    expect(finding.status).toBe("fail");
    expect(finding.detail).toContain("bun 1.4.2 does not match the declared bun 1.3.10");
    expect(finding.fix).toContain("npx -y bun@1.3.10 install --frozen-lockfile");
  });

  it("FAILs when bun cannot be read, naming the remedy, and never crashes", () => {
    const finding = bunVersionFinding({
      packageManager: "bun@1.3.10",
      probe: { error: "ENOENT" },
    });
    expect(finding.status).toBe("fail");
    expect(finding.detail).toContain("could not be read (ENOENT)");
    expect(finding.fix).toContain("npx -y bun@1.3.10 install --frozen-lockfile");
  });

  it("FAILs an absent declaration rather than passing", () => {
    const finding = bunVersionFinding({ packageManager: undefined, probe: { version: "1.3.10" } });
    expect(finding.status).toBe("fail");
    expect(finding.detail).toContain("declares packageManager not at all");
  });

  it("FAILs an unparseable declaration", () => {
    const finding = bunVersionFinding({ packageManager: "bun", probe: { version: "1.3.10" } });
    expect(finding.status).toBe("fail");
    expect(finding.detail).toContain('packageManager "bun"');
  });
});

describe("probeInstalledBun", () => {
  it("reads the version from the real bun on PATH", () => {
    const probe = probeInstalledBun();
    if ("error" in probe) throw new Error(`bun probe failed: ${probe.error}`);
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reports an error, not a version, when PATH has no bun", () => {
    const probe = probeInstalledBun("");
    expect("error" in probe).toBe(true);
  });
});

describe("runDoctor bun version check", () => {
  let home: string;
  const declared = (
    JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
      packageManager: string;
    }
  ).packageManager.replace(/^bun@/, "");

  function report(installedBunVersion?: string) {
    mkdirSync(join(home, "agents", "host-a"), { recursive: true });
    return runDoctor({
      name: "host-a",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
      ...(installedBunVersion !== undefined ? { installedBunVersion } : {}),
    });
  }

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("OK when the installed bun matches the declared version", () => {
    home = mkdtempSync(join(tmpdir(), "bob-doctor-bun-"));
    const check = report(declared).checks.find((c) => c.name === BUN_VERSION_CHECK);
    expect(check?.status).toBe("ok");
  });

  it("FAILs a mismatched installed bun", () => {
    home = mkdtempSync(join(tmpdir(), "bob-doctor-bun-"));
    const check = report("9.9.9").checks.find((c) => c.name === BUN_VERSION_CHECK);
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("bun 9.9.9 does not match");
    expect(check?.fix).toContain(`npx -y bun@${declared} install --frozen-lockfile`);
  });
});
