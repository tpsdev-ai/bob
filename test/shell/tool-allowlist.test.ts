// The `tools:` block schema (bob-yaml.ts) and the name/policy layer on top of
// it (tool-allowlist.ts). The behavioural tests live in run.test.ts,
// run-tool-allowlist.test.ts, init.test.ts and doctor.test.ts; this file pins
// the pieces those reach only indirectly.
import { describe, expect, it } from "bun:test";
import { BobYamlError, readResident, readTools } from "../../src/shell/bob-yaml.js";
import { loadRole } from "../../src/shell/role-loader.js";
import {
  auditToolNames,
  knownToolNames,
  residentDroppedTools,
  resolveToolNames,
  resolveToolPolicy,
} from "../../src/shell/tool-allowlist.js";

// The block exactly as `bob init` emits it.
const YAML = [
  "agent:",
  "  id: testbot",
  "",
  "tools:",
  "  allow:",
  "    - read",
  "    - flair_search",
  "",
  "capabilities:",
  "  - flair",
  "",
].join("\n");

describe("readTools (the tools: block schema)", () => {
  it("reads the allow list `bob init` emits", () => {
    expect(readTools(YAML)).toEqual({ allow: ["read", "flair_search"] });
  });

  it("reads exclude + allowResidentShell", () => {
    const yaml = [
      "tools:",
      "  allow: [read, bash]",
      "  exclude:",
      "    - bash",
      "  allowResidentShell: true",
      "",
    ].join("\n");
    expect(readTools(yaml)).toEqual({
      allow: ["read", "bash"],
      exclude: ["bash"],
      allowResidentShell: true,
    });
  });

  it("accepts a single scalar name", () => {
    expect(readTools("tools:\n  allow: read\n")).toEqual({ allow: ["read"] });
  });

  it("keeps an explicitly empty allow list empty (that IS 'no tools')", () => {
    expect(readTools("tools:\n  allow:\n")).toEqual({ allow: [] });
  });

  it("returns undefined when bob.yaml has no tools block", () => {
    expect(readTools("agent:\n  id: testbot\n")).toBeUndefined();
  });

  it("REFUSES an unknown key, naming it (a typo must not read as no policy)", () => {
    expect(() => readTools("tools:\n  alow:\n    - read\n")).toThrow(/alow/);
  });

  it("refuses a non-boolean allowResidentShell", () => {
    expect(() => readTools("tools:\n  allowResidentShell: sometimes\n")).toThrow(BobYamlError);
  });

  it("refuses a name that is not a string", () => {
    expect(() => readTools("tools:\n  allow:\n    - 42\n")).toThrow(BobYamlError);
  });
});

describe("readResident", () => {
  it("defaults false when absent", () => {
    expect(readResident(YAML)).toBe(false);
  });

  it("reads true / false", () => {
    expect(readResident("resident: true\n")).toBe(true);
    expect(readResident("resident: false\n")).toBe(false);
  });

  it("refuses anything else rather than guessing", () => {
    expect(() => readResident("resident: maybe\n")).toThrow(/resident/);
  });
});

describe("auditToolNames", () => {
  it("resolves pi built-ins and capability tools", () => {
    const { resolved, problems } = auditToolNames([
      "read",
      "bash",
      "flair_search",
      "discord_reply",
    ]);
    expect(problems).toEqual([]);
    expect(resolved).toEqual(["read", "bash", "flair_search", "discord_reply"]);
  });

  it("names the pi equivalent for the OpenClaw-era casings", () => {
    const { problems } = auditToolNames(["Bash", "Read", "WebFetch", "Glob"]);
    const hints = Object.fromEntries(problems.map((p) => [p.name, p.hint]));
    expect(hints.Bash).toContain('"bash"');
    expect(hints.Read).toContain('"read"');
    expect(hints.Glob).toContain('"find"');
    // No equivalent at all: the migration is deletion, and saying so is the fix.
    expect(hints.WebFetch).toContain("remove it");
  });

  it("names the real capability tool for the mcp__ Discord names", () => {
    const { problems } = auditToolNames([
      "mcp__plugin_discord_discord__reply",
      "mcp__plugin_discord_discord__fetch_messages",
    ]);
    const hints = Object.fromEntries(problems.map((p) => [p.name, p.hint]));
    expect(hints.mcp__plugin_discord_discord__reply).toContain("discord_reply");
    // The capability registers discord_fetch, not discord_fetch_messages.
    expect(hints.mcp__plugin_discord_discord__fetch_messages).toContain("discord_fetch");
  });

  it("flags a tool of a blessed-but-unbuilt capability as such", () => {
    const { problems } = auditToolNames(["mail_send"]);
    expect(problems).toHaveLength(1);
    expect(problems[0].hint).toContain("mail");
  });
});

