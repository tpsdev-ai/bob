import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "dist", "cli.js");

describe("bob CLI", () => {
  it("prints help on `bob help`", () => {
    const out = execSync(`node ${CLI} help`, { encoding: "utf8" });
    expect(out).toContain("Bob — moldable office-agent shell");
    expect(out).toContain("Commands:");
  });

  it("onboard --dry-run shows the plan without writing", () => {
    const out = execSync(`node ${CLI} onboard testbot --role ea --dry-run`, { encoding: "utf8" });
    expect(out).toContain("[bob onboard] PLAN (--dry-run)");
    expect(out).toContain("agent.id        = testbot");
    expect(out).toContain("agent.role      = ea");
  });

  it("onboard fails for unknown role", () => {
    try {
      execSync(`node ${CLI} onboard testbot --role nonexistent --dry-run 2>&1`, { encoding: "utf8" });
      throw new Error("expected non-zero exit");
    } catch (err: any) {
      expect(err.stdout || err.message).toContain("unknown role");
    }
  });

  it("init is a soft alias for onboard (with deprecation hint)", () => {
    const out = execSync(`node ${CLI} init testbot --role ea --dry-run 2>&1`, { encoding: "utf8" });
    expect(out).toContain("renamed to `bob onboard`");
    expect(out).toContain("[bob onboard] PLAN (--dry-run)");
  });

  it("align prints its PR-9 stub", () => {
    const out = execSync(`node ${CLI} align testbot`, { encoding: "utf8" });
    expect(out).toContain("PR-9 stub");
    expect(out).toContain("persona:testbot");
  });
});
