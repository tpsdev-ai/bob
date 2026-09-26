// bob#183 — the openrouter provider: init renders the base URL + a DECLARED model,
// the run-time key comes from OPENROUTER_API_KEY (never written to disk), and an
// unset key is a refusal BEFORE any request. No network.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAgent } from "../../src/shell/init.js";
import { resolveRunConfig } from "../../src/shell/run.js";

const MODEL = "deepseek/deepseek-v4.1-flash";
const BASE_URL = "https://openrouter.ai/api/v1";

describe("openrouter provider (bob#183)", () => {
  let agentsRoot: string;
  let flairKeysDir: string;
  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-or-agents-"));
    flairKeysDir = mkdtempSync(join(tmpdir(), "bob-or-keys-"));
  });
  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(flairKeysDir, { recursive: true, force: true });
  });

  it("(a) init renders bob.yaml + the pi config with the OpenRouter base URL and the DECLARED model", () => {
    const r = initAgent({
      name: "orr",
      role: "coder",
      provider: "openrouter",
      model: MODEL,
      agentsRoot,
      flairKeysDir,
      skipFlair: true,
    });
    const yaml = readFileSync(join(r.agentDir, "bob.yaml"), "utf8");
    expect(yaml).toContain("name: openrouter");
    expect(yaml).toContain(MODEL);

    const models = JSON.parse(readFileSync(join(r.agentDir, ".pi-agent", "models.json"), "utf8"));
    // The model is DECLARED under providers.openrouter.models (never a bare baseUrl).
    expect(models.providers.openrouter.baseUrl).toBe(BASE_URL);
    expect(models.providers.openrouter.models).toEqual([{ id: MODEL, name: MODEL }]);
  });

  it("(b) `bob run` refuses BEFORE any request when OPENROUTER_API_KEY is unset, naming the variable", () => {
    const r = initAgent({
      name: "orr2",
      role: "coder",
      provider: "openrouter",
      model: MODEL,
      agentsRoot,
      flairKeysDir,
      skipFlair: true,
    });
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => resolveRunConfig({ name: "orr2", agentsRoot })).toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it("(c) the rendered files NEVER contain the env value (sentinel)", () => {
    const sentinel = "sk-or-v1-THIS-IS-A-SENTINEL-KEY-DO-NOT-WRITE";
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = sentinel;
    try {
      const r = initAgent({
        name: "orr3",
        role: "coder",
        provider: "openrouter",
        model: MODEL,
        agentsRoot,
        flairKeysDir,
        skipFlair: true,
      });
      for (const f of ["bob.yaml", ".pi-agent/models.json", ".pi-agent/auth.json", "launch.sh"]) {
        const p = join(r.agentDir, f);
        let text = "";
        try {
          text = readFileSync(p, "utf8");
        } catch {
          continue; // file not emitted for this shape
        }
        expect(text, `${f} must not contain the key`).not.toContain(sentinel);
      }
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });
});
