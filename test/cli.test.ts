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

  it("onboard --dry-run states that it will provision the Flair identity (#93/#94)", () => {
    const out = execSync(`node ${CLI} onboard testbot --role ea --dry-run`, { encoding: "utf8" });
    expect(out).toContain("flair identity  = Agent record + soul at http://127.0.0.1:19926");
  });

  it("onboard --dry-run --no-flair states the identity is SKIPPED", () => {
    const out = execSync(`node ${CLI} onboard testbot --role ea --dry-run --no-flair`, {
      encoding: "utf8",
    });
    expect(out).toContain("flair identity  = SKIPPED (--no-flair)");
  });

  it("onboard --dry-run honours --flair-url", () => {
    const out = execSync(
      `node ${CLI} onboard testbot --role ea --dry-run --flair-url http://hub.example:19926`,
      { encoding: "utf8" },
    );
    expect(out).toContain("Agent record + soul at http://hub.example:19926");
  });

  it("help documents the admin credential channel — and that it is never a flag", () => {
    const out = execSync(`node ${CLI} help`, { encoding: "utf8" });
    expect(out).toContain("FLAIR_ADMIN_PASS");
    expect(out).toContain("Never pass it as a flag");
    expect(out).toContain("--no-flair");
    // There must be no --admin-pass flag to find: a credential in argv is
    // world-readable and lands in shell history.
    expect(out).not.toContain("--admin-pass");
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
    expect(out).toContain("run <name>");
    expect(out).toContain("PERSISTENTLY"); // run-with-no-prompt = persistent on-duty
    expect(out).not.toContain("serve <name>"); // serve is retired
    expect(out).toContain("install-service");
    expect(out).toContain("up <name>");
    expect(out).toContain("down <name>");
    expect(out).toContain("restart <name>");
  });

  // One case per command: each spawn costs ~1.2 s on a CI runner, and four of
  // them inside a single test raced bun's 5 s default budget (timed out at
  // 5075 ms on 2026-09-03). it.each gives every command its own budget and its
  // own name in the report — the shape test/shell/role-loader.test.ts uses.
  it.each(["up", "down", "restart", "install-service"] as const)(
    "%s requires a <name>",
    (cmd) => {
      try {
        execSync(`node ${CLI} ${cmd} 2>&1`, { encoding: "utf8" });
        throw new Error(`expected non-zero exit for bare '${cmd}'`);
      } catch (err) {
        const e = err as { stdout?: string; message?: string };
        expect(e.stdout || e.message).toContain(`bob ${cmd}: missing <name>`);
      }
    },
  );
});
