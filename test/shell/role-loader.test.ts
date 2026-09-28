import { describe, expect, it } from "bun:test";
import { loadRole } from "../../src/shell/role-loader.js";

describe("role-loader", () => {
  it("loads the ea role template", () => {
    const t = loadRole("ea");
    expect(t.role).toBe("ea");
    expect(t.soul.length).toBeGreaterThan(0);
    expect(t.tools.allow).toContain("read");
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

  it("builder-local holds the anchored tools + shell and NO read/edit/write", () => {
    const t = loadRole("builder-local");
    // The four anchored tools that replace whole-file editing.
    for (const tool of ["read_lines", "edit_lines", "insert_after", "write_file"]) {
      expect(t.tools.allow, tool).toContain(tool);
    }
    // The shell + browsing tools it keeps, and Flair memory.
    for (const tool of ["bash", "grep", "find", "ls", "flair_search"]) {
      expect(t.tools.allow, tool).toContain(tool);
    }
    // NO whole-file edit/write tools — the point of the role.
    for (const tool of ["read", "edit", "write"]) {
      expect(t.tools.allow, tool).not.toContain(tool);
    }
    expect(t.tools.allowResidentShell).toBe(true);
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
