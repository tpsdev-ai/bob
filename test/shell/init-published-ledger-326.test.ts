// `initAgent`'s rollback ledger (bob#326): `onPublished` records each directory
// entry the scaffold creates, so a caller can remove exactly its own entries
// after init refuses part-way through a hire.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAgent } from "../../src/shell/index.js";
import type { PublishedEntry } from "../../src/shell/init.js";

let agentsRoot: string;
const _dirs: string[] = [];
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "bob-led-"));
  _dirs.push(base);
  agentsRoot = join(base, "agents");
  mkdirSync(agentsRoot, { recursive: true });
});
afterAll(() => {
  for (const d of _dirs) rmSync(d, { recursive: true, force: true });
});

const scaffold = (
  name: string,
  onPublished: (e: PublishedEntry) => void,
  beforePublish?: (path: string) => void,
) =>
  initAgent({
    name,
    role: "coder",
    provider: "exe-dev-gateway",
    model: "claude-sonnet-4-6",
    agentsRoot,
    skipFlair: true,
    onPublished,
    ...(beforePublish !== undefined ? { beforePublish } : {}),
  });

describe("bob#326 — initAgent records each entry it publishes", () => {
  it("records the agent directory, the sub-directories and every file it created", () => {
    const name = "led-complete";
    const agentDir = join(agentsRoot, name);
    const ledger: PublishedEntry[] = [];
    scaffold(name, (e) => ledger.push(e));

    const expected = [
      agentDir,
      join(agentDir, "bin"),
      join(agentDir, "work"),
      join(agentDir, "memory"),
      join(agentDir, ".pi-agent"),
      join(agentDir, "soul.md"),
      join(agentDir, "bob.yaml"),
      join(agentDir, ".pi-agent", "models.json"),
      join(agentDir, ".pi-agent", "auth.json"),
      join(agentDir, "bin", name),
    ];
    expect(ledger.map((e) => e.path).sort()).toEqual(expected.slice().sort());
    // Every recorded entry exists, and its recorded kind matches disk.
    for (const e of ledger) {
      const st = lstatSync(e.path);
      expect(st.isDirectory() ? "dir" : "file").toBe(e.kind);
    }
  });

  it("does not record a path where a competing writer's entry made the publish refuse", () => {
    const name = "led-competitor";
    const agentDir = join(agentsRoot, name);
    const soul = join(agentDir, "soul.md");
    const ledger: PublishedEntry[] = [];

    expect(() =>
      scaffold(
        name,
        (e) => ledger.push(e),
        (path) => {
          if (path === soul) writeFileSync(soul, "another writer\n");
        },
      ),
    ).toThrow(/refusing to write/);

    // The entries created before the refusal are recorded...
    const paths = ledger.map((e) => e.path);
    expect(paths).toContain(agentDir);
    expect(paths).toContain(join(agentDir, ".pi-agent"));
    // ...and the path the competitor took is not.
    expect(paths).not.toContain(soul);
    // The competitor's file is untouched.
    expect(readFileSync(soul, "utf8")).toBe("another writer\n");
  });
});
