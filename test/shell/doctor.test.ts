import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
import { formatReport, runDoctor } from "../../src/shell/doctor.js";
import { MailConsumer, tpsMailStatsPath } from "../../src/shell/mail-consumer.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { sessionModelLimits } from "../../src/shell/session.js";
import {
  keyResolver,
  mailRecord,
  signTestEnvelope,
  testKey,
  writeRecord,
} from "../capabilities/tps-mail/helpers.js";

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
  // missing policy now, so the healthy fixture must carry one (the reviewer
  // role allows `read`; ea/jarvis no longer do, bob#230).
  writeFileSync(
    join(agentDir, "bob.yaml"),
    [
      "agent:",
      "  id: testbot",
      "  name: Testbot",
      "  role: reviewer",
      "",
      "provider:",
      "  name: anthropic",
      "  model: claude-x",
      "  context_window: 262144",
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

  it("OK on a bob.yaml whose tool allowlist is all real names the agent can have", () => {
    // `flair_search` is a real name AND this agent declares flair, so the
    // session would hold it (round 3 reports a capability tool whose
    // capability is not declared as a FAIL, so the OK case has to declare it).
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "    - flair_search",
        "",
        "capabilities:",
        "  - flair",
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
    // The grant lives in the ROLE, not in bob.yaml (round 3): bob.yaml may only
    // narrow the role, so an advice line telling the user to set
    // tools.allowResidentShell: true in bob.yaml would send them into a load
    // error. Name roles/<role>/role.json.
    expect(check?.fix).toContain("allowResidentShell");
    expect(check?.fix).toContain("roles/qa/role.json");
    expect(check?.fix).not.toMatch(/set tools\.allowResidentShell: true to keep them/);
  });

  it("FAIL — not WARN — when a resident agent trips both the drop and an undeclared capability tool", () => {
    // Both conditions at once: the resident policy drops `bash`, AND
    // `flair_search` needs a capability this agent does not declare. The
    // missing capability is the FAILURE — the session refuses it at load — so
    // it must not be buried under the resident warning, which is only advice.
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
        "    - flair_search",
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
    expect(check?.detail).toContain("flair_search");
    expect(check?.detail).toContain("flair");
    expect(check?.fix).toContain("capabilities:");
  });

  it("does not require a capability for a tool bob.yaml removes (the session drops it first)", () => {
    // `flair_search` is allowlisted AND excluded: the session's audit skips a
    // name the denylist removes (absent on purpose), so doctor must not fail a
    // valid narrowed policy for a capability the agent does not need.
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "    - flair_search",
        "  exclude:",
        "    - flair_search",
        "",
      ].join("\n"),
    );
    const report = runDoctor({ name: "testbot", agentsRoot: join(home, "agents") });
    const check = report.checks.find((c) => c.name === "tool allowlist");
    expect(check?.status).toBe("ok");
  });

  it("names the explicit bob.yaml denial in the resident-shell fix", () => {
    // The coder role GRANTS tools.allowResidentShell, so the resolver would keep
    // `bash` — except bob.yaml sets the flag `false`, which narrows the grant
    // away. Setting the role's grant to true would not restore the tools, so
    // the fix has to name the denial too.
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: coder",
        "",
        "resident: true",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "    - bash",
        "  allowResidentShell: false",
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
    expect(check?.fix).toContain("roles/coder/role.json");
    expect(check?.fix, "the bob.yaml denial is named").toContain("tools.allowResidentShell: false");
    expect(check?.fix).toContain("bob.yaml");
  });

  it("FAIL when an allowlisted capability tool's capability is not declared", () => {
    // A name can be real in bob's catalog and still not exist for THIS agent:
    // pi enables only what the loaded capabilities register, and a session
    // refuses such a name at load (round 3's audit). Doctor must not report OK
    // for a config whose next run fails.
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        `  role: ea`,
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-x",
        "",
        "tools:",
        "  allow:",
        "    - discord_reply",
        "",
        "capabilities:",
        "  - flair",
        "",
      ].join("\n"),
    );
    const report = runDoctor({ name: "testbot", agentsRoot: join(home, "agents") });
    const check = report.checks.find((c) => c.name === "tool allowlist");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("discord_reply");
    expect(check?.detail).toContain("discord");
    expect(check?.fix).toContain("capabilities:");
  });

  it("OK when the capability an allowlisted tool needs IS declared", () => {
    // The flair capability is declared in the scaffold, so its tools are fine.
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-x",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "    - flair_search",
        "",
        "capabilities:",
        "  - flair",
        "",
      ].join("\n"),
    );
    const report = runDoctor({ name: "testbot", agentsRoot: join(home, "agents") });
    const check = report.checks.find((c) => c.name === "tool allowlist");
    expect(check?.status).toBe("ok");
  });

  it("WARNs when a resident agent holds read beside a chat capability (bob#230)", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "resident: true",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
        "capabilities:",
        "  - discord",
        "",
        "discord:",
        "  tokenFile: /tmp/bob-test.token",
        "  channelIds:",
        '    - "123"',
        "",
      ].join("\n"),
    );
    const report = runDoctor({ name: "testbot", agentsRoot: join(home, "agents") });
    const check = report.checks.find((c) => c.name === "tool allowlist");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("read");
    expect(check?.detail).toContain("discord");
  });

  // bob#230: an inbound chat capability is served only by the persistent
  // runtime, which is resident by definition — so doctor judges a chat-facing
  // agent by the policy its service holds, `resident: true` or not.
  function chatAgentYaml(opts: { resident: boolean; tools: string[] }): string {
    return [
      "agent:",
      "  id: testbot",
      "  role: reviewer",
      "",
      ...(opts.resident ? ["resident: true", ""] : []),
      "tools:",
      "  allow:",
      ...opts.tools.map((t) => `    - ${t}`),
      "",
      "capabilities:",
      "  - discord",
      "",
      "discord:",
      "  tokenFile: /tmp/bob-test.token",
      "  channelIds:",
      '    - "123"',
      "",
    ].join("\n");
  }

  it("WARNs on read beside discord even WITHOUT `resident: true` (the persistent service) (bob#230)", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(join(agentDir, "bob.yaml"), chatAgentYaml({ resident: false, tools: ["read"] }));
    const report = runDoctor({ name: "testbot", agentsRoot: join(home, "agents") });
    const check = report.checks.find((c) => c.name === "tool allowlist");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("persistent service");
    expect(check?.detail).toMatch(/holds read alongside an inbound chat capability \(discord\)/);
    expect(check?.fix).toContain("drop read from tools.allow");
  });

  it("reports BOTH the dropped writer tool and read-beside-discord when both apply (bob#230)", () => {
    for (const resident of [false, true]) {
      const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
      writeFileSync(
        join(agentDir, "bob.yaml"),
        chatAgentYaml({ resident, tools: ["read", "bash"] }),
      );
      const report = runDoctor({ name: "testbot", agentsRoot: join(home, "agents") });
      const check = report.checks.find((c) => c.name === "tool allowlist");
      expect(check?.status, `resident: ${resident}`).toBe("warn");
      // The dropped writer tool …
      expect(check?.detail, `resident: ${resident}`).toMatch(/drops bash, which the role allows/);
      expect(check?.fix).toContain("roles/reviewer/role.json");
      // … does not hide the read-and-chat warning.
      expect(check?.detail, `resident: ${resident}`).toMatch(
        /holds read alongside an inbound chat capability \(discord\)/,
      );
      expect(check?.fix).toContain("drop read from tools.allow");
    }
  });

  it("stays quiet when the resident agent does NOT allow read (bob#230)", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: ea",
        "",
        "resident: true",
        "",
        "tools:",
        "  allow:",
        "    - discord_reply",
        "",
        "capabilities:",
        "  - discord",
        "",
        "discord:",
        "  tokenFile: /tmp/bob-test.token",
        "  channelIds:",
        '    - "123"',
        "",
      ].join("\n"),
    );
    const report = runDoctor({ name: "testbot", agentsRoot: join(home, "agents") });
    expect(report.checks.find((c) => c.name === "tool allowlist")?.status).toBe("ok");
  });

  it("stays quiet when no chat capability is declared (bob#230)", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "resident: true",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
    );
    const report = runDoctor({ name: "testbot", agentsRoot: join(home, "agents") });
    expect(report.checks.find((c) => c.name === "tool allowlist")?.status).toBe("ok");
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

  // bob#225 (item 4): a session for bob.yaml's provider.model refuses to start
  // without provider.context_window (bob does not guess a window; a guess can
  // disagree with the server). Doctor reports it during doctor, with the exact line to add.
  it("OK when bob.yaml declares provider.model and provider.context_window", () => {
    makeHealthyAgent({ home, name: "testbot" });
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const c = report.checks.find((x) => x.name === "provider.context_window");
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("262144");
    expect(c?.detail).toContain("claude-x");
  });

  it("FAIL when bob.yaml declares provider.model but no provider.context_window, naming the exact line to add", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: ea",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-x",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
    );
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const c = report.checks.find((x) => x.name === "provider.context_window");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toMatch(/provider\.context_window is not declared/);
    expect(c?.detail).toContain("claude-x");
    expect(c?.detail).toMatch(/refuses to start/);
    // The remedy is the exact line to add, in this agent's bob.yaml.
    expect(c?.fix).toBe(
      `add "context_window: <tokens>" under "provider:" in ${join(agentDir, "bob.yaml")}`,
    );
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
  });

  it("SKIPs the window check when bob.yaml declares no provider.model to key it to", () => {
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
    const c = report.checks.find((x) => x.name === "provider.context_window");
    expect(c?.status).toBe("skip");
  });

  // provider.model is read the way the session resolver reads it (the scalar
  // text), not as a parsed YAML type: `model: 123` is the model "123".
  it("reads provider.model as the session resolver does: `model: 123` with no window FAILs, and a session refuses it", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "provider:",
        "  name: anthropic",
        "  model: 123",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
    );
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const c = report.checks.find((x) => x.name === "provider.context_window");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("not declared for 123");
    expect(c?.fix).toBe(
      `add "context_window: <tokens>" under "provider:" in ${join(agentDir, "bob.yaml")}`,
    );

    // The resolver's outcome for the same file: model "123", and the session
    // refuses it for the undeclared window.
    const resolved = resolveRunConfig({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      hostRoot: join(home, ".bob", "host"),
    });
    expect(resolved.model).toBe("123");
    expect(() => sessionModelLimits(resolved.config)).toThrow(/without a declared context window/);
  });

  it("SKIPs, not OK, a declared window when bob.yaml declares no provider.model (the resolver refuses the missing model first)", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "provider:",
        "  name: anthropic",
        "  context_window: 262144",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
    );
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const c = report.checks.find((x) => x.name === "provider.context_window");
    expect(c?.status).toBe("skip");
    expect(c?.detail).toBe("no provider.model declared");

    expect(() =>
      resolveRunConfig({
        name: "testbot",
        agentsRoot: join(home, "agents"),
        hostRoot: join(home, ".bob", "host"),
      }),
    ).toThrow(/missing provider\.name and\/or provider\.model/);
  });

  it("FAILs, not SKIPs, when bob.yaml cannot be read, with a readable-file remedy", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    const yamlPath = join(agentDir, "bob.yaml");
    chmodSync(yamlPath, 0o000);
    try {
      const report = runDoctor({
        name: "testbot",
        agentsRoot: join(home, "agents"),
        flairKeysDir: join(home, ".flair", "keys"),
        homeDir: home,
      });
      const c = report.checks.find((x) => x.name === "provider.context_window");
      expect(c?.status).toBe("fail");
      expect(c?.detail).toContain(`${yamlPath} unreadable`);
      expect(c?.detail).toContain("the context window cannot be checked");
      expect(c?.fix).toBe(
        `make ${yamlPath} a regular file this user can read, then re-run bob doctor`,
      );
      // The bob.yaml file check stats the file and does not read it, so it
      // alone would not report this.
      expect(report.checks.find((x) => x.name === "bob.yaml")?.status).toBe("ok");
      expect(report.summary.fail).toBeGreaterThanOrEqual(1);
    } finally {
      chmodSync(yamlPath, 0o600);
    }
  });

  it("FAILs an unparseable provider: block before choosing a model or window outcome (no SKIP for the missing model)", () => {
    const { agentDir } = makeHealthyAgent({ home, name: "testbot" });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "provider:",
        "  name: anthropic",
        "  context_window: 262144",
        "  context_windw: 1",
        "",
        "tools:",
        "  allow:",
        "    - read",
        "",
      ].join("\n"),
    );
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
    });
    const c = report.checks.find((x) => x.name === "provider.context_window");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain('unknown key "context_windw"');
    expect(c?.fix).toBe("fix the shape of the provider: block in bob.yaml");
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

