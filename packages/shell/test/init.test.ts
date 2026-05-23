import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAgent } from "../src/init.js";

describe("initAgent", () => {
  let tmpRoot: string;
  let keysRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "bob-init-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-keys-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  // Shared default opts — every test routes Flair keys into a temp dir
  // so we never touch ~/.flair/keys/. Tests that need to vary something
  // override via spread.
  const baseOpts = () => ({
    name: "testbot",
    role: "ea" as const,
    provider: "ollama-cloud",
    model: "kimi-k2.6",
    agentsRoot: tmpRoot,
    flairKeysDir: keysRoot,
  });

  it("creates the full directory tree", () => {
    const res = initAgent(baseOpts());
    expect(res.agentDir).toBe(join(tmpRoot, "testbot"));
    expect(existsSync(join(res.agentDir, "bin"))).toBe(true);
    expect(existsSync(join(res.agentDir, "work"))).toBe(true);
    expect(existsSync(join(res.agentDir, "memory"))).toBe(true);
    expect(existsSync(join(res.agentDir, ".pi-agent"))).toBe(true);
  });

  it("writes soul.md from the role template", () => {
    const res = initAgent(baseOpts());
    const soul = readFileSync(join(res.agentDir, "soul.md"), "utf8");
    expect(soul).toContain("EA");
    expect(soul.length).toBeGreaterThan(500);
  });

  it("writes bob.yaml with provider + model + tools", () => {
    const res = initAgent({ ...baseOpts(), provider: "exe-dev-gateway", model: "claude-opus-4-7" });
    const yaml = readFileSync(join(res.agentDir, "bob.yaml"), "utf8");
    expect(yaml).toContain("id: testbot");
    expect(yaml).toContain("role: ea");
    expect(yaml).toContain("name: exe-dev-gateway");
    expect(yaml).toContain("model: claude-opus-4-7");
    expect(yaml).toContain("- Bash");
    expect(yaml).toContain("- mcp__flair__memory_store");
  });

  it("generates an executable bin/<name> launcher", () => {
    const res = initAgent(baseOpts());
    const bin = join(res.agentDir, "bin", "testbot");
    const launcher = readFileSync(bin, "utf8");
    expect(launcher).toContain("#!/bin/sh");
    expect(launcher).toContain("pi --provider ollama-cloud --model kimi-k2.6");
    expect(launcher).toContain("PI_CODING_AGENT_DIR=");
    const mode = statSync(bin).mode & 0o777;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it("uses sh shebang (not zsh) — preserves env-prefix invocations", () => {
    const res = initAgent(baseOpts());
    const launcher = readFileSync(join(res.agentDir, "bin", "testbot"), "utf8");
    expect(launcher.startsWith("#!/bin/sh")).toBe(true);
    expect(launcher.startsWith("#!/bin/zsh")).toBe(false);
  });

  it("refuses to clobber an existing agent dir by default", () => {
    const opts = baseOpts();
    initAgent(opts);
    expect(() => initAgent(opts)).toThrow(/already exists/);
  });

  it("overwrites when noClobber=false", () => {
    const opts = baseOpts();
    initAgent(opts);
    const res = initAgent({ ...opts, noClobber: false });
    expect(res.files.length).toBeGreaterThan(0);
  });

  it("rejects invalid agent names (path-traversal guard)", () => {
    expect(() => initAgent({ ...baseOpts(), name: "../etc" })).toThrow(/invalid agent name/);
  });

  it("propagates loadRole's invalid-role rejection", () => {
    expect(() =>
      initAgent({
        ...baseOpts(),
        // @ts-expect-error — bad role
        role: "../../../etc",
      }),
    ).toThrow(/invalid role name/);
  });

  it("generates a Flair Ed25519 keypair by default", () => {
    const res = initAgent(baseOpts());
    expect(res.flair).toBeDefined();
    expect(res.flair?.publicKeyBase64.length).toBe(44);
    expect(existsSync(res.flair?.privateKeyPath)).toBe(true);
    expect(existsSync(res.flair?.publicKeyPath)).toBe(true);
    expect(res.files).toContain(res.flair?.privateKeyPath);
    expect(res.files).toContain(res.flair?.publicKeyPath);
  });

  it("skips Flair keypair when skipFlair=true", () => {
    const res = initAgent({ ...baseOpts(), skipFlair: true });
    expect(res.flair).toBeUndefined();
    // Files list shouldn't include any .key/.pub paths
    expect(res.files.some((f) => f.endsWith(".key"))).toBe(false);
    expect(res.files.some((f) => f.endsWith(".pub"))).toBe(false);
  });

  it("private key is mode 0600", () => {
    const res = initAgent(baseOpts());
    const mode = statSync(res.flair?.privateKeyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  describe("pi launcher generation", () => {
    it("appends --append-system-prompt to load soul.md", () => {
      const res = initAgent(baseOpts());
      const launcher = readFileSync(join(res.agentDir, "bin", "testbot"), "utf8");
      expect(launcher).toContain("--append-system-prompt");
      expect(launcher).toContain('"$(cat $AGENT_DIR/soul.md)"');
    });

    it("translates exe-dev-gateway provider to anthropic in the launcher", () => {
      const res = initAgent({
        ...baseOpts(),
        provider: "exe-dev-gateway",
        model: "claude-opus-4-7",
      });
      const launcher = readFileSync(join(res.agentDir, "bin", "testbot"), "utf8");
      expect(launcher).toContain("--provider anthropic");
      expect(launcher).not.toContain("--provider exe-dev-gateway");
      expect(launcher).toContain("--model claude-opus-4-7");
    });

    it("passes other provider names through unchanged", () => {
      const res = initAgent({ ...baseOpts(), provider: "ollama-cloud", model: "kimi-k2.6" });
      const launcher = readFileSync(join(res.agentDir, "bin", "testbot"), "utf8");
      expect(launcher).toContain("--provider ollama-cloud");
    });

    it("opt-in sources $HOME/.tps/secrets/<name>-github-pat into GH_TOKEN", () => {
      // Pattern: intel-gathering agents (Pulse, future EAs) hit GitHub for
      // releases.atom + REST API. Anonymous = 60/hr; authenticated = 5000/hr.
      // The launcher reads from a 0600 file so the token never lands in
      // process listings or env-dump output, and silently skips when absent.
      const res = initAgent({ ...baseOpts(), name: "pulse" });
      const launcher = readFileSync(join(res.agentDir, "bin", "pulse"), "utf8");
      expect(launcher).toContain('GH_PAT_FILE="$HOME/.tps/secrets/pulse-github-pat"');
      expect(launcher).toContain('if [ -r "$GH_PAT_FILE" ]; then');
      expect(launcher).toContain("export GH_TOKEN");
    });
  });

  describe("pi agent config (.pi-agent/{models,auth}.json)", () => {
    it("writes models.json + auth.json for exe-dev-gateway provider", () => {
      const res = initAgent({
        ...baseOpts(),
        provider: "exe-dev-gateway",
        model: "claude-opus-4-7",
      });
      const modelsPath = join(res.agentDir, ".pi-agent", "models.json");
      const authPath = join(res.agentDir, ".pi-agent", "auth.json");
      expect(existsSync(modelsPath)).toBe(true);
      expect(existsSync(authPath)).toBe(true);
      expect(res.files).toContain(modelsPath);
      expect(res.files).toContain(authPath);

      const models = JSON.parse(readFileSync(modelsPath, "utf8"));
      expect(models.providers.anthropic.baseUrl).toBe(
        "http://169.254.169.254/gateway/llm/anthropic",
      );

      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      expect(auth.anthropic.type).toBe("api_key");
      // Placeholder value — the gateway uses VM identity, not the literal key
      expect(auth.anthropic.key).toBe("exe-gateway-placeholder");
    });

    it("auth.json is mode 0600 (credentials must not be world-readable)", () => {
      const res = initAgent({
        ...baseOpts(),
        provider: "exe-dev-gateway",
        model: "claude-opus-4-7",
      });
      const authPath = join(res.agentDir, ".pi-agent", "auth.json");
      const mode = statSync(authPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("does NOT write models.json/auth.json for non-gateway providers", () => {
      const res = initAgent({ ...baseOpts(), provider: "ollama-cloud", model: "kimi-k2.6" });
      const modelsPath = join(res.agentDir, ".pi-agent", "models.json");
      const authPath = join(res.agentDir, ".pi-agent", "auth.json");
      expect(existsSync(modelsPath)).toBe(false);
      expect(existsSync(authPath)).toBe(false);
    });
  });
});
