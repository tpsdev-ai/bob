// The web capability's doctor checks (bob#152, spec v3, slice R1c): the policy,
// the private-address and NAT64 refusals, and fetch health — and that they are
// wired into a real report.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, webChecks } from "../../src/shell/doctor.js";

const NAMES = ["web policy", "web address refusal", "web NAT64 refusal", "web fetch health"];

describe("webChecks", () => {
  it("reports nothing when the agent does not declare web", () => {
    expect(webChecks("capabilities: [fixture]\ntools:\n  allow: []\n")).toEqual([]);
    expect(webChecks(undefined)).toEqual([]);
  });

  it("reports the policy, both address refusals and fetch health for a valid block", () => {
    const yaml = [
      "capabilities: [web]",
      "web:",
      "  allow_http: false",
      "  fetch_max_chars: 20000",
      "  fetch_per_turn: 5",
      "  text_per_turn: 50000",
    ].join("\n");
    const checks = webChecks(yaml);
    expect(checks.map((c) => c.name)).toEqual(NAMES);
    for (const check of checks) expect(check.status).toBe("ok");
    expect(checks[0].detail).toContain("fetch_per_turn=5");
    expect(checks[3].detail).toContain("no network I/O");
  });

  it("fails the policy check when the block is invalid, and still reports the rest", () => {
    const yaml = ["capabilities: [web]", "web:", "  fetch_per_turn: 99"].join("\n");
    const checks = webChecks(yaml);
    const policy = checks.find((c) => c.name === "web policy");
    expect(policy?.status).toBe("fail");
    expect(policy?.detail).toContain("fetch_per_turn");
    // The address and fetch-health checks do not depend on the block.
    expect(checks.find((c) => c.name === "web fetch health")?.status).toBe("ok");
  });

  it("uses the block's defaults when the web block is absent but the capability is declared", () => {
    const checks = webChecks("capabilities: [web]\n");
    expect(checks.find((c) => c.name === "web policy")?.detail).toContain("fetch_per_turn=10");
  });
});

describe("runDoctor wiring", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bob-doctor-web-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("includes the web checks in a report for an agent that declares web", () => {
    const agentDir = join(home, "agents", "webagent");
    mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
    writeFileSync(join(agentDir, "soul.md"), "soul");
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: webagent",
        "  name: Webagent",
        "  role: reviewer",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-x",
        "  context_window: 262144",
        "",
        "capabilities: [web]",
        "web:",
        "  fetch_per_turn: 3",
        "",
        "tools:",
        "  allow: []",
        "",
      ].join("\n"),
    );
    const report = runDoctor({ name: "webagent", homeDir: home, agentsRoot: join(home, "agents") });
    const names = report.checks.map((c) => c.name);
    for (const name of NAMES) expect(names).toContain(name);
    expect(report.checks.find((c) => c.name === "web policy")?.detail).toContain(
      "fetch_per_turn=3",
    );
  });
});