// ─── tps-mail (bob#200 §6, §7; F2, F9, F10; #134) ───────────────────────────
//
// ACCEPTANCE (doctor half): "an empty allow-list makes the capability refuse
// to load, and doctor fails" — (d2).

// `tps mail --help` as a CLI that takes the reply contract prints it (the
// relevant lines of tpsdev-ai/cli main after #431), and as 0.7.0 prints it.
const TPS_MAIL_USAGE_WITH_CONTRACT = [
  "Usage:",
  "  tps mail send <agent> <message>   Send signed mail to a local or remote agent",
  "  tps mail send <agent> --stdin [--reply-to <messageId>]  Read the body from stdin; --reply-to threads it to a signed messageId",
  "  tps mail check [agent]             Read available messages (leases processing)",
  "",
].join("\n");
const TPS_MAIL_USAGE_070 = [
  "Usage:",
  "  tps mail send <agent> <message>   Send mail to a local or remote agent",
  "  tps mail check [agent]             Read available messages (leases processing)",
  "",
].join("\n");

describe("runDoctor — tps-mail", () => {
  let home: string;
  let pathDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bob-doctor-mail-"));
    makeHealthyAgent({ home, name: "testbot" });
    // A fake tps on a private PATH (never the real CLI), an office identity so
    // this host is a delivery target, and the tps-mail capability declared.
    pathDir = join(home, "bin");
    mkdirSync(pathDir, { recursive: true });
    fakeTps(TPS_MAIL_USAGE_WITH_CONTRACT);
    mkdirSync(join(home, ".tps", "identity"), { recursive: true });
    writeFileSync(join(home, ".tps", "identity", "host.seed"), "stub");
    writeYaml({});
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // A fake tps on the private PATH: `tps mail --help` prints `usage` (from a
  // file, so no quoting is involved) and exits `code`; any other argv exits 0.
  function fakeTps(usage: string, code = 0, extra = "") {
    writeFileSync(join(pathDir, "tps-usage.txt"), usage);
    writeFileSync(
      join(pathDir, "tps"),
      `#!/bin/sh\n${extra}if [ "$1" = mail ] && [ "$2" = --help ]; then /bin/cat "${join(pathDir, "tps-usage.txt")}"; exit ${code}; fi\nexit 0\n`,
    );
    chmodSync(join(pathDir, "tps"), 0o755);
  }

  function writeYaml(o: {
    senders?: string[];
    flair?: boolean;
    capability?: boolean;
    legacy?: boolean;
  }) {
    const senders = o.senders ?? ["flint"];
    writeFileSync(
      join(home, "agents", "testbot", "bob.yaml"),
      [
        "agent:",
        "  id: testbot",
        "  role: reviewer",
        "",
        "provider:",
        "  name: anthropic",
        "",
        ...(o.legacy ? ["channels:", "  tps_mail:", "    inbox: ~/.tps/mail/testbot", ""] : []),
        "tools:",
        "  allow:",
        "    - read",
        "",
        ...(o.capability === false ? [] : ["capabilities:", "  - tps-mail", ""]),
        ...(o.capability === false
          ? []
          : [
              "tps-mail:",
              "  inbox: ~/.tps/mail/testbot",
              "  senders:",
              ...senders.map((s) => `    - ${s}`),
              "",
            ]),
        ...(o.flair === false
          ? []
          : [
              "flair:",
              "  url: http://127.0.0.1:19926",
              "  agentId: testbot",
              "  keyFile: ~/.flair/keys/testbot.key",
              "",
            ]),
      ].join("\n"),
    );
  }

  const doctor = (pathEnv?: string) =>
    runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
      pathEnv: pathEnv ?? pathDir,
    });
  const check = (report: ReturnType<typeof runDoctor>, name: string) =>
    report.checks.find((c) => c.name === name);

  it("(d1) a configured tps-mail agent on a delivery target is green", () => {
    const report = doctor();
    expect(report.summary.fail).toBe(0);
    expect(check(report, "tps-mail config")?.detail).toContain("flint");
    expect(check(report, "tps-mail inbox")?.status).toBe("ok");
    expect(check(report, "tps-mail delivery")?.status).toBe("ok");
    expect(check(report, "tps-mail reply transport")?.detail).toBe(join(pathDir, "tps"));
    // The capability's own inbox check replaces the generic one.
    expect(check(report, "TPS mail inbox")).toBeUndefined();
  });

  it("(d2) FAILS on an empty senders allow-list", () => {
    writeYaml({ senders: [] });
    const report = doctor();
    const c = check(report, "tps-mail config");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toMatch(/\/senders/);
    expect(report.summary.fail).toBeGreaterThan(0);
  });

  it("(d3) FAILS on a channels.tps_mail nothing honours (the old onboard scaffold)", () => {
    writeYaml({ capability: false, legacy: true });
    const c = check(doctor(), "tps-mail");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("looks mail-capable and is not");
  });

  it("(d4) FAILS when the inbox is missing", () => {
    rmSync(join(home, ".tps", "mail", "testbot"), { recursive: true });
    expect(check(doctor(), "tps-mail inbox")?.status).toBe("fail");
  });

  it("(d5) FAILS when this host is not a TPS delivery target (#134)", () => {
    rmSync(join(home, ".tps", "identity"), { recursive: true });
    const c = check(doctor(), "tps-mail delivery");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("not a TPS delivery target");
  });

  it("a joined branch is a target; a stopped branch daemon WARNs", () => {
    rmSync(join(home, ".tps", "identity", "host.seed"));
    writeFileSync(join(home, ".tps", "identity", "host.json"), "{}");
    expect(check(doctor(), "tps-mail delivery")?.status).toBe("warn");
    writeFileSync(join(home, ".tps", "branch.pid"), String(process.pid));
    expect(check(doctor(), "tps-mail delivery")?.status).toBe("ok");
  });

  it("(d6) FAILS when the tps CLI is not on PATH, or the signing key is missing", () => {
    const noTps = doctor(join(home, "empty-path"));
    expect(check(noTps, "tps-mail reply transport")?.status).toBe("fail");
    // No CLI, nothing to probe: the transport failure is the report.
    expect(check(noTps, "tps-mail reply contract")).toBeUndefined();
    rmSync(join(home, ".flair", "keys", "testbot.key"));
    const c = check(doctor(), "tps-mail reply transport");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("unsigned");
  });

  it("(d7) FAILS when the agent has no Flair identity to verify and sign with", () => {
    writeYaml({ flair: false });
    expect(check(doctor(), "tps-mail identity")?.status).toBe("fail");
  });

  it("(d8) surfaces refused counts per reason, dispatch failures and reply failures", () => {
    const refused = join(home, ".tps", "mail", "testbot", "refused");
    mkdirSync(refused, { recursive: true });
    writeFileSync(join(refused, "a.json"), "{}");
    writeFileSync(join(refused, "a.json.reason"), "reason: bad-signature\n");
    writeFileSync(join(refused, "b.json"), "{}");
    writeFileSync(join(refused, "b.json.reason"), "reason: sender-not-allowed\n");
    mkdirSync(join(home, ".bob"), { recursive: true });
    writeFileSync(
      join(home, ".bob", "testbot.tps-mail-stats.json"),
      JSON.stringify({
        replied: 3,
        noReply: 1,
        dispatchFailed: 2,
        timeouts: 1,
        replyFailed: { "cli-missing": 4 },
        verifyUnavailable: 0,
        markerFailed: 1,
      }),
    );
    const c = check(doctor(), "tps-mail activity");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("refused=2");
    expect(c?.detail).toContain("bad-signature=1");
    expect(c?.detail).toContain("sender-not-allowed=1");
    expect(c?.detail).toContain("dispatch failures=2 (timeouts 1)");
    expect(c?.detail).toContain("reply failures=4 (cli-missing=4)");
    expect(c?.detail).toContain("marker failures=1");
  });

  // Gauge round 6, blocker 1: doctor probes the ACTUAL replied/ directory — it
  // can sit on another filesystem than the inbox root. A replied/ that cannot
  // be opened for fsync (here: unreadable) fails, while the root is fine.
  it("(d9) FAILS when the replied/ directory itself cannot be fsynced, even though the inbox root can", () => {
    const replied = join(home, ".tps", "mail", "testbot", "replied");
    mkdirSync(replied, { recursive: true });
    chmodSync(replied, 0o000);
    try {
      const c = check(doctor(), "tps-mail inbox");
      expect(c?.status).toBe("fail");
      expect(c?.detail).toContain(`${replied}: cannot fsync the directory`);
    } finally {
      chmodSync(replied, 0o700);
    }
    expect(check(doctor(), "tps-mail inbox")?.detail).toContain("replied/ can fsync a directory");
  });

  // Round 7: doctor inspects the ACTUAL replied/ entry without following it.
  it("(d11) FAILS a replied/ that is a BROKEN symlink — never falls back to the healthy root", () => {
    const replied = join(home, ".tps", "mail", "testbot", "replied");
    symlinkSync(join(home, "no-such-dir"), replied);
    const c = check(doctor(), "tps-mail inbox");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain(`${replied}: cannot fsync the directory (a broken symlink)`);
  });

  it("(d12) FAILS a replied/ that is not a directory", () => {
    const replied = join(home, ".tps", "mail", "testbot", "replied");
    writeFileSync(replied, "a regular file");
    const c = check(doctor(), "tps-mail inbox");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain(`${replied}: cannot fsync the directory (not a directory)`);
  });

  // Round 7: an exhausted reap that fires AFTER stop() reaches doctor, which
  // reads the stats FILE.
  it("(d13) an exhausted reap after stop() is visible to doctor", async () => {
    const inbox = join(home, ".tps", "mail", "testbot");
    const flint = testKey();
    writeRecord(
      inbox,
      "1.json",
      mailRecord(
        signTestEnvelope({ from: "flint", to: "testbot", body: "x", messageId: "m-1" }, flint),
      ),
    );
    const launcher = join(home, "launcher");
    writeFileSync(
      launcher,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{"bobMailTurn":1,"outcome":"final","text":"ok"}'\nexit 0\n`,
    );
    chmodSync(launcher, 0o755);
    const consumer = new MailConsumer({
      name: "testbot",
      identity: "testbot",
      inboxRoot: inbox,
      senders: ["flint"],
      resolveKey: keyResolver({ flint }),
      launcherPath: launcher,
      lockFile: join(home, ".bob", "testbot.lock"),
      statsFile: tpsMailStatsPath(home, "testbot"),
      pollIntervalMs: 60_000,
      log: () => {},
      sendReply: async () => ({ ok: true }),
      turnRunner: {
        killGraceMs: 50,
        reapLimitMs: 150,
        groupOps: { exists: () => true, signal: () => {} }, // a group that never goes away
      },
    });
    consumer.start();
    await consumer.poll();
    await consumer.stop(); // its last stats write happens BEFORE the reap gives up
    const deadline = Date.now() + 3000;
    while (consumer.stats.reapExhausted === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(consumer.stats.reapExhausted).toBe(1);
    expect(check(doctor(), "tps-mail activity")?.detail).toContain("reap exhausted=1");
  }, 10_000);

  it("(d10) surfaces mail HELD for inspection, marker read failures and an exhausted reap", () => {
    const heldDir = join(home, ".tps", "mail", "testbot", "held");
    mkdirSync(heldDir, { recursive: true });
    writeFileSync(join(heldDir, "h.json"), "{}");
    writeFileSync(join(heldDir, "h.json.reason"), "reason: marker-malformed\n");
    mkdirSync(join(home, ".bob"), { recursive: true });
    writeFileSync(
      join(home, ".bob", "testbot.tps-mail-stats.json"),
      JSON.stringify({
        markerReadFailed: 2,
        reapExhausted: 1,
        resultCollectedAfterReapExhausted: 1,
      }),
    );
    const c = check(doctor(), "tps-mail activity");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("held for inspection=1 (marker-malformed=1)");
    expect(c?.detail).toContain("marker read failures=2");
    expect(c?.detail).toContain("reap exhausted=1");
    expect(c?.detail).toContain("result collected after reap exhaustion=1");
  });

  // The reply contract (tpsdev-ai/cli#431): bob replies with `tps mail send
  // <to> --stdin --reply-to <messageId>`, so doctor asks the tps on PATH
  // whether it takes that. Every unknown answer FAILS; none passes.
  it("(rc1) a tps whose mail usage names --stdin and --reply-to passes", () => {
    const report = doctor();
    const c = check(report, "tps-mail reply contract");
    expect(c?.status).toBe("ok");
    expect(c?.detail).toBe(`${join(pathDir, "tps")} takes 'mail send --stdin --reply-to'`);
    expect(report.summary.fail).toBe(0);
  });

  it("(rc2) a 0.7.0-shaped tps (no --stdin, no --reply-to) FAILS naming both flags and the remedy", () => {
    fakeTps(TPS_MAIL_USAGE_070);
    const report = doctor();
    const c = check(report, "tps-mail reply contract");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("names no --stdin or --reply-to");
    expect(c?.detail).toContain("every reply would fail closed");
    expect(c?.fix).toContain("tpsdev-ai/cli#431");
    expect(report.summary.fail).toBeGreaterThan(0);
    // The CLI and the key are there: only the contract fails.
    expect(check(report, "tps-mail reply transport")?.status).toBe("ok");
  });

  it("(rc3) a usage naming only --stdin FAILS naming --reply-to", () => {
    fakeTps("  tps mail send <agent> --stdin   Read the body from stdin\n");
    const c = check(doctor(), "tps-mail reply contract");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("names no --reply-to");
  });

  it("(rc4) a probe that exits non-zero FAILS, even when its output names both flags", () => {
    fakeTps(TPS_MAIL_USAGE_WITH_CONTRACT, 3);
    const c = check(doctor(), "tps-mail reply contract");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("exited 3");
  });

  it("(rc5) a probe past its timeout is killed and FAILS", () => {
    fakeTps(TPS_MAIL_USAGE_WITH_CONTRACT, 0, "exec /bin/sleep 30\n");
    const started = Date.now();
    const report = runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
      pathEnv: pathDir,
      tpsProbeTimeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const c = check(report, "tps-mail reply contract");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("did not finish within 300ms");
  }, 15_000);

  it("(rc6) a probe that cannot start FAILS instead of throwing", () => {
    writeFileSync(join(pathDir, "tps"), "#!/nonexistent/interpreter\n");
    chmodSync(join(pathDir, "tps"), 0o755);
    const c = check(doctor(), "tps-mail reply contract");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("could not be run");
  });

  it("(rc7) the probe gets PATH and HOME only — no ambient variable reaches it", () => {
    const envOut = join(home, "probe-env.txt");
    fakeTps(TPS_MAIL_USAGE_WITH_CONTRACT, 0, `/usr/bin/env > "${envOut}"\n`);
    process.env.BOB_DOCTOR_PROBE_SENTINEL = "ambient";
    try {
      expect(check(doctor(), "tps-mail reply contract")?.status).toBe("ok");
    } finally {
      delete process.env.BOB_DOCTOR_PROBE_SENTINEL;
    }
    const seen = readFileSync(envOut, "utf8");
    expect(seen).toContain(`HOME=${home}\n`);
    expect(seen).toContain(`PATH=${pathDir}\n`);
    expect(seen).not.toContain("BOB_DOCTOR_PROBE_SENTINEL");
  });
});
