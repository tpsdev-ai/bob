// Real-file bind rollback failure injections (bob#326).

import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  directoryInode,
  entriesUnder,
  hire,
  newScratch,
  readEntry,
  refusalOf,
  replaceWithForeignFile,
  type Scratch,
} from "./rollback-326-helpers.js";

const scratches: Scratch[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const scratch = (): Scratch => {
  const s = newScratch("bob-rbb-");
  scratches.push(s);
  return s;
};
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});
afterAll(() => {
  for (const s of scratches) rmSync(s.base, { recursive: true, force: true });
});

type FsOp = "renameSync" | "rmdirSync" | "unlinkSync";

// Run `before(path)` once, just before the first call of one of `ops` whose
// first argument satisfies `match`; the call itself then runs for real.
function onceBefore(ops: FsOp[], match: (path: string) => boolean, before: (path: string) => void) {
  let fired = false;
  const reals = { renameSync: fs.renameSync, rmdirSync: fs.rmdirSync, unlinkSync: fs.unlinkSync };
  for (const op of ops) {
    const real = reals[op] as (...a: unknown[]) => unknown;
    spies.push(
      spyOn(fs, op).mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
        if (!fired && match(String(path))) {
          fired = true;
          before(String(path));
        }
        return real(path, ...rest);
      }) as never),
    );
  }
  return () => fired;
}

describe("bob#326 — replacements at the original path during quarantine rollback", () => {
  it("the agent directory replaced after its identity check: the replacement stays at the original path", async () => {
    const s = scratch();
    const name = "rbb-root";
    const agentDir = join(s.agentsRoot, name);
    const aside = join(s.base, "init-scaffold-aside");
    let foreignIno: bigint | undefined;
    let fired = (): boolean => false;
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "scaffold",
        act: () => {
          // At the first move or removal of the agent directory itself, a writer
          // has swapped in its own (empty) directory at that path.
          fired = onceBefore(
            ["renameSync", "rmdirSync"],
            (p) => p === agentDir,
            () => {
              renameSync(agentDir, aside);
              mkdirSync(agentDir);
              foreignIno = directoryInode(agentDir);
            },
          );
        },
      }),
    );
    expect(fired()).toBe(true);
    expect(directoryInode(agentDir)).toBe(foreignIno as bigint);
    expect(readdirSync(agentDir)).toEqual([]);
    expect(msg).toContain("the agent directory itself");
    // No quarantine is left in the agents root.
    expect(readdirSync(s.agentsRoot)).toEqual([name]);
  });

  it("a scaffold file replaced at its ORIGINAL path after the sweep's identity check: the replacement is untouched", async () => {
    const s = scratch();
    const name = "rbb-entry";
    const agentDir = join(s.agentsRoot, name);
    let fired = (): boolean => false;
    await refusalOf(() =>
      hire(s, name, {
        failAt: "scaffold",
        act: () => {
          // Just before soul.md is unlinked, another writer replaces the agent's
          // soul.md by its original path (creating the directory if it has to).
          fired = onceBefore(
            ["unlinkSync"],
            (p) => basename(p) === "soul.md",
            () => {
              mkdirSync(agentDir, { recursive: true });
              writeFileSync(join(agentDir, "writer.tmp"), "the writer's soul\n");
              renameSync(join(agentDir, "writer.tmp"), join(agentDir, "soul.md"));
            },
          );
        },
      }),
    );
    expect(fired()).toBe(true);
    expect(readEntry(join(agentDir, "soul.md")).text).toBe("the writer's soul\n");
  });

  it("names an entry that arrived during the sweep (the leftovers are listed after it)", async () => {
    const s = scratch();
    const name = "rbb-late";
    const agentDir = join(s.agentsRoot, name);
    let fired = (): boolean => false;
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "scaffold",
        act: () => {
          // A writer already inside the directory adds a file while the sweep
          // runs (just before soul.md is unlinked, in the same directory).
          fired = onceBefore(
            ["unlinkSync"],
            (p) => basename(p) === "soul.md",
            (p) => writeFileSync(join(dirname(p), "late.txt"), "late arrival\n"),
          );
        },
      }),
    );
    expect(fired()).toBe(true);
    expect(msg).toContain("late.txt");
    expect(readEntry(join(agentDir, "late.txt")).text).toBe("late arrival\n");
    expect(entriesUnder(agentDir)).toEqual(["late.txt"]);
  });

  it("an entry replaced after the scaffold and before the rollback is never recorded as ours", async () => {
    const s = scratch();
    const name = "rbb-bob-yaml";
    const agentDir = join(s.agentsRoot, name);
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "interview",
        act: (dir) => replaceWithForeignFile(join(dir, "bob.yaml"), "foreign: true\n"),
      }),
    );
    expect(readEntry(join(agentDir, "bob.yaml")).text).toBe("foreign: true\n");
    expect(entriesUnder(agentDir)).toEqual(["bob.yaml"]);
    expect(msg).toContain("bob.yaml");
  });
});
