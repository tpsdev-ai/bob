// A refused hire's (and adoption's) rollback removes only the entries this
// operation published, and leaves everything else in place, naming it (bob#326).
//
// Every test drives the real hire or adoption transaction in a scratch tree on
// real files: the scaffold, the (injected) interview, the commit stages and the
// rollback. A failure is injected at a named bind step (after the scaffold,
// after the interview, or after a commit stage), so the rollback runs on what
// that step left on disk. Where a test needs a failure INSIDE a writer or the
// rollback, it replaces one node:fs or child_process call for the duration of
// the rollback and keeps the rest real.

import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  adoptAgent,
  baselinePath,
  bindingMarkerPath,
  DEFAULT_POSITIONS_ROOT,
  grantPath,
  overridesDir,
  readGrant,
} from "../../src/shell/index.js";
import {
  adoptReadyAgent,
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
  const s = newScratch("bob-rb-");
  scratches.push(s);
  return s;
};
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});
afterAll(() => {
  for (const s of scratches) rmSync(s.base, { recursive: true, force: true });
});

const failing = async () => 7;

// The scaffold a builder hire publishes, relative to the agent directory.
const scaffoldEntries = (name: string) =>
  [
    ".pi-agent",
    ".pi-agent/auth.json",
    ".pi-agent/models.json",
    "bin",
    `bin/${name}`,
    "bob.yaml",
    "memory",
    "soul.md",
    "work",
  ].sort();

function expectNoBinding(s: Scratch, name: string): void {
  expect(readGrant(s.hostRoot, name)).toBeUndefined();
  expect(existsSync(grantPath(s.hostRoot, name))).toBe(false);
  expect(existsSync(baselinePath(s.hostRoot, name))).toBe(false);
}

describe("bob#326 — a refused hire's rollback keeps what is not its own, and names it", () => {
  it("preserves and names a file another writer placed in the new agent directory, removes init's files, keeps the directory", async () => {
    const s = scratch();
    const name = "rb-competing";
    const agentDir = join(s.agentsRoot, name);

    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "scaffold",
        act: (dir) => writeFileSync(join(dir, "writer-note.txt"), "another writer's file\n"),
      }),
    );

    expect(readEntry(join(agentDir, "writer-note.txt")).text).toBe("another writer's file\n");
    expect(readdirSync(agentDir)).toEqual(["writer-note.txt"]);
    expect(msg).toContain("injected failure at scaffold");
    expect(msg).toContain(`left these entries in place (paths relative to ${agentDir}`);
    expect(msg).toContain("writer-note.txt");
    expectNoBinding(s, name);
  });

  it("removes the directory entirely when no competing entry appeared", async () => {
    const s = scratch();
    const name = "rb-clean";
    const msg = await refusalOf(() => hire(s, name, { interview: failing }));
    expect(msg).toMatch(/exited with code 7/);
    expect(msg).not.toContain("left these entries");
    expect(existsSync(join(s.agentsRoot, name))).toBe(false);
    // No quarantine is left behind in the agents root.
    expect(readdirSync(s.agentsRoot)).toEqual([]);
    expectNoBinding(s, name);
  });

  it("keeps and names an entry init published that was replaced by a different file", async () => {
    const s = scratch();
    const name = "rb-replaced";
    const agentDir = join(s.agentsRoot, name);
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "scaffold",
        act: (dir) => replaceWithForeignFile(join(dir, "soul.md"), "someone else's soul\n"),
      }),
    );
    expect(readEntry(join(agentDir, "soul.md")).text).toBe("someone else's soul\n");
    expect(msg).toContain("soul.md");
    expect(entriesUnder(agentDir)).toEqual(["soul.md"]);
  });

  it("does not follow a symlink inside the directory", async () => {
    const s = scratch();
    const name = "rb-symlink";
    const agentDir = join(s.agentsRoot, name);
    const target = join(s.base, "outside-target.txt");
    writeFileSync(target, "outside\n");
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "scaffold",
        act: (dir) => symlinkSync(target, join(dir, "link.txt")),
      }),
    );
    expect(readEntry(target).text).toBe("outside\n");
    expect(readlinkSync(join(agentDir, "link.txt"))).toBe(target);
    expect(msg).toContain("link.txt");
  });

  it("removes nothing through an agent directory replaced by a symlink, never moves it, and names it", async () => {
    const s = scratch();
    const name = "rb-root-link";
    const agentDir = join(s.agentsRoot, name);
    const moved = join(s.base, "moved-scaffold");
    const renamedFrom: string[] = [];
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "scaffold",
        act: (dir) => {
          // The scaffold (init's own inodes) now lives elsewhere, and the agent
          // directory's path is a symlink to it.
          renameSync(dir, moved);
          symlinkSync(moved, dir);
          const rename = fs.renameSync;
          spies.push(
            spyOn(fs, "renameSync").mockImplementation((from, to) => {
              renamedFrom.push(String(from));
              return rename(from, to);
            }),
          );
        },
      }),
    );
    expect(readlinkSync(agentDir)).toBe(moved);
    // Nothing reached through the link was removed: the scaffold is whole.
    expect(entriesUnder(moved)).toEqual(scaffoldEntries(name));
    expect(renamedFrom).not.toContain(agentDir);
    expect(msg).toContain("the agent directory itself");
  });

  it("does not descend through a sub-directory replaced by a symlink", async () => {
    const s = scratch();
    const name = "rb-nested-link";
    const agentDir = join(s.agentsRoot, name);
    const outside = join(s.base, "outside-pi");
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "scaffold",
        act: (dir) => {
          // init's own .pi-agent (its recorded inodes) moved out, a link left.
          renameSync(join(dir, ".pi-agent"), outside);
          symlinkSync(outside, join(dir, ".pi-agent"));
        },
      }),
    );
    expect(entriesUnder(outside)).toEqual(["auth.json", "models.json"]);
    expect(readlinkSync(join(agentDir, ".pi-agent"))).toBe(outside);
    expect(entriesUnder(agentDir)).toEqual([".pi-agent"]);
    expect(msg).toContain(".pi-agent");
  });
});

