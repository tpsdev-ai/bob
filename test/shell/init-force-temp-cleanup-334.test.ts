import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  initAgent,
  initTempOwner,
  initTempPath,
  removeStaleInitTemps,
} from "../../src/shell/init.js";

const MODULE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "shell",
  "init.js",
);
const HOLD_MS = 15_000;

// The child runs a real noClobber init whose publish halts right after the temp
// for `blockOn` is written, so the parent observes a temp held by a live process.
const CHILD_SCRIPT = `
import { initAgent } from ${JSON.stringify(MODULE)};

const [root, name, blockOn] = process.argv.slice(2);
initAgent({
  name,
  role: "coder",
  provider: "ollama-cloud",
  model: "fixture-model",
  contextWindow: 200000,
  agentsRoot: root,
  skipFlair: true,
  beforePublish: (path) => {
    if (String(path).endsWith(blockOn)) {
      process.stdout.write("held\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
});
process.stdout.write("done\\n");
`;

const roots: string[] = [];
const children: ChildProcess[] = [];
const restoreSpies: (() => void)[] = [];

afterEach(async () => {
  for (const restore of restoreSpies.splice(0)) restore();
  for (const child of children.splice(0)) await stop(child);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bob-334-"));
  roots.push(root);
  return root;
}

function initOptions(root: string, name: string): Parameters<typeof initAgent>[0] {
  return {
    name,
    role: "coder",
    provider: "ollama-cloud",
    model: "fixture-model",
    contextWindow: 200_000,
    agentsRoot: root,
    skipFlair: true,
  };
}

function tempsIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function readLine(stream: Readable | null, getStderr: () => string): Promise<string> {
  return new Promise((resolveLine, rejectLine) => {
    if (stream === null) {
      rejectLine(new Error("child has no stdout"));
      return;
    }
    let buffer = "";
    const timer = setTimeout(() => {
      stream.off("data", onData);
      rejectLine(new Error(`child did not report readiness in ${HOLD_MS}ms: ${getStderr()}`));
    }, HOLD_MS);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolveLine(buffer.slice(0, newline));
      }
    };
    stream.on("data", onData);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((done) => {
    const timer = setTimeout(done, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
}

/** Start a real init that halts after writing `blockOn`'s temp; return the live
 *  child, the agent dir, and the held temp once it is on disk. */
async function holdInit(
  root: string,
  name: string,
  blockOn: string,
): Promise<{ child: ChildProcess; agentDir: string; temp: string }> {
  const script = join(root, `held-${name}.ts`);
  writeFileSync(script, CHILD_SCRIPT);
  const child = spawn(process.execPath, [script, root, name, blockOn], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  await readLine(child.stdout, () => stderr);
  const agentDir = join(root, name);
  const deadline = Date.now() + HOLD_MS;
  for (;;) {
    const temps = tempsIn(agentDir);
    if (temps.length === 1) return { child, agentDir, temp: join(agentDir, temps[0]) };
    if (Date.now() > deadline) throw new Error(`no held temp in ${agentDir}: ${stderr}`);
    await new Promise((resume) => setTimeout(resume, 10));
  }
}

describe("bob#334 — init temp cleanup on the --force path", () => {
  it("keeps the held child's temp, then removes it after the child exits", async () => {
    const root = freshRoot();
    const { child, agentDir, temp } = await holdInit(root, "agent-a", "soul.md");

    initAgent({ ...initOptions(root, "agent-a"), noClobber: false });
    expect(tempsIn(agentDir)).toContain(basename(temp));

    await stop(child);
    initAgent({ ...initOptions(root, "agent-a"), noClobber: false });
    expect(tempsIn(agentDir)).not.toContain(basename(temp));
  }, 30_000);

  it("removes an init temp but keeps an unrelated file that only resembles one", async () => {
    const root = freshRoot();
    const { child, agentDir, temp } = await holdInit(root, "agent-a", "soul.md");
    await stop(child);
    const unrelated = join(agentDir, ".soul.md-user-backup.tmp");
    writeFileSync(unrelated, "keep me\n");

    initAgent({ ...initOptions(root, "agent-a"), noClobber: false });

    expect(readFileSync(unrelated, "utf8")).toBe("keep me\n");
    expect(tempsIn(agentDir)).not.toContain(basename(temp));
  }, 30_000);

  it("keeps the temp under a symlinked root, then removes it through the direct path", async () => {
    const root = freshRoot();
    const { child, agentDir, temp } = await holdInit(root, "agent-a", "soul.md");
    await stop(child);
    const alias = join(root, "alias");
    symlinkSync(root, alias);

    initAgent({ ...initOptions(alias, "agent-a"), noClobber: false });
    expect(tempsIn(agentDir)).toContain(basename(temp));

    unlinkSync(alias);
    initAgent({ ...initOptions(root, "agent-a"), noClobber: false });
    expect(tempsIn(agentDir)).not.toContain(basename(temp));
  }, 30_000);

  it("runs cleanup on the --force path; a plain rerun refuses before publication", async () => {
    const root = freshRoot();
    const { child, agentDir, temp } = await holdInit(root, "agent-a", "soul.md");
    await stop(child);

    expect(() => initAgent(initOptions(root, "agent-a"))).toThrow(/already exists/);
    expect(tempsIn(agentDir)).toContain(basename(temp));

    initAgent({ ...initOptions(root, "agent-a"), noClobber: false });
    expect(tempsIn(agentDir)).not.toContain(basename(temp));
  }, 30_000);
});

describe("bob#334 — token kinds and identity rechecks", () => {
  function staleTemp(dir: string, pid = process.pid): string {
    const temp = initTempPath(join(dir, "soul.md"), { pid, kind: "k", start: "123" });
    writeFileSync(temp, "candidate\n");
    return temp;
  }

  for (const pid of [0, Number.MAX_SAFE_INTEGER + 1]) {
    it(`keeps a temp naming invalid PID ${pid} without probing it`, () => {
      const root = freshRoot();
      const temp = staleTemp(root, pid);
      const probe = spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      });
      restoreSpies.push(() => probe.mockRestore());

      expect(removeStaleInitTemps(root, root, { readStart: () => "456" })).toEqual([]);
      expect(probe).not.toHaveBeenCalled();
      expect(readFileSync(temp, "utf8")).toBe("candidate\n");
    });
  }

  it("keeps a temp when the PID probe returns EPERM", () => {
    const root = freshRoot();
    const temp = staleTemp(root);
    const probe = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    restoreSpies.push(() => probe.mockRestore());

    expect(removeStaleInitTemps(root, root, { readStart: () => "456" })).toEqual([]);
    expect(readFileSync(temp, "utf8")).toBe("candidate\n");
  });

  it("keeps a temp outside the agents root", () => {
    const root = freshRoot();
    const outside = freshRoot();
    const temp = staleTemp(outside);

    expect(removeStaleInitTemps(outside, root, { readStart: () => "456" })).toEqual([]);
    expect(readFileSync(temp, "utf8")).toBe("candidate\n");
  });

  it("does not reach beforeList through an initially symlinked root", () => {
    const root = freshRoot();
    const temp = staleTemp(root);
    const alias = join(freshRoot(), "alias");
    symlinkSync(root, alias);
    const listed: string[] = [];

    expect(
      removeStaleInitTemps(alias, alias, {
        readStart: () => "456",
        beforeList: (dir) => listed.push(dir),
      }),
    ).toEqual([]);
    expect(listed).toEqual([]);
    expect(readFileSync(temp, "utf8")).toBe("candidate\n");
  });

  it("does not reach beforeList through a root that is a regular file", () => {
    const root = freshRoot();
    const file = join(root, "file");
    writeFileSync(file, "root\n");
    const listed: string[] = [];

    expect(removeStaleInitTemps(file, file, { beforeList: (dir) => listed.push(dir) })).toEqual([]);
    expect(listed).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("root\n");
  });

  it("does not list a directory swapped at beforeList", () => {
    const root = freshRoot();
    const dir = join(root, "agent");
    mkdirSync(dir);
    const temp = staleTemp(dir);
    const target = freshRoot();
    const targetFile = join(target, basename(temp));
    linkSync(temp, targetFile);
    const list = spyOn(fs, "readdirSync");
    restoreSpies.push(() => list.mockRestore());

    expect(
      removeStaleInitTemps(dir, root, {
        readStart: () => "456",
        beforeList: () => {
          renameSync(dir, join(root, "parked"));
          symlinkSync(target, dir);
        },
      }),
    ).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    expect(readFileSync(targetFile, "utf8")).toBe("candidate\n");
  });

  it("does not reach beforeUnlink after a directory swap during listing", () => {
    const root = freshRoot();
    const dir = join(root, "agent");
    mkdirSync(dir);
    const temp = staleTemp(dir);
    const target = freshRoot();
    const targetFile = join(target, basename(temp));
    linkSync(temp, targetFile);
    const realList = fs.readdirSync;
    const list = spyOn(fs, "readdirSync").mockImplementation(((path, options) => {
      const names = realList(path, options);
      if (path === dir) {
        renameSync(dir, join(root, "parked"));
        symlinkSync(target, dir);
      }
      return names;
    }) as typeof fs.readdirSync);
    restoreSpies.push(() => list.mockRestore());
    const reached: string[] = [];

    expect(
      removeStaleInitTemps(dir, root, {
        readStart: () => "456",
        beforeUnlink: (path) => reached.push(path),
      }),
    ).toEqual([]);
    expect(reached).toEqual([]);
    expect(readFileSync(targetFile, "utf8")).toBe("candidate\n");
  });

  it("does not reach beforeUnlink for a listed symlink", () => {
    const root = freshRoot();
    const target = join(root, "target");
    writeFileSync(target, "target\n");
    const temp = initTempPath(join(root, "soul.md"), { pid: process.pid, kind: "k", start: "123" });
    symlinkSync(target, temp);
    const reached: string[] = [];

    expect(
      removeStaleInitTemps(root, root, {
        readStart: () => "456",
        beforeUnlink: (path) => reached.push(path),
      }),
    ).toEqual([]);
    expect(reached).toEqual([]);
    expect(lstatSync(temp).isSymbolicLink()).toBe(true);
  });

  for (const entry of ["directory", "file"] as const) {
    it(`keeps a temp when the ${entry} device changes with its inode unchanged`, () => {
      const root = freshRoot();
      const temp = staleTemp(root);
      const checkedPath = entry === "directory" ? root : temp;
      let changed = false;
      const realStat = fs.lstatSync;
      const stat = spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
        const result = realStat(path, options);
        if (changed && path === checkedPath && typeof result.dev === "bigint") {
          result.dev += 1n;
        }
        return result;
      }) as typeof fs.lstatSync);
      restoreSpies.push(() => stat.mockRestore());

      expect(
        removeStaleInitTemps(root, root, {
          readStart: () => "456",
          [entry === "directory" ? "beforeList" : "beforeUnlink"]: () => {
            changed = true;
          },
        }),
      ).toEqual([]);
      expect(readFileSync(temp, "utf8")).toBe("candidate\n");
    });
  }

  for (const entry of ["directory", "file"] as const) {
    it(`keeps a temp when the ${entry} path reports a reused inode with a different type`, () => {
      const root = freshRoot();
      const dir = join(root, "agent");
      mkdirSync(dir);
      const temp = staleTemp(dir);
      const checkedPath = entry === "directory" ? dir : temp;
      const original = lstatSync(checkedPath, { bigint: true });
      let changed = false;
      const realStat = fs.lstatSync;
      const stat = spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
        const result = realStat(path, options);
        if (changed && path === checkedPath && typeof result.ino === "bigint") {
          result.ino = original.ino;
        }
        return result;
      }) as typeof fs.lstatSync);
      restoreSpies.push(() => stat.mockRestore());

      expect(
        removeStaleInitTemps(dir, root, {
          readStart: () => "456",
          [entry === "directory" ? "beforeList" : "beforeUnlink"]: () => {
            renameSync(checkedPath, join(root, "parked"));
            if (entry === "directory") writeFileSync(dir, "replacement\n");
            else symlinkSync(join(root, "parked"), temp);
            changed = true;
          },
        }),
      ).toEqual([]);
      expect(lstatSync(checkedPath).isFile()).toBe(entry === "directory");
    });
  }

  it("keeps a temp when its directory disappears during listing", () => {
    const root = freshRoot();
    const dir = join(root, "agent");
    mkdirSync(dir);
    const temp = staleTemp(dir);
    const parked = join(root, "parked");
    const realList = fs.readdirSync;
    const list = spyOn(fs, "readdirSync").mockImplementation(((path, options) => {
      if (path === dir) renameSync(dir, parked);
      return realList(path, options);
    }) as typeof fs.readdirSync);
    restoreSpies.push(() => list.mockRestore());

    expect(removeStaleInitTemps(dir, root, { readStart: () => "456" })).toEqual([]);
    expect(readFileSync(join(parked, basename(temp)), "utf8")).toBe("candidate\n");
  });

  it("keeps a temp when its directory becomes a regular file before unlink", () => {
    const root = freshRoot();
    const dir = join(root, "agent");
    mkdirSync(dir);
    const temp = staleTemp(dir);
    const parked = join(root, "parked");

    expect(
      removeStaleInitTemps(dir, root, {
        readStart: () => "456",
        beforeUnlink: () => {
          renameSync(dir, parked);
          writeFileSync(dir, "replacement\n");
        },
      }),
    ).toEqual([]);
    expect(readFileSync(join(parked, basename(temp)), "utf8")).toBe("candidate\n");
  });

  it("propagates a listing error when the directory is unchanged", () => {
    const root = freshRoot();
    const temp = staleTemp(root);
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const list = spyOn(fs, "readdirSync").mockImplementation(() => {
      throw error;
    });
    restoreSpies.push(() => list.mockRestore());

    expect(() => removeStaleInitTemps(root, root, { readStart: () => "456" })).toThrow(error);
    expect(readFileSync(temp, "utf8")).toBe("candidate\n");
  });

  it("propagates an entry identity error other than ENOENT or ENOTDIR", () => {
    const root = freshRoot();
    const temp = staleTemp(root);
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const realStat = fs.lstatSync;
    const stat = spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
      if (path === temp) throw error;
      return realStat(path, options);
    }) as typeof fs.lstatSync);
    restoreSpies.push(() => stat.mockRestore());

    expect(() => removeStaleInitTemps(root, root, { readStart: () => "456" })).toThrow(error);
    expect(readFileSync(temp, "utf8")).toBe("candidate\n");
  });

  it("tolerates an entry disappearing at unlink", () => {
    const root = freshRoot();
    const temp = staleTemp(root);
    const realUnlink = fs.unlinkSync;
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      realUnlink(path);
      realUnlink(path);
    });
    restoreSpies.push(() => unlink.mockRestore());

    expect(removeStaleInitTemps(root, root, { readStart: () => "456" })).toEqual([]);
    expect(tempsIn(root)).not.toContain(basename(temp));
  });

  it("propagates an unlink error other than ENOENT", () => {
    const root = freshRoot();
    const temp = staleTemp(root);
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const unlink = spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw error;
    });
    restoreSpies.push(() => unlink.mockRestore());

    expect(() => removeStaleInitTemps(root, root, { readStart: () => "456" })).toThrow(error);
    expect(readFileSync(temp, "utf8")).toBe("candidate\n");
  });

  it("keeps a live PID's wall-clock temp after a failed kernel read followed by success", () => {
    const root = freshRoot();
    let available = false;
    const readStart = () => (available ? "123" : undefined);
    const owner = initTempOwner(process.pid, readStart);
    const temp = initTempPath(join(root, "soul.md"), owner);
    writeFileSync(temp, "live writer\n");

    available = true;
    expect(initTempOwner(process.pid, readStart)).toEqual({
      pid: process.pid,
      kind: "k",
      start: "123",
    });
    expect(owner.kind).toBe("w");
    expect(basename(temp)).toMatch(/-w\d+-/);
    expect(removeStaleInitTemps(root, root, { readStart })).toEqual([]);
    expect(readFileSync(temp, "utf8")).toBe("live writer\n");
  });

  for (const current of [undefined, "unreadable", "123"]) {
    it(`keeps a live PID's kernel temp with current token ${String(current)}`, () => {
      const root = freshRoot();
      const owner = initTempOwner(process.pid, () => "123");
      const temp = initTempPath(join(root, "soul.md"), owner);
      writeFileSync(temp, "live writer\n");

      expect(owner.kind).toBe("k");
      expect(basename(temp)).toMatch(/-k123-/);
      expect(removeStaleInitTemps(root, root, { readStart: () => current })).toEqual([]);
      expect(readFileSync(temp, "utf8")).toBe("live writer\n");
    });
  }

  it("removes a regular temp with a different readable kernel token for its named PID", () => {
    const root = freshRoot();
    const temp = initTempPath(
      join(root, "soul.md"),
      initTempOwner(process.pid, () => "123"),
    );
    writeFileSync(temp, "stale marker\n");

    expect(removeStaleInitTemps(root, root, { readStart: () => "456" })).toEqual([temp]);
    expect(tempsIn(root)).not.toContain(basename(temp));
  });

  it("keeps a legacy name without a token kind", () => {
    const root = freshRoot();
    const temp = join(root, `.soul.md-bob-init-${process.pid}-123-abc.tmp`);
    writeFileSync(temp, "legacy\n");

    expect(removeStaleInitTemps(root, root, { readStart: () => "456" })).toEqual([]);
    expect(readFileSync(temp, "utf8")).toBe("legacy\n");
  });

  for (const boundary of ["beforeList", "beforeUnlink"] as const) {
    for (const subdir of ["", "bin", ".pi-agent"]) {
      it(`keeps files when ${subdir || "agentDir"} becomes a symlink at ${boundary}`, async () => {
        const root = freshRoot();
        const { child, agentDir, temp } = await holdInit(root, "agent-a", "soul.md");
        await stop(child);
        const dir = join(agentDir, subdir);
        const name = basename(temp);
        const candidate = join(dir, name);
        if (subdir) writeFileSync(candidate, "candidate\n");
        const target = freshRoot();
        const targetFile = join(target, name);
        linkSync(candidate, targetFile);
        expect(lstatSync(targetFile).ino).toBe(lstatSync(candidate).ino);
        const content = readFileSync(candidate, "utf8");
        const parked = join(root, "parked");
        let swapped = false;

        const removed = removeStaleInitTemps(agentDir, root, {
          [boundary]: (path: string) => {
            if (path !== (boundary === "beforeList" ? dir : candidate) || swapped) return;
            renameSync(dir, parked);
            symlinkSync(target, dir);
            swapped = true;
          },
        });

        expect(swapped).toBe(true);
        expect(removed).not.toContain(candidate);
        expect(readFileSync(targetFile, "utf8")).toBe(content);
        expect(tempsIn(parked)).toContain(name);
      }, 30_000);
    }
  }

  it("keeps files through an already symlinked managed directory", async () => {
    const root = freshRoot();
    const { child, agentDir, temp } = await holdInit(root, "agent-a", "soul.md");
    await stop(child);
    const dir = join(agentDir, "bin");
    const target = freshRoot();
    const targetFile = join(target, basename(temp));
    writeFileSync(targetFile, "target\n");
    rmSync(dir, { recursive: true });
    symlinkSync(target, dir);

    expect(removeStaleInitTemps(agentDir, root)).not.toContain(join(dir, basename(temp)));
    expect(readFileSync(targetFile, "utf8")).toBe("target\n");
  }, 30_000);

  it("keeps the remaining files when a managed directory is replaced by another directory", async () => {
    const root = freshRoot();
    const { child, agentDir, temp } = await holdInit(root, "agent-a", "soul.md");
    await stop(child);
    const name = basename(temp);
    const parked = join(root, "parked");
    let swapped = false;

    expect(
      removeStaleInitTemps(agentDir, root, {
        beforeUnlink: (path) => {
          if (path !== temp) return;
          renameSync(agentDir, parked);
          mkdirSync(agentDir);
          linkSync(join(parked, name), join(agentDir, name));
          swapped = true;
        },
      }),
    ).toEqual([]);

    expect(swapped).toBe(true);
    expect(lstatSync(temp).ino).toBe(lstatSync(join(parked, name)).ino);
    expect(readFileSync(temp, "utf8")).toBe(readFileSync(join(parked, name), "utf8"));
    expect(tempsIn(parked)).toContain(name);
  }, 30_000);

  it("keeps a regular entry replaced after listing", async () => {
    const root = freshRoot();
    const { child, agentDir, temp } = await holdInit(root, "agent-a", "soul.md");
    await stop(child);
    const parked = join(root, "parked.tmp");

    expect(
      removeStaleInitTemps(agentDir, root, {
        beforeUnlink: (path) => {
          if (path !== temp) return;
          renameSync(temp, parked);
          writeFileSync(temp, "replacement\n");
        },
      }),
    ).toEqual([]);
    expect(readFileSync(temp, "utf8")).toBe("replacement\n");
  }, 30_000);
});
