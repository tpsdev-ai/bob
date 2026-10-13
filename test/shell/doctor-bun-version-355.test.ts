// bob#355: `bob doctor` reports the host's bun version against the version
// package.json's packageManager declares (the version bob's lockfile is written
// with). Host-level, so it reports whether or not the agent exists. A mismatch,
// a bun that cannot be read, and a declaration that is absent or cannot be read
// or parsed each become a named finding.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUN_VERSION_CHECK,
  bunVersionFinding,
  declaredBunVersion,
  probeInstalledBun,
  readDeclaredBunVersion,
  runDoctor,
} from "../../src/shell/doctor.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = "bob-doctor-bun-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// A directory holding an executable `bun` that prints the given text. The real
// spawnSync runs it, so the probe's argv, exit and parse are all exercised.
function fakeBun(output: string): string {
  const dir = scratch("bob-fake-bun-");
  const bin = join(dir, "bun");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  chmodSync(bin, 0o755);
  return dir;
}

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

describe("readDeclaredBunVersion", () => {
  it("reads packageManager from a manifest", () => {
    const dir = scratch();
    const path = join(dir, "package.json");
    writeFileSync(path, '{"packageManager":"bun@1.3.10"}\n');
    expect(readDeclaredBunVersion(path)).toEqual({ packageManager: "bun@1.3.10" });
  });

  it("keeps the parse error of an invalid manifest", () => {
    const dir = scratch();
    const path = join(dir, "package.json");
    writeFileSync(path, "{ not json\n");
    const result = readDeclaredBunVersion(path);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("could not be parsed");
  });

  it("keeps the read error of an unreadable manifest, for every uid", () => {
    // A dangling symlink fails the read for root too, unlike mode 000.
    const dir = scratch();
    const path = join(dir, "package.json");
    symlinkSync(join(dir, "missing"), path);
    const result = readDeclaredBunVersion(path);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("could not be read");
  });
});

describe("bunVersionFinding", () => {
  const declaration = { packageManager: "bun@1.3.10" };

  it("OK when the installed bun matches the declared one", () => {
    expect(bunVersionFinding({ declaration, probe: { version: "1.3.10" } })).toEqual({
      name: BUN_VERSION_CHECK,
      status: "ok",
      detail: "bun 1.3.10 matches packageManager in package.json",
    });
  });

  it("FAILs a mismatch, naming the declared version's remedy", () => {
    const finding = bunVersionFinding({ declaration, probe: { version: "1.4.2" } });
    expect(finding.status).toBe("fail");
    expect(finding.detail).toContain("bun 1.4.2 does not match the declared bun 1.3.10");
    expect(finding.fix).toContain("npx -y bun@1.3.10 install --frozen-lockfile");
  });

  it("FAILs when bun cannot be read, naming the remedy, and never crashes", () => {
    const finding = bunVersionFinding({ declaration, probe: { error: "ENOENT" } });
    expect(finding.status).toBe("fail");
    expect(finding.detail).toContain("could not be read (ENOENT)");
    expect(finding.fix).toContain("npx -y bun@1.3.10 install --frozen-lockfile");
  });

  it("FAILs an absent declaration rather than passing", () => {
    const finding = bunVersionFinding({
      declaration: { packageManager: undefined },
      probe: { version: "1.3.10" },
    });
    expect(finding.status).toBe("fail");
    expect(finding.detail).toContain("declares packageManager not at all");
  });

  it("FAILs an unparseable declaration", () => {
    const finding = bunVersionFinding({
      declaration: { packageManager: "bun" },
      probe: { version: "1.3.10" },
    });
    expect(finding.status).toBe("fail");
    expect(finding.detail).toContain('packageManager "bun"');
  });

  it("FAILs an unreadable manifest with its read error, not an absent declaration", () => {
    const finding = bunVersionFinding({
      declaration: { error: "package.json could not be read: ENOENT" },
      probe: { version: "1.3.10" },
    });
    expect(finding.status).toBe("fail");
    expect(finding.detail).toContain("package.json could not be read: ENOENT");
    expect(finding.detail).not.toContain("not at all");
    expect(finding.fix).toContain("restore package.json");
  });
});

describe("probeInstalledBun", () => {
  it("reads the version from the real bun on PATH", () => {
    const probe = probeInstalledBun();
    if ("error" in probe) throw new Error(`bun probe failed: ${probe.error}`);
    expect(probe.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reports an error, not a version, when PATH has no bun", () => {
    expect("error" in probeInstalledBun("")).toBe(true);
  });

  it("reports an error when the output is not a whole version", () => {
    const probe = probeInstalledBun(fakeBun("1.3.10garbage"));
    expect("error" in probe).toBe(true);
    if ("error" in probe) expect(probe.error).toContain("printed");
  });
});

describe("runDoctor bun version check", () => {
  const declared = (
    JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
      packageManager: string;
    }
  ).packageManager.replace(/^bun@/, "");

  function report(installedBunVersion: string, withAgentDir = true) {
    const home = scratch();
    if (withAgentDir) mkdirSync(join(home, "agents", "host-a"), { recursive: true });
    return runDoctor({
      name: "host-a",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
      installedBunVersion,
    });
  }

  it("reports the installed bun even when the agent does not exist yet", () => {
    const result = report(declared, false);
    expect(result.checks.find((c) => c.name === BUN_VERSION_CHECK)?.status).toBe("ok");
    expect(result.checks.find((c) => c.name === "agent dir")?.status).toBe("fail");
  });

  it("OK when the installed bun matches the declared version", () => {
    const check = report(declared).checks.find((c) => c.name === BUN_VERSION_CHECK);
    expect(check?.status).toBe("ok");
  });

  it("FAILs a mismatched installed bun", () => {
    const check = report("9.9.9").checks.find((c) => c.name === BUN_VERSION_CHECK);
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("bun 9.9.9 does not match");
    expect(check?.fix).toContain(`npx -y bun@${declared} install --frozen-lockfile`);
  });
});