describe("bob#326 — the binding marker and the override repository follow the same rules", () => {
  it("hire: a replaced binding marker is kept and named; the rest is removed", async () => {
    const s = scratch();
    const name = "rb-marker";
    const agentDir = join(s.agentsRoot, name);
    const marker = bindingMarkerPath(agentDir);
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "marker",
        act: () => replaceWithForeignFile(marker, "another writer's marker\n"),
      }),
    );
    expect(readEntry(marker).text).toBe("another writer's marker\n");
    expect(entriesUnder(agentDir)).toEqual([".position-binding.json"]);
    expect(msg).toContain(".position-binding.json");
    expectNoBinding(s, name);
  });

  it("hire: a foreign file inside the override repository and a replaced override document are kept and named; the repository's own entries are removed", async () => {
    const s = scratch();
    const name = "rb-overrides";
    const agentDir = join(s.agentsRoot, name);
    const ovr = overridesDir(agentDir);
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "override-repo",
        act: () => {
          writeFileSync(join(ovr, "files", "foreign.md"), "another writer's override\n");
          replaceWithForeignFile(join(ovr, "overrides.json"), '{"foreign":true}\n');
        },
      }),
    );
    expect(readEntry(join(ovr, "files", "foreign.md")).text).toBe("another writer's override\n");
    expect(readEntry(join(ovr, "overrides.json")).text).toBe('{"foreign":true}\n');
    // The Git repository, the marker and the scaffold are gone.
    expect(entriesUnder(agentDir)).toEqual([
      "overrides",
      "overrides/files",
      "overrides/files/foreign.md",
      "overrides/overrides.json",
    ]);
    expect(msg).toContain("overrides/files/foreign.md");
    expect(msg).toContain("overrides/overrides.json");
    expectNoBinding(s, name);
  });

  it("adopt: a replaced marker and a foreign override file are kept and named; the agent's own files are untouched", async () => {
    const s = scratch();
    const name = "ar-foreign";
    adoptReadyAgent(s, name);
    const agentDir = join(s.agentsRoot, name);
    const before = entriesUnder(agentDir);
    const soulBefore = readEntry(join(agentDir, "soul.md"));
    const marker = bindingMarkerPath(agentDir);
    const ovr = overridesDir(agentDir);
    const msg = await refusalOf(() =>
      adoptAgent({
        name,
        positionName: "builder",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: DEFAULT_POSITIONS_ROOT,
        commitHook: (step) => {
          if (step !== "override-repo") return;
          replaceWithForeignFile(marker, "another writer's marker\n");
          writeFileSync(join(ovr, "files", "foreign.md"), "another writer's override\n");
          throw new Error("injected failure at override-repo");
        },
      }),
    );
    expect(readEntry(marker).text).toBe("another writer's marker\n");
    expect(readEntry(join(ovr, "files", "foreign.md")).text).toBe("another writer's override\n");
    expect(entriesUnder(agentDir)).toEqual(
      [
        ...before,
        ".position-binding.json",
        "overrides",
        "overrides/files",
        "overrides/files/foreign.md",
      ].sort(),
    );
    expect(readEntry(join(agentDir, "soul.md"))).toEqual(soulBefore);
    expect(msg).toContain("This failed adoption left these entries in place");
    expect(msg).toContain(".position-binding.json");
    expect(msg).toContain("overrides/files/foreign.md");
    expectNoBinding(s, name);
  });

  it("hire: a marker only partly written when its write fails is still removed", async () => {
    const s = scratch();
    const name = "rb-marker-partial";
    const agentDir = join(s.agentsRoot, name);
    const marker = bindingMarkerPath(agentDir);
    const open = fs.openSync;
    const write = fs.writeFileSync;
    let markerFd: number | undefined;
    const fail = () =>
      Object.assign(new Error("ENOSPC: injected marker write failure"), { code: "ENOSPC" });
    const msg = await refusalOf(() =>
      hire(s, name, {
        // After the grant step, the marker's write fails once the marker exists.
        at: "grant",
        act: () => {
          spies.push(
            spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
              const fd = (open as (...a: unknown[]) => number)(path, ...rest);
              if (String(path) === marker) markerFd = fd;
              return fd;
            }) as typeof fs.openSync),
            spyOn(fs, "writeFileSync").mockImplementation(((
              target: unknown,
              ...rest: unknown[]
            ) => {
              if (target === marker) {
                write(marker, "");
                throw fail();
              }
              if (typeof target === "number" && target === markerFd) throw fail();
              return (write as (...a: unknown[]) => void)(target, ...rest);
            }) as typeof fs.writeFileSync),
          );
        },
      }),
    );
    expect(msg).toContain("injected marker write failure");
    expect(existsSync(agentDir)).toBe(false);
    expectNoBinding(s, name);
  });

  it("hire: a Git failure part-way through the override repository still removes what Git wrote", async () => {
    const s = scratch();
    const name = "rb-git-partial";
    const agentDir = join(s.agentsRoot, name);
    const exec = childProcess.execFileSync;
    const msg = await refusalOf(() =>
      hire(s, name, {
        at: "baseline",
        act: () => {
          spies.push(
            spyOn(childProcess, "execFileSync").mockImplementation(((
              command: string,
              args: readonly string[],
              options: unknown,
            ) => {
              if (args.includes("commit")) throw new Error("injected git commit failure");
              return (exec as (...a: unknown[]) => unknown)(command, args, options);
            }) as typeof childProcess.execFileSync),
          );
        },
      }),
    );
    expect(msg).toContain("injected git commit failure");
    expect(msg).not.toContain("left these entries");
    expect(existsSync(agentDir)).toBe(false);
    expectNoBinding(s, name);
  });
});

