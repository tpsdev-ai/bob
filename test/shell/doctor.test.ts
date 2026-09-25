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
  // A healthy agent has a readable role + a tool allowlist: doctor FAILs a
  // missing policy now, so the healthy fixture must carry one (role ea allows
  // `read`).
  writeFileSync(
    join(agentDir, "bob.yaml"),
    [
      "agent:",
      "  id: testbot",
      "  name: Testbot",
      "  role: ea",
      "",
      "provider:",
      "  name: anthropic",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
    ].join("\n"),
  );

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

  it("FAIL + fix on an unmapped tool name in bob.yaml", () => {
    // Existing agents' bob.yaml carry the pre-fix names (Bash, Read,
    // WebFetch, mcp__plugin_discord_discord__reply). pi ignores unknown tool
    // names silently, so doctor has to name them and the replacement.
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: ea",
        "",
        "tools:",
        "  allow:",
        "    - Bash",
        "    - flair_search",
        "    - mcp__plugin_discord_discord__reply",
        "",
      ].join("\n"),
    );
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const check = report.checks.find((c) => c.name === "tool allowlist");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("Bash");
    expect(check?.detail).toContain("mcp__plugin_discord_discord__reply");
    expect(check?.fix).toContain("bash");
    expect(check?.fix).toContain("discord_reply");
  });

  it("FAIL when bob.yaml declares no tools: block at all", () => {
    // A missing policy is a FAIL, not "ok, pi's defaults apply": pi's defaults
    // are not a decision the config made, and a session on them holds whatever
    // pi ships.
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      ["agent:", "  id: testbot", "  role: ea", "", "provider:", "  name: anthropic", ""].join(
        "\n",
      ),
    );
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const check = report.checks.find((c) => c.name === "tool allowlist");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toMatch(/no tools: block/);
    expect(check?.fix).toMatch(/allow/);
  });

  it("FAIL when bob.yaml widens the allowlist past the role", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: ea",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "    - bash",
        "",
      ].join("\n"),
    );
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const check = report.checks.find((c) => c.name === "tool allowlist");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("bash");
    expect(check?.detail).toMatch(/role/);
  });

  it("OK on a bob.yaml whose tool allowlist is all real names", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: ea",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "    - flair_search",
        "    - discord_reply",
        "",
      ].join("\n"),
    );
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    expect(report.checks.find((c) => c.name === "tool allowlist")?.status).toBe("ok");
    expect(report.summary.fail).toBe(0);
  });

  it("WARN when a resident agent's allowlist lists tools the resident policy drops", () => {
    // qa, not coder: the coder role grants tools.allowResidentShell, so its
    // allowlist is not dropped. The warning is for a role that does NOT grant
    // it while its resident allowlist still lists a shell tool.
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: qa",
        "",
        "resident: true",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "    - bash",
        "",
      ].join("\n"),
    );
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const check = report.checks.find((c) => c.name === "tool allowlist");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("bash");
    expect(check?.fix).toContain("allowResidentShell");
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
