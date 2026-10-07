// `bob init` rollback after a refused hire preserves an entry another writer
// left in the new agent directory (bob#326).
//
// Every test drives the real hire transaction in a scratch tree: the scaffold,
// the (injected) hiring interview, the file commit and the rollback. The
// injected failure is a nonzero interview exit — a failed interview is a failed
// hire — so the rollback runs on a fully scaffolded agent directory.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baselinePath,
  DEFAULT_POSITIONS_ROOT,
  grantPath,
  hireAgent,
  readGrant,
  type SessionRunner,
} from "../../src/shell/index.js";

interface Scratch {
  base: string;
  agentsRoot: string;
  hostRoot: string;
}

let s: Scratch;
const _dirs: string[] = [];
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "bob-rb-"));
  _dirs.push(base);
  s = { base, agentsRoot: join(base, "agents"), hostRoot: join(base, "host") };
  mkdirSync(s.agentsRoot, { recursive: true });
});
afterAll(() => {
  for (const d of _dirs) rmSync(d, { recursive: true, force: true });
});

const agentDirFor = (name: string) => join(s.agentsRoot, name);

// A hire that scaffolds, lets the test act on the new agent directory at the
// scaffold step, then fails its interview (exit 7) so the rollback runs.
function hireThatFails(
  name: string,
  onScaffold: (agentDir: string) => void,
  interview: SessionRunner = async () => 7,
) {
  return hireAgent({
    name,
    positionName: "builder",
    agentsRoot: s.agentsRoot,
    hostRoot: s.hostRoot,
    positionsRoot: DEFAULT_POSITIONS_ROOT,
    skipFlair: true,
    contextWindow: 200_000,
    interview,
    commitHook: (step) => {
      if (step === "scaffold") onScaffold(agentDirFor(name));
    },
  });
}

async function refusalOf(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return String((e as Error)?.message);
  }
  throw new Error("expected a refusal, but the call succeeded");
}

describe("bob#326 — a refused hire's rollback leaves a foreign entry in the agent directory", () => {
  it("preserves and names a file another writer placed in the new agent directory, removes init's files, keeps the directory", async () => {
    const name = "rb-competing";
    const agentDir = agentDirFor(name);
    const competing = join(agentDir, "writer-note.txt");

    const msg = await refusalOf(() =>
      hireThatFails(name, (dir) => {
        writeFileSync(join(dir, "writer-note.txt"), "another writer's file\n");
      }),
    );

    // The competing file survives byte-for-byte.
    expect(readFileSync(competing, "utf8")).toBe("another writer's file\n");
    // init's own entries are gone.
    expect(existsSync(join(agentDir, "soul.md"))).toBe(false);
    expect(existsSync(join(agentDir, "bob.yaml"))).toBe(false);
    expect(existsSync(join(agentDir, "bin"))).toBe(false);
    expect(existsSync(join(agentDir, ".pi-agent"))).toBe(false);
    // The directory remains, holding only the competing file.
    expect(readdirSync(agentDir)).toEqual(["writer-note.txt"]);
    // The refusal names it, relative to the agent directory.
    expect(msg).toContain("writer-note.txt");
    // No binding state was committed.
    expect(readGrant(s.hostRoot, name)).toBeUndefined();
    expect(existsSync(grantPath(s.hostRoot, name))).toBe(false);
    expect(existsSync(baselinePath(s.hostRoot, name))).toBe(false);
  });

  it("removes the directory entirely when no competing entry appeared", async () => {
    const name = "rb-clean";
    const msg = await refusalOf(() => hireThatFails(name, () => {}));
    expect(msg).toMatch(/exited with code 7/);
    expect(existsSync(agentDirFor(name))).toBe(false);
    expect(existsSync(grantPath(s.hostRoot, name))).toBe(false);
    expect(existsSync(baselinePath(s.hostRoot, name))).toBe(false);
  });

  it("keeps and names an entry init published that was replaced by a different file", async () => {
    const name = "rb-replaced";
    const agentDir = agentDirFor(name);
    const soul = join(agentDir, "soul.md");

    const msg = await refusalOf(() =>
      hireThatFails(name, (dir) => {
        // Replace init's published soul.md with a different file. The writer's
        // file is created first so it has its own inode, then renamed over
        // soul.md, so the entry at soul.md is no longer the one init published.
        writeFileSync(join(dir, "writer-soul.tmp"), "someone else's soul\n");
        renameSync(join(dir, "writer-soul.tmp"), join(dir, "soul.md"));
      }),
    );

    // The replacement is kept byte-for-byte and named.
    expect(readFileSync(soul, "utf8")).toBe("someone else's soul\n");
    expect(msg).toContain("soul.md");
    // init's other entries are removed.
    expect(existsSync(join(agentDir, "bob.yaml"))).toBe(false);
    expect(existsSync(grantPath(s.hostRoot, name))).toBe(false);
  });

  it("does not follow a symlink inside the directory during rollback", async () => {
    const name = "rb-symlink";
    const agentDir = agentDirFor(name);
    const target = join(s.base, "outside-target.txt");
    const link = join(agentDir, "link.txt");

    const msg = await refusalOf(() =>
      hireThatFails(name, (dir) => {
        writeFileSync(target, "outside\n");
        symlinkSync(target, join(dir, "link.txt"));
      }),
    );

    // The link's target, outside the agent directory, is untouched.
    expect(readFileSync(target, "utf8")).toBe("outside\n");
    // The link entry itself is preserved (never followed, never removed).
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(msg).toContain("link.txt");
  });
});
