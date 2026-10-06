// bob#332: a mode-less `init --force` publish goes through a sibling temp file
// and a rename, so a destination symlink is replaced rather than followed; and a
// temp file a killed run left behind is removed by the next init.
import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
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
  it("replaces a destination symlink with a regular file and leaves the link target alone", () => {
    const root = newRoot();
    const agentDir = join(root, "agent-a");
    mkdirSync(agentDir, { recursive: true });
    const soulPath = join(agentDir, "soul.md");
    const target = join(root, "soul-target.md");
    writeFileSync(target, "the link target\n");
    symlinkSync(target, soulPath);
    expect(lstatSync(soulPath).isSymbolicLink()).toBe(true);

    forceInit(root);

    // The destination is the regular file the rename installed, not the symlink
    // the mode-less write used to follow.
    expect(lstatSync(soulPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("the link target\n");
    expect(readFileSync(soulPath, "utf8")).toContain("You are Agent-a");
    expect(tempFilesUnder(agentDir)).toEqual([]);
  });
});

describe("bob#332 — a killed run's temp file is removed by the next init", () => {
  it("removes a leftover init temp file and leaves an entry that is not one alone", () => {
    const root = newRoot();
    const agentDir = join(root, "agent-a");
    const piDir = join(agentDir, ".pi-agent");
    mkdirSync(piDir, { recursive: true });
    const leftoverTop = join(agentDir, `.soul.md-${randomUUID()}.tmp`);
    const leftoverPi = join(piDir, `.auth.json-${randomUUID()}.tmp`);
    const foreign = join(agentDir, ".notes.tmp");
    const foreignPi = join(piDir, ".auth.json-not-a-uuid.tmp");
    for (const path of [leftoverTop, leftoverPi, foreign, foreignPi]) {
      writeFileSync(path, "leftover\n");
    }

    forceInit(root);

    expect(existsSync(leftoverTop)).toBe(false);
    expect(existsSync(leftoverPi)).toBe(false);
    expect(readFileSync(foreign, "utf8")).toBe("leftover\n");
    expect(readFileSync(foreignPi, "utf8")).toBe("leftover\n");
  });
});