describe("resolveToolNames", () => {
  it("throws one error naming EVERY offender and the known names", () => {
    let err: Error | undefined;
    try {
      resolveToolNames(["Bash", "Read"], YAML);
    } catch (e) {
      err = e as Error;
    }
    const msg = err?.message ?? "";
    expect(msg).toContain("Bash");
    expect(msg).toContain("Read");
    expect(msg).toContain("Known names:");
    expect(msg).toContain("read");
  });
});

describe("resolveToolPolicy", () => {
  const policy = (yamlText: string, resident = false, persistent = false) =>
    resolveToolPolicy({
      yamlText,
      tools: readTools(yamlText),
      resident,
      persistent,
    });

  it("leaves tools undefined when the agent declared no allowlist", () => {
    const p = policy("agent:\n  id: testbot\n");
    expect(p.tools).toBeUndefined();
    expect(p.excludeTools).toEqual([]);
  });

  it("carries the allowlist through unchanged", () => {
    const p = policy("tools:\n  allow:\n    - read\n    - flair_search\n");
    expect(p.tools).toEqual(["read", "flair_search"]);
    expect(p.excludeTools).toEqual([]);
  });

  it("keeps an explicit empty allowlist as [] (not undefined)", () => {
    expect(policy("tools:\n  allow:\n").tools).toEqual([]);
  });

  it("drops the shell + file-writing tools for a resident agent", () => {
    const yaml = "resident: true\ntools:\n  allow:\n    - read\n    - bash\n";
    const p = policy(yaml, true);
    expect(p.tools).toEqual(["read", "bash"]);
    expect(p.excludeTools).toEqual(["bash", "write", "edit", "powershell"]);
    expect(residentDroppedTools(p)).toEqual(["bash"]);
  });

  it("treats the persistent lifespan as resident even without `resident: true`", () => {
    const yaml = "tools:\n  allow:\n    - read\n    - bash\n";
    const p = policy(yaml, false, true);
    expect(p.resident).toBe(true);
    expect(p.excludeTools).toEqual(["bash", "write", "edit", "powershell"]);
  });

  it("keeps the shell when the role opts in with allowResidentShell", () => {
    const yaml =
      "resident: true\ntools:\n  allow:\n    - read\n    - bash\n  allowResidentShell: true\n";
    const p = policy(yaml, true);
    expect(p.tools).toEqual(["read", "bash"]);
    expect(p.excludeTools).toEqual([]);
    expect(residentDroppedTools(p)).toEqual([]);
  });

  it("unions a declared exclude with the resident exclusions, without duplicates", () => {
    const yaml =
      "resident: true\ntools:\n  allow:\n    - read\n    - bash\n  exclude:\n    - bash\n";
    expect(policy(yaml, true).excludeTools).toEqual(["bash", "write", "edit", "powershell"]);
  });
});

describe("shipped roles", () => {
  it("every shipped role's allowlist resolves against the real tool names", () => {
    for (const role of ["ea", "writer", "reviewer", "coder", "qa", "custom"] as const) {
      const template = loadRole(role);
      // Throws (naming the offender) if any shipped name is not a tool pi can
      // enable — the guard that keeps roles/*/role.json honest.
      const resolved = resolveToolNames(template.tools.allow, "");
      expect({ role, resolved }).toEqual({ role, resolved: template.tools.allow });
    }
  });

  it("the coder (builder) role holds the shell + file-writing tools", () => {
    const { tools } = loadRole("coder");
    for (const tool of ["read", "bash", "edit", "write"]) expect(tools.allow).toContain(tool);
  });

  it("knownToolNames includes pi's built-ins and the capabilities' tools", () => {
    const names = knownToolNames();
    for (const name of [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "powershell",
      "flair_search",
      "discord_reply",
      "discord_fetch",
      "discord_react",
      "observatory_report",
      "bob_fixture_noop",
    ]) {
      expect(names).toContain(name);
    }
    // Not a pi tool, never indexed as one.
    expect(names).not.toContain("webfetch");
  });
});
