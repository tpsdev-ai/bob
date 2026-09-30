// bob#244 (web spec v3, slice R1a): the policy rows the web tools ride on —
// the egress effect class, the resident rule (dropped unless allowResidentWeb;
// the shell grant does not cover them), the jarvis/ea role ceilings, the mail
// turn's allowlist (which drops them), and doctor's warning.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BobYamlError, readTools } from "../../src/shell/bob-yaml.js";
import { runDoctor } from "../../src/shell/doctor.js";
import { hireAgent } from "../../src/shell/position-runtime.js";
import { DEFAULT_POSITIONS_ROOT } from "../../src/shell/positions.js";
import { loadRole } from "../../src/shell/role-loader.js";
import { resolveAgentToolPolicy, resolveRunConfig } from "../../src/shell/run.js";
import {
  applyMailTurnPolicy,
  MAIL_TURN_ALLOWED_TOOLS,
  RESIDENT_EGRESS_TOOLS,
  RESIDENT_EXCLUDED_TOOLS,
  type RoleToolCeiling,
  residentDroppedTools,
  residentDroppedWebTools,
  resolveToolPolicy,
  TOOL_EFFECTS,
} from "../../src/shell/tool-allowlist.js";

const WEB_TOOLS = ["web_fetch", "web_search"];

function policy(yamlText: string, opts: { resident?: boolean; role?: RoleToolCeiling } = {}) {
  return resolveToolPolicy({
    yamlText,
    tools: readTools(yamlText),
    resident: opts.resident ?? false,
    ...(opts.role !== undefined ? { role: opts.role } : {}),
  });
}

const allowYaml = (names: string[], extra = "") =>
  `tools:\n  allow:\n${names.map((n) => `    - ${n}`).join("\n")}\n${extra}`;

describe("the egress effect class (TOOL_EFFECTS)", () => {
  it("both web tools are egress rows, and they are the only egress rows", () => {
    expect(TOOL_EFFECTS.web_fetch).toBe("egress");
    expect(TOOL_EFFECTS.web_search).toBe("egress");
    expect(Object.keys(TOOL_EFFECTS).filter((n) => TOOL_EFFECTS[n] === "egress")).toEqual(
      WEB_TOOLS,
    );
    expect([...RESIDENT_EGRESS_TOOLS]).toEqual(WEB_TOOLS);
  });

  it("the shell exclusion list does not carry them: the two grants are independent", () => {
    for (const name of WEB_TOOLS) expect(RESIDENT_EXCLUDED_TOOLS).not.toContain(name);
  });
});

