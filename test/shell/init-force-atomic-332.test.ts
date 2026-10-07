import { afterEach, describe, expect, it } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InitOptions, initAgent } from "../../src/shell/init.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bob-332-"));
  roots.push(root);
  return root;
}

function forceInit(root: string, extra: Partial<InitOptions> = {}) {
  return initAgent({
    name: "agent-a",
    role: "coder",
    provider: "ollama-cloud",
    model: "fixture-model",
    contextWindow: 200_000,
    agentsRoot: root,
    skipFlair: true,
    noClobber: false,
    ...extra,
  });
}

function tempFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".tmp"));
}

describe("bob#332 — a --force publish replaces the destination by rename", () => {
  it("keeps an existing 0600 bob.yaml at 0600 under umask 022", () => {
    const root = newRoot();
    const agentDir = join(root, "agent-a");
    mkdirSync(agentDir, { recursive: true });
    const yamlPath = join(agentDir, "bob.yaml");
    writeFileSync(yamlPath, "original\n", { mode: 0o600 });

    const previousUmask = process.umask(0o022);
    try {
      forceInit(root);
    } finally {
      process.umask(previousUmask);
    }

    expect(readFileSync(yamlPath, "utf8")).toContain("fixture-model");
    expect(lstatSync(yamlPath).mode & 0o777).toBe(0o600);
    expect(tempFilesUnder(agentDir)).toEqual([]);
  });

  it("replaces a destination symlink with a regular file and leaves the link target alone", () => {
    const root = newRoot();
    const agentDir = join(root, "agent-a");
    mkdirSync(agentDir, { recursive: true });
    const soulPath = join(agentDir, "soul.md");
    const target = join(root, "soul-target.md");
    writeFileSync(target, "the link target\n");
    symlinkSync(target, soulPath);

    forceInit(root);

    expect(readFileSync(soulPath, "utf8")).toContain("You are Agent-a");
    expect(readFileSync(target, "utf8")).toBe("the link target\n");
    expect(lstatSync(soulPath).isSymbolicLink()).toBe(false);
    expect(tempFilesUnder(agentDir)).toEqual([]);
  });
});
