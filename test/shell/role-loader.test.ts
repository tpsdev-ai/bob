import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRole, loadRoleFrom } from "../../src/shell/role-loader.js";
import { resolveToolNames } from "../../src/shell/tool-allowlist.js";

describe("role-loader", () => {
  it("loads the ea role template", () => {
    const t = loadRole("ea");
    expect(t.role).toBe("ea");
    expect(t.soul.length).toBeGreaterThan(0);
    // bob#230: ea answers a chat surface, so it does not hold `read`.
    expect(t.tools.allow).not.toContain("read");
    // The Discord tools come from the capability's REAL names (the mcp__
    // plugin_discord_discord__* spellings pi's registry never knew).
    expect(t.tools.allow).toContain("discord_reply");
    expect(t.tools.allow).toContain("flair_search");
  });

  it.each(["writer", "reviewer", "coder", "qa", "builder-local", "custom"] as const)(
    "loads the %s role template",
    (role) => {
      const t = loadRole(role);
      expect(t.role).toBe(role);
      expect(t.soul.length).toBeGreaterThan(0);
      expect(t.tools.allow.length).toBeGreaterThan(0);
      // Every role gets Flair memory by default — the office-agent
      // pattern assumes Flair as the memory layer.
      expect(t.tools.allow).toContain("flair_search");
    },
  );

  it("builder-local holds the anchored tools + the managed run tool and NO read/edit/write/bash", () => {
    const t = loadRole("builder-local");
    // The four anchored tools that replace whole-file editing.
    for (const tool of ["read_lines", "edit_lines", "insert_after", "write_file"]) {
      expect(t.tools.allow, tool).toContain(tool);
    }
    // The managed run tool (bob#211) + browsing tools it keeps, and Flair memory.
    for (const tool of ["run", "run_status", "run_cancel", "grep", "find", "ls", "flair_search"]) {
      expect(t.tools.allow, tool).toContain(tool);
    }
    // NO whole-file edit/write tools — the point of the role — and NO raw shell:
    // `run` REPLACES pi's bash (bob#211), a checkable fact of this config.
    for (const tool of ["read", "edit", "write", "bash", "powershell"]) {
      expect(t.tools.allow, tool).not.toContain(tool);
    }
    expect(t.tools.allowResidentShell).toBe(true);
  });

  it("loads jarvis with only registered office tools and no shell or file-writing tools", () => {
    const t = loadRole("jarvis");
    expect(t.role).toBe("jarvis");
    expect(t.soul.trim().length).toBeGreaterThan(0);
    // bob#244: the ceiling also names the two web tools (egress, resident only
    // with allowResidentWeb). The web composition rule keeps them out of any
    // session that also holds flair or discord.
    expect(t.tools.allow).toEqual([
      "flair_search",
      "flair_write",
      "flair_get",
      "discord_reply",
      "discord_fetch",
      "discord_react",
      "web_fetch",
      "web_search",
    ]);
    expect(t.tools.allowResidentWeb).toBe(true);
    // bob#230: jarvis answers chat, so it drops `read` (the seed role files are
    // pinned so this cannot quietly come back).
    expect(t.tools.allow).not.toContain("read");
    expect(resolveToolNames(t.tools.allow, "")).toEqual(t.tools.allow);
    // flair_write stores memories; none of the shell or file mutators belong here.
    for (const tool of [
      "bash",
      "powershell",
      "write",
      "edit",
      "write_file",
      "edit_lines",
      "insert_after",
    ]) {
      expect(t.tools.allow, tool).not.toContain(tool);
    }
    expect(t.tools.allowResidentShell).toBe(false);
  });

  it("throws on unknown role", () => {
    // @ts-expect-error — intentionally bad role
    expect(() => loadRole("does-not-exist")).toThrow(/unknown role/);
  });

  it("rejects path-traversal role names", () => {
    // @ts-expect-error — intentionally bad role
    expect(() => loadRole("../../../etc")).toThrow(/invalid role name/);
    // @ts-expect-error — intentionally bad role
    expect(() => loadRole("ea/../../../etc")).toThrow(/invalid role name/);
    // @ts-expect-error — intentionally bad role
    expect(() => loadRole("ea\\..\\etc")).toThrow(/invalid role name/);
  });
});

// bob#365: role.json `final_markers` is validated when the role loads. A
// fixture role in a temporary roles directory goes through loadRole's own
// parse and validation (loadRoleFrom is loadRole over the given roots).
describe("role.json final_markers validation (#365)", () => {
  let rolesRoot: string;

  beforeEach(() => {
    rolesRoot = mkdtempSync(join(tmpdir(), "bob-role-markers-"));
  });

  afterEach(() => {
    rmSync(rolesRoot, { recursive: true, force: true });
  });

  /** Write a fixture role named "custom" whose role.json carries `extra`, and
   *  return its role.json path. */
  const writeRole = (extra: Record<string, unknown>): string => {
    const dir = join(rolesRoot, "custom");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "soul.md"), "You are a fixture role.");
    const configPath = join(dir, "role.json");
    writeFileSync(configPath, JSON.stringify({ tools: { allow: ["read"] }, ...extra }));
    return configPath;
  };

  it.each([
    ["an empty list", []],
    ["an empty marker", [""]],
    ["a whitespace-only marker", [" "]],
    ["a marker with leading whitespace", [" DONE"]],
    ["a marker with trailing whitespace", ["DONE "]],
    ["a marker with a trailing newline", ["DONE\n"]],
    ["an empty marker after a valid one", ["DONE", ""]],
    ["a string instead of a list", "DONE"],
    ["a number element", [1]],
    ["a non-string element after a valid one", ["DONE", 1]],
    ["a nested list", [["DONE"]]],
    ["an object", { DONE: true }],
    ["null", null],
    ["true", true],
  ] as const)("refuses %s, naming the file and the key", (_label, value) => {
    const configPath = writeRole({ final_markers: value });
    expect(() => loadRoleFrom([rolesRoot], "custom")).toThrow(
      `${configPath}: "final_markers" must be a non-empty list of non-empty strings without leading or trailing whitespace.`,
    );
  });

  it.each([[["DONE"]], [["DONE", "BLOCKED"]]] as const)(
    "loads a valid list exactly as declared: %j",
    (markers) => {
      writeRole({ final_markers: markers });
      expect(loadRoleFrom([rolesRoot], "custom").final_markers).toEqual([...markers]);
    },
  );

  it("a role that declares no final_markers loads without them", () => {
    writeRole({});
    expect(loadRoleFrom([rolesRoot], "custom").final_markers).toBeUndefined();
  });

  it("loadRole is the same loader over the shipped roles: builder-local loads its declared list", () => {
    expect(loadRole("builder-local").final_markers).toEqual(["DONE", "BLOCKED"]);
  });
});
