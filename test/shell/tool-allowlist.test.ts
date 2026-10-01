// The `tools:` block schema (bob-yaml.ts) and the name/policy layer on top of
// it (tool-allowlist.ts). The behavioural tests live in run.test.ts,
// run-tool-allowlist.test.ts, init.test.ts and doctor.test.ts; this file pins
// the pieces those reach only indirectly.
import { describe, expect, it } from "bun:test";
import { BobYamlError, readResident, readTools } from "../../src/shell/bob-yaml.js";
import { BLESSED_CATALOG } from "../../src/shell/capability-catalog.js";
import { loadRole } from "../../src/shell/role-loader.js";
import {
  auditToolNames,
  knownToolNames,
  PI_BUILTIN_TOOLS,
  RESIDENT_EXCLUDED_TOOLS,
  type RoleToolCeiling,
  residentDroppedTools,
  residentExclusions,
  resolveToolNames,
  resolveToolPolicy,
  TOOL_EFFECTS,
  unclassifiedToolNames,
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

describe("readTools: the refused inline form", () => {
  // A dedicated test for the inline shape, because it is the one form that
  // reads as an empty block and therefore as "no policy": `readBlock` drops a
  // block key's inline value silently, so `tools: {allow: [read]}` would leave
  // the block empty — and empty is one step away from pi's defaults, the state
  // this whole reader exists to make impossible. One shape for the block.
  const inlineForms = [
    "tools: {allow: [read]}",
    'tools: { allow: ["read", "grep"] }',
    "tools: []",
    "tools: read",
  ];

  it("refuses EVERY inline value, naming the block shape to use", () => {
    for (const line of inlineForms) {
      let error: unknown;
      try {
        readTools(["agent:", "  id: testbot", "", line, ""].join("\n"));
      } catch (err) {
        error = err;
      }
      expect(error, `inline form: ${line}`).toBeInstanceOf(BobYamlError);
      expect((error as Error).message).toContain("inline form is not supported");
    }
  });

  it("still accepts the block form, and a trailing comment on tools:", () => {
    const block = readTools(["tools: # the allowlist", "  allow:", "    - read", ""].join("\n"));
    expect(block?.allow).toEqual(["read"]);
  });

  it("refuses the inline form through the whole policy resolution too", () => {
    expect(() =>
      resolveToolPolicy({
        tools: readTools(["tools: {allow: [read]}", ""].join("\n")),
        yamlText: "tools: {allow: [read]}\n",
      }),
    ).toThrow(/inline form is not supported/);
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
  const policy = (yamlText: string, resident = false, persistent = false, role?: RoleToolCeiling) =>
    resolveToolPolicy({
      yamlText,
      tools: readTools(yamlText),
      role,
      resident,
      persistent,
    });

  it("REFUSES a missing allowlist — a missing policy is a load error", () => {
    // The old reading ("no block = pi's own defaults") is what made the
    // allowlist inert: pi's defaults are not something bob.yaml decided.
    expect(() => policy("agent:\n  id: testbot\n")).toThrow(/no tools: block/);
  });

  it("REFUSES a tools: block with no allow: list", () => {
    expect(() => policy("tools:\n  exclude:\n    - bash\n")).toThrow(/no allow: list/);
  });

  it("keeps the role's grant of allowResidentShell when bob.yaml is silent", () => {
    const yaml = "resident: true\ntools:\n  allow:\n    - read\n    - bash\n";
    const p = policy(yaml, true, false, {
      name: "coder",
      allow: ["read", "bash"],
      allowResidentShell: true,
    });
    expect(p.allowResidentShell).toBe(true);
    expect(p.excludeTools).toEqual([]);
  });

  it("lets bob.yaml NARROW the role's shell grant away", () => {
    // Narrowing is always allowed — holding fewer tools than the role permits
    // is a decision the agent's own config may make.
    const yaml =
      "resident: true\ntools:\n  allow:\n    - read\n    - bash\n  allowResidentShell: false\n";
    const p = policy(yaml, true, false, {
      name: "coder",
      allow: ["read", "bash"],
      allowResidentShell: true,
    });
    expect(p.allowResidentShell).toBe(false);
    expect(p.excludeTools).toEqual([
      "bash",
      "write",
      "edit",
      "replace_lines",
      "powershell",
      "run",
      "write_file",
      "edit_lines",
      "insert_after",
    ]);
  });

  it("REFUSES allowResidentShell: true when the role does not grant it", () => {
    const yaml = "tools:\n  allow:\n    - read\n    - bash\n  allowResidentShell: true\n";
    expect(() => policy(yaml, true, false, { name: "qa", allow: ["read", "bash"] })).toThrow(
      /allowResidentShell/,
    );
  });

  it("REFUSES a name the role does not allow (widening, named)", () => {
    expect(() =>
      policy("tools:\n  allow:\n    - read\n    - bash\n", false, false, {
        name: "ea",
        allow: ["read", "flair_search"],
      }),
    ).toThrow(/bash/);
  });

  it("allows a strict SUBSET of the role's list", () => {
    const p = policy("tools:\n  allow:\n    - read\n", false, false, {
      name: "ea",
      allow: ["read", "flair_search"],
    });
    expect(p.tools).toEqual(["read"]);
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
    expect(p.excludeTools).toEqual([
      "bash",
      "write",
      "edit",
      "replace_lines",
      "powershell",
      "run",
      "write_file",
      "edit_lines",
      "insert_after",
    ]);
    expect(residentDroppedTools(p)).toEqual(["bash"]);
  });

  it("treats the persistent lifespan as resident even without `resident: true`", () => {
    const yaml = "tools:\n  allow:\n    - read\n    - bash\n";
    const p = policy(yaml, false, true);
    expect(p.resident).toBe(true);
    expect(p.excludeTools).toEqual([
      "bash",
      "write",
      "edit",
      "replace_lines",
      "powershell",
      "run",
      "write_file",
      "edit_lines",
      "insert_after",
    ]);
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
    expect(policy(yaml, true).excludeTools).toEqual([
      "bash",
      "write",
      "edit",
      "replace_lines",
      "powershell",
      "run",
      "write_file",
      "edit_lines",
      "insert_after",
    ]);
  });
});

describe("shipped roles", () => {
  it("every shipped role's allowlist resolves against the real tool names", () => {
    for (const role of ["ea", "jarvis", "writer", "reviewer", "coder", "qa", "custom"] as const) {
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

  it("only the coder role opts into the resident shell (allowResidentShell)", () => {
    // The opt-in is a ROLE property now: a resident agent loses bash/write/edit
    // unless the role grants them. Only the builder role grants them — the
    // others are meant to run unattended without a shell.
    expect(loadRole("coder").tools.allowResidentShell).toBe(true);
    for (const role of ["ea", "writer", "reviewer", "qa", "custom"] as const) {
      expect(loadRole(role).tools.allowResidentShell).toBeUndefined();
    }
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

// bob#213: the resident policy is allowlist-shaped over TOOL_EFFECTS, a reviewed
// classification of every tool an agent's allowlist can name.
describe("the reviewed tool classification (TOOL_EFFECTS)", () => {
  // Enumerated HERE, not through the source's own helpers, from the authority
  // the name resolution uses: pi's built-ins plus every blessed capability's
  // manifest `provides.tools`, planned capabilities included.
  function providedHere(): string[] {
    const names = new Set<string>(PI_BUILTIN_TOOLS);
    for (const [capability, entry] of Object.entries(BLESSED_CATALOG)) {
      const tools = entry.manifest.provides?.tools;
      // A manifest with no tools array would add nothing, silently.
      expect({ capability, isArray: Array.isArray(tools) }).toEqual({ capability, isArray: true });
      for (const tool of tools ?? []) names.add(tool);
    }
    return [...names];
  }

  it("the enumeration reaches the capabilities' tools (it is not empty)", () => {
    const names = providedHere();
    for (const name of [
      "write_file",
      "edit_lines",
      "insert_after",
      "run",
      "run_cancel",
      "flair_write",
      "discord_reply",
      "reachy_frame",
      "observatory_report",
      "bob_fixture_noop",
      "mail_send",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("classifies every tool pi or a blessed capability provides", () => {
    // Adding a tool to a manifest without a TOOL_EFFECTS row turns this red,
    // naming the tool.
    expect(providedHere().filter((name) => !Object.hasOwn(TOOL_EFFECTS, name))).toEqual([]);
    // The source's own view agrees; it is what the resident exclusion reads.
    expect(unclassifiedToolNames()).toEqual([]);
  });

  it("has no row for a name nothing provides", () => {
    const provided = new Set(providedHere());
    expect(Object.keys(TOOL_EFFECTS).filter((name) => !provided.has(name))).toEqual([]);
  });

  it("a resident agent drops exactly the writer rows", () => {
    expect(RESIDENT_EXCLUDED_TOOLS).toEqual([
      "bash",
      "write",
      "edit",
      "replace_lines",
      "powershell",
      "run",
      "write_file",
      "edit_lines",
      "insert_after",
    ]);
    expect(RESIDENT_EXCLUDED_TOOLS).toEqual(
      Object.keys(TOOL_EFFECTS).filter((name) => TOOL_EFFECTS[name] === "writer"),
    );
  });

  it("a resident agent keeps every read-only and effect tool, and nothing else", () => {
    const all = knownToolNames();
    const yaml = `tools:\n  allow:\n${all.map((name) => `    - ${name}`).join("\n")}\n`;
    const p = resolveToolPolicy({ yamlText: yaml, tools: readTools(yaml), resident: true });
    const kept = p.tools.filter((name) => !p.excludeTools.includes(name));
    expect(kept).toEqual(
      all.filter((name) => TOOL_EFFECTS[name] === "read-only" || TOOL_EFFECTS[name] === "effect"),
    );
    expect(kept).toContain("flair_write");
    expect(kept).toContain("discord_reply");
    expect(kept).toContain("run_cancel");
    expect(kept).not.toContain("write_file");
  });

  it("fails closed: a provided name with no row is dropped, not kept", () => {
    const effects = { read: "read-only", bash: "writer" } as const;
    expect(unclassifiedToolNames(["read", "bash", "save_file"], effects)).toEqual(["save_file"]);
    expect(residentExclusions(["read", "bash", "save_file"], effects)).toEqual([
      "bash",
      "save_file",
    ]);
  });
});
