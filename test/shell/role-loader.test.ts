import { describe, expect, it } from "bun:test";
import { loadRole } from "../../src/shell/role-loader.js";
import { resolveToolNames } from "../../src/shell/tool-allowlist.js";

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
    expect(t.tools.allow).toEqual([
      "read",
      "flair_search",
      "flair_write",
      "flair_get",
      "discord_reply",
      "discord_fetch",
      "discord_react",
    ]);
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
