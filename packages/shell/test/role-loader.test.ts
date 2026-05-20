import { describe, it, expect } from "bun:test";
import { loadRole } from "../src/role-loader.js";

describe("role-loader", () => {
  it("loads the ea role template", () => {
    const t = loadRole("ea");
    expect(t.role).toBe("ea");
    expect(t.soul.length).toBeGreaterThan(0);
    expect(t.tools.allow).toContain("Bash");
    expect(t.tools.allow).toContain("mcp__flair__memory_search");
  });

  it("throws on unknown role", () => {
    // @ts-expect-error — intentionally bad role
    expect(() => loadRole("does-not-exist")).toThrow(/unknown role/);
  });
});
