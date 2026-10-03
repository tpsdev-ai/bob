import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpawnError, spawnNode } from "../cli-spawn.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bob-186s2-def-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const REGISTRY = `version: 1
providers:
  - id: acme
    aliases: []
    runtime: acme
    auth: bob/none
    endpoint: http://127.0.0.1:11434/v1
    api: openai-completions
    override: {}
defaults:
  onboard: acme
  hire: acme
`;

describe("bob#186 slice 2 — the registry's default selection drives the CLI", () => {
  it("bob hire passes the operator's selected default to the hire path", () => {
    mkdirSync(join(home, ".config", "bob"), { recursive: true });
    writeFileSync(join(home, ".config", "bob", "providers.yaml"), REGISTRY);
    const runtime = join(import.meta.dir, "../../dist/shell/position-runtime.js");
    const cli = join(import.meta.dir, "../../dist/cli.js");
    const script = `import { mock } from 'bun:test'; const runtime = await import(${JSON.stringify(runtime)}); mock.module(${JSON.stringify(runtime)}, () => ({ ...runtime, hireAgent: async (opts) => { throw new Error('SELECTED_PROVIDER:' + opts.provider); } })); process.argv = [process.execPath, ${JSON.stringify(cli)}, 'hire', 'candidate', '--as', 'builder', '--context-window=262144']; await import(${JSON.stringify(cli)});`;
    let failure: unknown;
    try {
      spawnNode(["-e", script], { env: { ...process.env, HOME: home } });
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(SpawnError);
    expect((failure as SpawnError).stdout).toContain("SELECTED_PROVIDER:acme");
  });
  it("bob onboard scaffolds onto the operator's default provider, not a hardcoded name", () => {
    mkdirSync(join(home, ".config", "bob"), { recursive: true });
    writeFileSync(join(home, ".config", "bob", "providers.yaml"), REGISTRY);
    spawnNode(
      [
        join(import.meta.dir, "../../dist/cli.js"),
        "onboard",
        "acmebot",
        "--no-flair",
        "--no-interactive",
        "--context-window=262144",
        "--agents-root",
        join(home, "agents"),
      ],
      { env: { ...process.env, HOME: home } },
    );
    const yaml = readFileSync(join(home, "agents", "acmebot", "bob.yaml"), "utf8");
    expect(yaml).toContain("name: acme");
    const models = JSON.parse(
      readFileSync(join(home, "agents", "acmebot", ".pi-agent", "models.json"), "utf8"),
    ) as { providers: Record<string, { baseUrl?: string }> };
    expect(models.providers.acme?.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
});
