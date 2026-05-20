import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "dist", "cli.js");

describe("milton CLI", () => {
  it("prints help on `milton help`", () => {
    const out = execSync(`node ${CLI} help`, { encoding: "utf8" });
    expect(out).toContain("Milton — moldable office-agent shell");
    expect(out).toContain("Commands:");
  });

  it("init --dry-run shows the plan without writing", () => {
    const out = execSync(`node ${CLI} init testbot --role ea --dry-run`, { encoding: "utf8" });
    expect(out).toContain("[milton init] PLAN (--dry-run)");
    expect(out).toContain("agent.id        = testbot");
    expect(out).toContain("agent.role      = ea");
  });

  it("init fails for unknown role", () => {
    try {
      execSync(`node ${CLI} init testbot --role nonexistent --dry-run 2>&1`, { encoding: "utf8" });
      throw new Error("expected non-zero exit");
    } catch (err: any) {
      expect(err.stdout || err.message).toContain("unknown role");
    }
  });
});