describe("bob#326 — the rollback's own failures", () => {
  it("a file whose temporary name could not be cleaned up after it was published is still removed, with its temporary name", async () => {
    const s = scratch();
    const name = "rb-temp-cleanup";
    const agentDir = join(s.agentsRoot, name);
    const rm = fs.rmSync;
    let failed = false;
    spies.push(
      spyOn(fs, "rmSync").mockImplementation((path, options) => {
        if (!failed && basename(String(path)).startsWith(".soul.md-")) {
          failed = true;
          throw Object.assign(new Error("EIO: injected temp cleanup failure"), { code: "EIO" });
        }
        return rm(path, options);
      }),
    );
    const msg = await refusalOf(() => hire(s, name));
    expect(failed).toBe(true);
    expect(msg).toContain("injected temp cleanup failure");
    expect(msg).not.toContain("left these entries");
    expect(existsSync(agentDir)).toBe(false);
    expectNoBinding(s, name);
  });

  it("collects a failed cleanup step and still runs the independent ones after it", async () => {
    const s = scratch();
    const name = "rb-stage-error";
    const agentDir = join(s.agentsRoot, name);
    const marker = bindingMarkerPath(agentDir);
    const denied = (op: string, path: string) =>
      Object.assign(new Error(`EACCES: injected, ${op} '${path}'`), { code: "EACCES" });
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "baseline",
        act: () => {
          // The agent directory's cleanup fails, whichever call reaches it.
          const reals = {
            renameSync: fs.renameSync,
            rmSync: fs.rmSync,
            rmdirSync: fs.rmdirSync,
            unlinkSync: fs.unlinkSync,
          };
          for (const op of ["renameSync", "rmSync", "rmdirSync", "unlinkSync"] as const) {
            const real = reals[op] as (...a: unknown[]) => unknown;
            spies.push(
              spyOn(fs, op).mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
                if (String(path) === agentDir || String(path) === marker) {
                  throw denied(op, String(path));
                }
                return real(path, ...rest);
              }) as never),
            );
          }
        },
      }),
    );
    expect(msg).toContain("injected failure at baseline");
    expect(msg).toContain("The rollback could not complete these steps");
    expect(msg).toContain("EACCES: injected");
    // The host grant and baseline were still removed.
    expectNoBinding(s, name);
    // Nothing was removed from the agent directory it could not move aside.
    expect(entriesUnder(agentDir)).toEqual(
      [...scaffoldEntries(name), ".position-binding.json"].sort(),
    );
  });

  it("leaves the quarantine where it is, and names it, when the agent directory's path is taken before it can move back", async () => {
    const s = scratch();
    const name = "rb-occupied";
    const agentDir = join(s.agentsRoot, name);
    let occupantIno: bigint | undefined;
    const rmdir = fs.rmdirSync;
    const msg = await refusalOf(() =>
      hire(s, name, {
        failAt: "scaffold",
        act: (dir) => {
          writeFileSync(join(dir, "writer-note.txt"), "another writer's file\n");
          spies.push(
            spyOn(fs, "rmdirSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
              // Just before the quarantine is found not empty, a writer creates
              // an empty directory at the agent directory's original path.
              if (
                occupantIno === undefined &&
                basename(String(path)).startsWith(".bob-rollback-")
              ) {
                mkdirSync(agentDir);
                occupantIno = lstatSync(agentDir, { bigint: true }).ino;
              }
              return (rmdir as (...a: unknown[]) => void)(path, ...rest);
            }) as typeof fs.rmdirSync),
          );
        },
      }),
    );
    expect(occupantIno).toBeDefined();
    // The occupant is untouched: the same, empty directory.
    expect(lstatSync(agentDir, { bigint: true }).ino).toBe(occupantIno as bigint);
    expect(readdirSync(agentDir)).toEqual([]);
    const quarantine = readdirSync(s.agentsRoot).filter((n) => n.startsWith(".bob-rollback-"));
    expect(quarantine).toHaveLength(1);
    const at = join(s.agentsRoot, quarantine[0] as string);
    expect(readEntry(join(at, "writer-note.txt")).text).toBe("another writer's file\n");
    expect(readdirSync(at)).toEqual(["writer-note.txt"]);
    expect(msg).toContain(`${agentDir} was occupied`);
    expect(msg).toContain(at);
    expect(msg).toContain("writer-note.txt");
    expect(dirname(at)).toBe(s.agentsRoot);
  });
});