describe("the resident rule for egress tools", () => {
  const webRole: RoleToolCeiling = {
    name: "webrole",
    allow: ["flair_search", ...WEB_TOOLS, "bash"],
    allowResidentWeb: true,
  };
  const shellOnlyRole: RoleToolCeiling = {
    name: "shellrole",
    allow: ["flair_search", ...WEB_TOOLS, "bash"],
    allowResidentShell: true,
  };

  it("a resident agent drops the web tools when nothing grants them", () => {
    const p = policy(allowYaml(["flair_search", "bash", ...WEB_TOOLS]), { resident: true });
    expect(p.allowResidentWeb).toBe(false);
    for (const name of WEB_TOOLS) expect(p.excludeTools).toContain(name);
    expect(residentDroppedWebTools(p)).toEqual(WEB_TOOLS);
    // Doctor's shell warning names only what the SHELL grant would keep.
    expect(residentDroppedTools(p)).toEqual(["bash"]);
  });

  it("with the role's allowResidentWeb, the resident policy does not exclude them (activating either is still refused, because neither is registered)", () => {
    const p = policy(allowYaml(["flair_search", ...WEB_TOOLS]), { resident: true, role: webRole });
    expect(p.allowResidentWeb).toBe(true);
    for (const name of WEB_TOOLS) expect(p.excludeTools).not.toContain(name);
    expect(residentDroppedWebTools(p)).toEqual([]);
  });

  it("a shell opt-in does NOT authorize web", () => {
    const p = policy(allowYaml(["bash", ...WEB_TOOLS]), { resident: true, role: shellOnlyRole });
    expect(p.allowResidentShell).toBe(true);
    expect(p.excludeTools).not.toContain("bash");
    for (const name of WEB_TOOLS) expect(p.excludeTools).toContain(name);
    // Doctor's shell warning stays silent (the shell is granted); the web one names them.
    expect(residentDroppedTools(p)).toEqual([]);
    expect(residentDroppedWebTools(p)).toEqual(WEB_TOOLS);
  });

  it("the web opt-in does NOT authorize the shell", () => {
    const p = policy(allowYaml(["bash", ...WEB_TOOLS]), { resident: true, role: webRole });
    expect(p.excludeTools).toContain("bash");
    for (const name of WEB_TOOLS) expect(p.excludeTools).not.toContain(name);
    expect(residentDroppedTools(p)).toEqual(["bash"]);
  });

  it("bob.yaml may narrow the role's web grant away, never grant it", () => {
    const narrowed = policy(allowYaml(WEB_TOOLS, "  allowResidentWeb: false\n"), {
      resident: true,
      role: webRole,
    });
    expect(narrowed.allowResidentWeb).toBe(false);
    for (const name of WEB_TOOLS) expect(narrowed.excludeTools).toContain(name);

    expect(() =>
      policy(allowYaml(WEB_TOOLS, "  allowResidentWeb: true\n"), {
        resident: true,
        role: shellOnlyRole,
      }),
    ).toThrow(/tools\.allowResidentWeb is true, but the role does not grant it/);
  });

  it("a non-resident policy does not exclude them (residency is what drops them; activating either is still refused, because neither is registered)", () => {
    const p = policy(allowYaml(WEB_TOOLS), { resident: false });
    expect(p.excludeTools).toEqual([]);
  });

  it("an allowlist without web tools resolves exactly as before (no new exclusions)", () => {
    const p = policy(allowYaml(["read", "bash"]), { resident: true });
    expect(p.excludeTools).toEqual([...RESIDENT_EXCLUDED_TOOLS]);
  });

  it("bob.yaml's tools block reads allowResidentWeb and refuses a non-boolean", () => {
    expect(readTools(allowYaml(["read"], "  allowResidentWeb: false\n"))).toEqual({
      allow: ["read"],
      allowResidentWeb: false,
    });
    expect(() => readTools(allowYaml(["read"], "  allowResidentWeb: yes\n"))).toThrow(BobYamlError);
    expect(() => readTools(allowYaml(["read"], "  allowResidentWeb: yes\n"))).toThrow(
      /"allowResidentWeb" must be true or false/,
    );
  });
});

describe("jarvis/ea role support", () => {
  it("jarvis and ea allow both web tools and grant them to a resident agent, without the shell", () => {
    for (const role of ["jarvis", "ea"] as const) {
      const { tools } = loadRole(role);
      for (const name of WEB_TOOLS) expect(tools.allow, `${role}: ${name}`).toContain(name);
      expect(tools.allowResidentWeb, role).toBe(true);
      expect(tools.allowResidentShell === true, role).toBe(false);
    }
  });

  it("no other shipped role allows a web tool or grants resident web", () => {
    for (const role of ["writer", "reviewer", "coder", "qa", "builder-local", "custom"] as const) {
      const { tools } = loadRole(role);
      for (const name of WEB_TOOLS) expect(tools.allow, `${role}: ${name}`).not.toContain(name);
      expect(tools.allowResidentWeb, role).toBeUndefined();
    }
  });

  it("a resident jarvis policy that allows the web tools does not exclude them (the role's grant reaches the policy; activating either is still refused, because neither is registered)", () => {
    const yaml = [
      "agent:",
      "  id: jarvisbot",
      "  role: jarvis",
      "resident: true",
      allowYaml(["flair_search", ...WEB_TOOLS]),
    ].join("\n");
    const p = resolveAgentToolPolicy(yaml);
    expect(p.resident).toBe(true);
    expect(p.allowResidentWeb).toBe(true);
    for (const name of WEB_TOOLS) expect(p.excludeTools).not.toContain(name);
    // The persistent runtime (resident by definition) resolves the same way.
    expect(resolveAgentToolPolicy(yaml, { persistent: true }).allowResidentWeb).toBe(true);
  });
});

