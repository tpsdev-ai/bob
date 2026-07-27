import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport, runDoctor } from "../../src/shell/doctor.js";

// Build a complete-and-healthy agent layout for doctor to scan. Tests
// then delete/chmod individual pieces to drive specific failure paths.
function makeHealthyAgent(opts: { home: string; name: string }): {
  agentDir: string;
  flairKeysDir: string;
} {
  const agentDir = join(opts.home, "agents", opts.name);
  const flairKeysDir = join(opts.home, ".flair", "keys");
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
  mkdirSync(flairKeysDir, { recursive: true });
  mkdirSync(join(opts.home, ".tps", "mail", opts.name, "new"), { recursive: true });
  mkdirSync(join(opts.home, ".tps", "mail", opts.name, "cur"), { recursive: true });

  writeFileSync(join(agentDir, "soul.md"), "stub soul");
  writeFileSync(join(agentDir, "bob.yaml"), "agent:\n  id: testbot\n");

  const launcher = join(agentDir, "bin", opts.name);
  writeFileSync(launcher, "#!/bin/sh\necho ok\n");
  chmodSync(launcher, 0o755);

  const priv = join(flairKeysDir, `${opts.name}.key`);
  writeFileSync(priv, "stub private");
  chmodSync(priv, 0o600);
  writeFileSync(join(flairKeysDir, `${opts.name}.pub`), "stub public");

  const piAuth = join(agentDir, ".pi-agent", "auth.json");
  writeFileSync(piAuth, '{"anthropic": {"type": "api_key", "key": "x"}}');
  chmodSync(piAuth, 0o600);
  writeFileSync(join(agentDir, ".pi-agent", "models.json"), "{}");

  return { agentDir, flairKeysDir };
}

describe("runDoctor", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bob-doctor-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("all-green report for a healthy agent", () => {
    makeHealthyAgent({ home, name: "testbot" });
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    // skip is OK — pi auth/models may be absent for non-gateway providers
    expect(report.checks.some((c) => c.name === "soul.md" && c.status === "ok")).toBe(true);
    expect(report.checks.some((c) => c.name === "bob.yaml" && c.status === "ok")).toBe(true);
    expect(report.checks.some((c) => c.name === "launcher" && c.status === "ok")).toBe(true);
  });

  it("FAIL on missing agent dir — short-circuits subsequent checks", () => {
    const report = runDoctor({
      name: "ghostbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
    expect(report.checks[0].name).toBe("agent dir");
    expect(report.checks[0].status).toBe("fail");
    expect(report.checks[0].fix).toMatch(/bob onboard/);
  });

  it("FAIL on missing launcher", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    rmSync(join(agentDir, "bin", "testbot"));
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const launcher = report.checks.find((c) => c.name === "launcher");
    expect(launcher?.status).toBe("fail");
    expect(launcher?.fix).toMatch(/bob onboard.*--force/);
  });

  it("FAIL on non-executable launcher", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    chmodSync(join(agentDir, "bin", "testbot"), 0o644);
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const launcher = report.checks.find((c) => c.name === "launcher");
    expect(launcher?.status).toBe("fail");
    expect(launcher?.fix).toMatch(/chmod \+x/);
  });

  it("WARN on private key mode != 0600", () => {
    makeHealthyAgent({ home, name: "testbot" });
    chmodSync(join(home, ".flair", "keys", "testbot.key"), 0o644);
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const key = report.checks.find((c) => c.name === "Ed25519 private key");
    expect(key?.status).toBe("warn");
    expect(key?.fix).toMatch(/chmod 600/);
  });

  it("SKIP on absent pi auth/models (legitimate for non-gateway providers)", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    rmSync(join(agentDir, ".pi-agent", "auth.json"));
    rmSync(join(agentDir, ".pi-agent", "models.json"));
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.checks.find((c) => c.name === "pi auth.json")?.status).toBe("skip");
    expect(report.checks.find((c) => c.name === "pi models.json")?.status).toBe("skip");
  });

  it("WARN on pi auth.json mode != 0600 (contains API key)", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    chmodSync(join(agentDir, ".pi-agent", "auth.json"), 0o644);
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const auth = report.checks.find((c) => c.name === "pi auth.json");
    expect(auth?.status).toBe("warn");
    expect(auth?.fix).toMatch(/chmod 600/);
  });

  it("WARN on missing TPS mail inbox", () => {
    makeHealthyAgent({ home, name: "testbot" });
    rmSync(join(home, ".tps", "mail", "testbot"), { recursive: true });
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const mail = report.checks.find((c) => c.name === "TPS mail inbox");
    expect(mail?.status).toBe("warn");
  });

  it("rejects path-traversal in name", () => {
    expect(() =>
      runDoctor({
        name: "../../etc",
        homeDir: home,
      }),
    ).toThrow(/invalid agent name/);
  });

  it("counts mail items in new + cur", () => {
    makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(join(home, ".tps", "mail", "testbot", "new", "msg1.json"), "{}");
    writeFileSync(join(home, ".tps", "mail", "testbot", "cur", "msg2.json"), "{}");
    writeFileSync(join(home, ".tps", "mail", "testbot", "cur", "msg3.json"), "{}");
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const mail = report.checks.find((c) => c.name === "TPS mail inbox");
    expect(mail?.detail).toContain("new=1");
    expect(mail?.detail).toContain("cur=2");
  });
});

describe("formatReport", () => {
  it("renders an all-green report with 'All green.'", () => {
    const home = mkdtempSync(join(tmpdir(), "bob-doctor-fmt-"));
    try {
      makeHealthyAgent({ home, name: "testbot" });
      const report = runDoctor({
        name: "testbot",
        agentsRoot: join(home, "agents"),
        flairKeysDir: join(home, ".flair", "keys"),
        homeDir: home,
      });
      const out = formatReport(report);
      expect(out).toContain("[bob doctor testbot]");
      expect(out).toContain("All green.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("includes 'FAILING' summary line when any check fails", () => {
    const home = mkdtempSync(join(tmpdir(), "bob-doctor-fmt-"));
    try {
      const report = runDoctor({
        name: "ghostbot",
        agentsRoot: join(home, "agents"),
        flairKeysDir: join(home, ".flair", "keys"),
        homeDir: home,
      });
      const out = formatReport(report);
      expect(out).toMatch(/FAILING/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
