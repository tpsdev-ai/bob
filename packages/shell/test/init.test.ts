import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initAgent } from "../src/init.js";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("initAgent", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "milton-init-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("creates the full directory tree", () => {
    const res = initAgent({
      name: "testbot",
      role: "ea",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot: tmpRoot,
    });
    expect(res.agentDir).toBe(join(tmpRoot, "testbot"));
    expect(existsSync(join(res.agentDir, "bin"))).toBe(true);
    expect(existsSync(join(res.agentDir, "work"))).toBe(true);
    expect(existsSync(join(res.agentDir, "memory"))).toBe(true);
    expect(existsSync(join(res.agentDir, ".pi-agent"))).toBe(true);
  });

  it("writes soul.md from the role template", () => {
    const res = initAgent({
      name: "testbot",
      role: "ea",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot: tmpRoot,
    });
    const soul = readFileSync(join(res.agentDir, "soul.md"), "utf8");
    expect(soul).toContain("EA");
    expect(soul.length).toBeGreaterThan(500);
  });

  it("writes milton.yaml with provider + model + tools", () => {
    const res = initAgent({
      name: "testbot",
      role: "ea",
      provider: "exe-dev-gateway",
      model: "claude-opus-4-7",
      agentsRoot: tmpRoot,
    });
    const yaml = readFileSync(join(res.agentDir, "milton.yaml"), "utf8");
    expect(yaml).toContain("id: testbot");
    expect(yaml).toContain("role: ea");
    expect(yaml).toContain("name: exe-dev-gateway");
    expect(yaml).toContain("model: claude-opus-4-7");
    expect(yaml).toContain("- Bash");
    expect(yaml).toContain("- mcp__flair__memory_store");
  });

  it("generates an executable bin/<name> launcher", () => {
    const res = initAgent({
      name: "testbot",
      role: "ea",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot: tmpRoot,
    });
    const bin = join(res.agentDir, "bin", "testbot");
    const launcher = readFileSync(bin, "utf8");
    expect(launcher).toContain("#!/bin/sh");
    expect(launcher).toContain("pi --provider ollama-cloud --model kimi-k2.6");
    expect(launcher).toContain("PI_CODING_AGENT_DIR=");
    // Executable bit (octal mode AND 0o111 == 0o111 means at least one exec bit set)
    const mode = statSync(bin).mode & 0o777;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it("uses sh shebang (not zsh) — preserves env-prefix invocations", () => {
    const res = initAgent({
      name: "testbot",
      role: "ea",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot: tmpRoot,
    });
    const launcher = readFileSync(join(res.agentDir, "bin", "testbot"), "utf8");
    expect(launcher.startsWith("#!/bin/sh")).toBe(true);
    expect(launcher.startsWith("#!/bin/zsh")).toBe(false);
  });

  it("refuses to clobber an existing agent dir by default", () => {
    const opts = {
      name: "testbot",
      role: "ea" as const,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot: tmpRoot,
    };
    initAgent(opts);
    expect(() => initAgent(opts)).toThrow(/already exists/);
  });

  it("overwrites when noClobber=false", () => {
    const opts = {
      name: "testbot",
      role: "ea" as const,
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot: tmpRoot,
    };
    initAgent(opts);
    // Should not throw
    const res = initAgent({ ...opts, noClobber: false });
    expect(res.files.length).toBeGreaterThan(0);
  });

  it("rejects invalid agent names (path-traversal guard)", () => {
    expect(() => initAgent({
      name: "../etc",
      role: "ea",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot: tmpRoot,
    })).toThrow(/invalid agent name/);
  });

  it("propagates loadRole's invalid-role rejection", () => {
    expect(() => initAgent({
      name: "testbot",
      // @ts-expect-error — bad role
      role: "../../../etc",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot: tmpRoot,
    })).toThrow(/invalid role name/);
  });
});