describe("the mail turn keeps its allowlist intersection, which drops the web tools", () => {
  it("no egress tool is on the reviewed mail allowlist", () => {
    expect(MAIL_TURN_ALLOWED_TOOLS.filter((n) => TOOL_EFFECTS[n] === "egress")).toEqual([]);
  });

  it("a jarvis policy that holds the web tools loses them in a mail turn", () => {
    const yaml = [
      "agent:",
      "  id: jarvisbot",
      "  role: jarvis",
      allowYaml(["flair_search", "flair_get", "discord_reply", ...WEB_TOOLS]),
    ].join("\n");
    const full = resolveAgentToolPolicy(yaml, { persistent: true });
    for (const name of WEB_TOOLS) expect(full.tools).toContain(name);
    const mail = applyMailTurnPolicy(full);
    expect(mail.tools).toEqual(["flair_search", "flair_get"]);
  });
});

describe("doctor names the web grant, not the shell grant", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bob-web-doctor-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function doctorTools(yaml: string) {
    const agentDir = join(home, "agents", "webbot");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "soul.md"), "stub soul");
    writeFileSync(join(agentDir, "bob.yaml"), yaml);
    const report = runDoctor({
      name: "webbot",
      agentsRoot: join(home, "agents"),
      flairKeysDir: join(home, ".flair", "keys"),
      homeDir: home,
      hostRoot: join(home, ".bob", "host"),
    });
    return report.checks.find((c) => c.name === "tool allowlist");
  }

  it("WARN when a resident agent's bob.yaml narrows the role's web grant away", () => {
    const check = doctorTools(
      [
        "agent:",
        "  id: webbot",
        "  role: jarvis",
        "resident: true",
        "capabilities:",
        "  - web",
        allowYaml(["web_fetch"], "  allowResidentWeb: false\n"),
      ].join("\n"),
    );
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("drops web_fetch");
    expect(check?.fix).toContain("tools.allowResidentWeb: true");
    expect(check?.fix).toContain("roles/jarvis/role.json");
    expect(check?.fix).toContain("tools.allowResidentWeb: false from bob.yaml");
    expect(check?.fix).not.toContain("set tools.allowResidentShell: true");
  });

  it("no web warning when the role's grant holds", () => {
    const check = doctorTools(
      [
        "agent:",
        "  id: webbot",
        "  role: jarvis",
        "resident: true",
        "capabilities:",
        "  - web",
        allowYaml(["web_fetch"]),
      ].join("\n"),
    );
    expect(check?.status).toBe("ok");
  });
});

describe("an agent bound to a position gets no resident web grant", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bob-web-pos-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("its bob.yaml cannot grant allowResidentWeb (the host grant ratifies no such flag)", async () => {
    const agentsRoot = join(base, "agents");
    const hostRoot = join(base, "host");
    mkdirSync(agentsRoot, { recursive: true });
    await hireAgent({
      name: "posbot",
      positionName: "builder",
      agentsRoot,
      hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
      contextWindow: 200_000,
      interview: async () => 0,
    });
    const resolve = () =>
      resolveRunConfig({
        name: "posbot",
        agentsRoot,
        hostRoot,
        positionsRoot: DEFAULT_POSITIONS_ROOT,
      });
    expect(resolve().policy.allowResidentWeb === true).toBe(false);

    const yamlPath = join(agentsRoot, "posbot", "bob.yaml");
    const yaml = readFileSync(yamlPath, "utf8");
    expect(yaml).toContain("\ntools:\n");
    writeFileSync(yamlPath, yaml.replace("\ntools:\n", "\ntools:\n  allowResidentWeb: true\n"));
    expect(resolve).toThrow(/tools\.allowResidentWeb is true, but the role does not grant it/);
  });
});
