import { describe, expect, it } from "bun:test";
import { loadRole } from "../src/role-loader.js";

describe("role-loader", () => {
  it("loads the ea role template", () => {
    const t = loadRole("ea");
    expect(t.role).toBe("ea");
    expect(t.soul.length).toBeGreaterThan(0);
    expect(t.tools.allow).toContain("Bash");
    expect(t.tools.allow).toContain("mcp__flair__memory_search");
  });

  it.each([
    "writer",
    "reviewer",
    "coder",
    "qa",
    "custom",
  ] as const)("loads the %s role template", (role) => {
    const t = loadRole(role);
    expect(t.role).toBe(role);
    expect(t.soul.length).toBeGreaterThan(0);
    expect(t.tools.allow.length).toBeGreaterThan(0);
    // Every role gets Flair memory by default — the office-agent
    // pattern assumes Flair as the memory layer.
    expect(t.tools.allow).toContain("mcp__flair__memory_search");
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
