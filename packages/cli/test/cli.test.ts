import { describe, expect, it } from "bun:test";
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
      execSync(`node ${CLI} onboard testbot --role nonexistent --dry-run 2>&1`, {
        encoding: "utf8",
      });
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

  it("onboard --no-interactive renders the plan with interview SKIPPED", () => {
    const out = execSync(`node ${CLI} onboard testbot --role ea --dry-run --no-interactive`, {
      encoding: "utf8",
    });
    expect(out).toContain("interview       = SKIPPED");
  });

  it("onboard --dry-run plans an interactive pi session by default", () => {
    const out = execSync(`node ${CLI} onboard testbot --role ea --dry-run`, { encoding: "utf8" });
    expect(out).toContain("interview       = interactive pi session");
  });

  it("help advertises align flags", () => {
    const out = execSync(`node ${CLI} help`, { encoding: "utf8" });
    expect(out).toContain("align <name>");
    expect(out).toContain("--agent-dir");
  });

  it("help advertises persistent run + lifecycle commands", () => {
    const out = execSync(`node ${CLI} help`, { encoding: "utf8" });
    expect(out).toContain("serve <name>");
    expect(out).toContain("PERSISTENTLY");
    expect(out).toContain("install-service");
    expect(out).toContain("up <name>");
    expect(out).toContain("down <name>");
    expect(out).toContain("restart <name>");
  });

  it("lifecycle commands require a <name>", () => {
    for (const cmd of ["up", "down", "restart", "install-service", "serve"]) {
      try {
        execSync(`node ${CLI} ${cmd} 2>&1`, { encoding: "utf8" });
        throw new Error(`expected non-zero exit for bare '${cmd}'`);
      } catch (err) {
        const e = err as { stdout?: string; message?: string };
        expect(e.stdout || e.message).toContain(`bob ${cmd}: missing <name>`);
      }
    }
  });
});
