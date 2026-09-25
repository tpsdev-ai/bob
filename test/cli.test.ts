import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  it.each(["up", "down", "restart", "install-service"] as const)("%s requires a <name>", (cmd) => {
    try {
      execSync(`node ${CLI} ${cmd} 2>&1`, { encoding: "utf8" });
      throw new Error(`expected non-zero exit for bare '${cmd}'`);
    } catch (err) {
      const e = err as { stdout?: string; message?: string };
      expect(e.stdout || e.message).toContain(`bob ${cmd}: missing <name>`);
    }
  });
});

// The `--key=value` boolean-flag path, end to end (#173). A valueless form
// (`--dry-run` alone) parses to the boolean true, but the `--key=value` form
// (`--dry-run=true`) parses to the STRING "true". The boolean consumers used to
// read that with `=== true`, which is false for the string — so `--dry-run=true`
// silently skipped the dry-run branch and scaffolded + provisioned the Flair
// identity for real (the opposite of the request); `--no-flair=true` likewise
// still registered. `boolFlag` whitelists only `=true` / `=false` (and the bare
// form) and rejects other spellings with a UsageError. These drive the CLI (not
// parseArgs alone), so the whole path is covered, with HOME isolated to a
// scratch dir so no test writes into a real agent tree.
describe("--key=value boolean flags (parser-to-CLI)", () => {
  function scratchHome(): string {
    return mkdtempSync(join(tmpdir(), "bob-boolflag-"));
  }
  // Run a CLI subcommand with HOME pointed at a scratch dir; `2>&1` folds
  // stderr (console.error) into the output bun:test captures on a non-zero exit.
  function runCli(args: string, home: string): string {
    try {
      return execSync(`node ${CLI} ${args} 2>&1`, {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; message?: string };
      return e.stdout || e.message || "";
    }
  }

  it("--dry-run=true takes the dry-run branch — prints the plan and creates no agent dir", () => {
    const home = scratchHome();
    const out = runCli("onboard testbot --role ea --dry-run=true", home);
    expect(out).toContain("PLAN (--dry-run)");
    // The dry-run branch returns before initAgent, so no agent dir was written:
    // `--dry-run=true` can no longer scaffold, let alone provision, for real.
    expect(existsSync(join(home, "agents", "testbot"))).toBe(false);
  });

  it("--dry-run=false does NOT take the dry-run branch — it scaffolds for real", () => {
    const home = scratchHome();
    // --no-flair + --no-interactive keep the real branch filesystem-only (no
    // network, no interview), so the assert is deterministic instead of a hang.
    const out = runCli(
      "onboard testbot --role ea --dry-run=false --no-flair=true --no-interactive=true",
      home,
    );
    expect(out).not.toContain("PLAN (--dry-run)");
    expect(out).toContain("scaffolded testbot");
    expect(existsSync(join(home, "agents", "testbot"))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it("--dry-run=yes fails with a usage error on a non-zero exit BEFORE any side effect", () => {
    const home = scratchHome();
    let out = "";
    let threw = false;
    // execSync throws on a non-zero exit, which is the signal we expect here.
    try {
      out = execSync(`node ${CLI} onboard testbot --role ea --dry-run=yes 2>&1`, {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
    } catch (err: unknown) {
      threw = true;
      const e = err as { stdout?: string; message?: string };
      out = e.stdout || e.message || out || "";
    }
    expect(threw).toBe(true); // a non-zero exit
    expect(out).toContain("takes no value"); // names the flag + the accepted values
    expect(out).toContain("yes"); // names the offending value
    expect(out).not.toContain("    at "); // a usage error, never a stack trace
    // No side effect: the UsageError is thrown while parsing, before any
    // command runs, so no agent dir exists.
    expect(existsSync(join(home, "agents", "testbot"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("an empty --dry-run= is a usage error too, exit 2, before any side effect", () => {
    const home = scratchHome();
    let status = 0;
    let out = "";
    try {
      execSync(`node ${CLI} onboard testbot --role ea --dry-run= 2>&1`, {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? -1;
      out = e.stdout ?? "";
    }
    expect(status).toBe(2);
    expect(out).toContain("--dry-run takes no value");
    expect(existsSync(join(home, "agents", "testbot"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("an empty --model= / --provider= on onboard means the default, never an empty id in bob.yaml", () => {
    const home = scratchHome();
    const out = runCli(
      "onboard testbot --role ea --model= --provider= --no-flair --no-interactive",
      home,
    );
    expect(out).toContain("scaffolded testbot");
    const yaml = readFileSync(join(home, "agents", "testbot", "bob.yaml"), "utf8");
    expect(yaml).toContain("name: ollama-cloud");
    expect(yaml).toContain("model: kimi-k2.6");
    expect(yaml).not.toMatch(/model:\s*$/m);
    rmSync(home, { recursive: true, force: true });
  });

  it("a bare --model on onboard means the default too — never the literal id 'true'", () => {
    const home = scratchHome();
    const out = runCli("onboard testbot --role ea --model --no-flair --no-interactive", home);
    expect(out).toContain("scaffolded testbot");
    const yaml = readFileSync(join(home, "agents", "testbot", "bob.yaml"), "utf8");
    expect(yaml).toContain("model: kimi-k2.6");
    expect(yaml).not.toContain("model: true");
    rmSync(home, { recursive: true, force: true });
  });

  it("bob align refuses a bad --no-flair spelling BEFORE its session can rewrite soul.md", () => {
    const home = scratchHome();
    // A real (filesystem-only) agent to align: no Flair, no interview.
    runCli("onboard testbot --role ea --no-flair --no-interactive", home);
    const soul = join(home, "agents", "testbot", "soul.md");
    expect(existsSync(soul)).toBe(true);
    const before = readFileSync(soul, "utf8");
    let status = 0;
    let out = "";
    try {
      execSync(`node ${CLI} align testbot --no-flair=yes 2>&1`, {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? -1;
      out = e.stdout ?? "";
    }
    expect(status).toBe(2);
    expect(out).toContain("--no-flair takes no value");
    expect(out).not.toContain("starting alignment check"); // no session was started
    expect(readFileSync(soul, "utf8")).toBe(before);
    rmSync(home, { recursive: true, force: true });
  });
});
