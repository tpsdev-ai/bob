// write_soul — the bob-owned, soul-ONLY setup write (bob#204).
//
// Three layers are pinned:
//   1. the TOOL CORE (write-soul.ts) against a fake PiLike — it takes `content`
//      and NOTHING else, targets the bound soul.md, refuses a symlink in ANY
//      path component, pins the agent directory and refuses a swap before the
//      rename, writes every byte of a short-writing filesystem, creates its temp
//      exclusively, holds it open so a recycled inode number cannot pass for it,
//      never unlinks a name it did not create, never deletes a file on
//      name-and-age evidence, and keeps an existing soul.md's mode (a new one
//      is 0600);
//   2. bindSetupSoulTarget — the binding a setup session gets BEFORE it starts:
//      the agents root canonicalized once, and the directory the session runs
//      as, never a different requested one;
//   3. a REAL pi setup session (through bob's ONE factory, stub model): the
//      setup policy activates read + write_soul and NOT pi's generic `write`,
//      the registered tool's schema is content-only, executing it writes
//      soul.md, and a normal session neither registers nor activates it.
//
// Every tree is created under realpath(tmpdir()): write_soul refuses a symlink
// in any component, and macOS's default tmpdir is under the /var -> /private/var
// link.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory, SETUP_TOOL_POLICY } from "../../src/shell/session.js";
import {
  bindSetupSoulTarget,
  createWriteSoulExtension,
  MAX_SOUL_BYTES,
  NEW_SOUL_MODE,
  SOUL_TEMP_PATTERN,
  type SoulToolOutput,
  type SoulWritePi,
  type WireSoulWriteOptions,
  WRITE_SOUL_TOOL,
  wireSoulWrite,
} from "../../src/shell/write-soul.js";

// ─── Layer 1: the tool core, with a fake PiLike ──────────────────────────────

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  parameters: {
    type?: string;
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<SoulToolOutput>;
}

function firstText(res: SoulToolOutput): string {
  return res.content[0]?.text ?? "";
}

function wire(soulPath: string, opts: WireSoulWriteOptions = {}): CapturedTool {
  let tool: CapturedTool | undefined;
  const pi: SoulWritePi = {
    registerTool(t) {
      tool = t as unknown as CapturedTool;
    },
  };
  wireSoulWrite(pi, soulPath, { log: () => {}, ...opts });
  if (!tool) throw new Error("write_soul was not registered");
  return tool;
}

function temps(dir: string): string[] {
  return readdirSync(dir).filter((f) => SOUL_TEMP_PATTERN.test(f));
}

/** A distinct name in write_soul's own temp pattern. */
function tempNameFor(n: number): string {
  return `.soul.md.write_soul-${process.pid}-${n.toString(16).padStart(24, "0")}.tmp`;
}

/** `st` as a filesystem that RECYCLED an inode number reports it: another
 *  file's type and mode, carrying `id`'s (dev, ino). */
function recycled(st: BigIntStats, id: { dev: bigint; ino: bigint }): BigIntStats {
  return {
    dev: id.dev,
    ino: id.ino,
    mode: st.mode,
    mtimeMs: st.mtimeMs,
    isFile: () => st.isFile(),
    isDirectory: () => st.isDirectory(),
    isSymbolicLink: () => st.isSymbolicLink(),
  } as unknown as BigIntStats;
}

/** The dirAccess mode write_soul uses by default on this host. */
const DEFAULT_DIR_ACCESS = process.platform === "linux" ? "fd-relative" : "path-verified";

describe("write_soul tool core", () => {
  let dir: string;
  let agentDir: string;
  let soulPath: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bob-write-soul-")));
    agentDir = join(dir, "testbot");
    mkdirSync(agentDir, { recursive: true });
    soulPath = join(agentDir, "soul.md");
    writeFileSync(soulPath, "seed persona\n");
    writeFileSync(join(agentDir, "bob.yaml"), "agent:\n  id: testbot\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a tool named write_soul that takes CONTENT ONLY (no path, no extra properties)", () => {
    const tool = wire(soulPath);
    expect(tool.name).toBe(WRITE_SOUL_TOOL);
    expect(tool.name).toBe("write_soul");
    const props = Object.keys(tool.parameters.properties ?? {});
    expect(props).toEqual(["content"]);
    expect(props).not.toContain("path");
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it("writes the content to the bound soul.md, and leaves no temp file behind", async () => {
    const tool = wire(soulPath);
    const res = await tool.execute("c1", { content: "# Testbot\n\nRefined.\n" });
    expect(res.details.refused).toBeUndefined();
    expect(firstText(res)).toContain("Wrote");
    expect(res.details.dirAccess).toBe(DEFAULT_DIR_ACCESS);
    expect(readFileSync(soulPath, "utf-8")).toBe("# Testbot\n\nRefined.\n");
    expect(temps(agentDir)).toEqual([]);
  });

  it("refuses a path argument and never writes the named file (absolute path outside the agent dir)", async () => {
    const tool = wire(soulPath);
    const outside = join(dir, "outside.md");
    const res = await tool.execute("c1", { content: "x", path: outside });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("no path");
    expect(existsSync(outside)).toBe(false);
    // soul.md is untouched too — a refused call writes nothing at all.
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("cannot be aimed at bob.yaml via a `file`/`target`/`..` argument either", async () => {
    const tool = wire(soulPath);
    for (const key of ["file", "target", "file_path", "filename"]) {
      const res = await tool.execute("c1", { content: "x", [key]: join(agentDir, "bob.yaml") });
      expect(res.details.refused).toBe(true);
    }
    // A traversal value is refused the same way — it is an extra argument, full stop.
    const traversal = await tool.execute("c1", { content: "x", path: "../bob.yaml" });
    expect(traversal.details.refused).toBe(true);
    expect(readFileSync(join(agentDir, "bob.yaml"), "utf-8")).toBe("agent:\n  id: testbot\n");
  });

  it("refuses EVERY key but `content` — an unknown one is not ignored (allowlist, not a denylist)", async () => {
    const tool = wire(soulPath);
    for (const key of ["mode", "note", "dest", "encoding", "append"]) {
      const res = await tool.execute("c1", { content: "# should not land\n", [key]: "x" });
      expect(res.details.refused).toBe(true);
      expect(res.details.unexpected).toEqual([key]);
      expect(firstText(res)).toContain(JSON.stringify(key));
    }
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("refuses an empty or non-string content and writes nothing", async () => {
    const tool = wire(soulPath);
    for (const content of ["", 42, null]) {
      const res = await tool.execute("c1", { content } as Record<string, unknown>);
      expect(res.details.refused).toBe(true);
    }
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("refuses a SYMLINKED soul.md (it must not follow the link out of the agent dir)", async () => {
    const tool = wire(soulPath);
    const victim = join(dir, "victim.md");
    writeFileSync(victim, "do not touch\n");
    rmSync(soulPath);
    symlinkSync(victim, soulPath);
    const res = await tool.execute("c1", { content: "# redirected\n" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("symlink");
    expect(readFileSync(victim, "utf-8")).toBe("do not touch\n");
  });

  it("refuses a SYMLINKED agent directory", async () => {
    // Point the tool at a soul.md whose parent dir is a symlink.
    const linkDir = join(dir, "agent-link");
    symlinkSync(agentDir, linkDir);
    const tool = wire(join(linkDir, "soul.md"));
    const res = await tool.execute("c1", { content: "x" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("symlink");
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("refuses a symlink in an ANCESTOR of the agent directory, not only its parent", async () => {
    // <dir>/agents -> <dir>/real-agents; the agent directory itself is real.
    const realRoot = join(dir, "real-agents");
    mkdirSync(join(realRoot, "testbot"), { recursive: true });
    writeFileSync(join(realRoot, "testbot", "soul.md"), "real persona\n");
    symlinkSync(realRoot, join(dir, "agents"));
    const tool = wire(join(dir, "agents", "testbot", "soul.md"));
    const res = await tool.execute("c1", { content: "# through the link\n" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain(`${join(dir, "agents")} is a symlink`);
    expect(readFileSync(join(realRoot, "testbot", "soul.md"), "utf-8")).toBe("real persona\n");
    expect(temps(join(realRoot, "testbot"))).toEqual([]);
  });

  it("refuses an ancestor that BECOMES a symlink after binding", async () => {
    // Bound to <dir>/team/testbot, then <dir>/team is moved and replaced by a
    // link to where it went: the same files, reached through a symlink.
    const team = join(dir, "team");
    mkdirSync(join(team, "testbot"), { recursive: true });
    writeFileSync(join(team, "testbot", "soul.md"), "team persona\n");
    const tool = wire(join(team, "testbot", "soul.md"));
    renameSync(team, join(dir, "team-moved"));
    symlinkSync(join(dir, "team-moved"), team);
    const res = await tool.execute("c1", { content: "# later\n" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain(`${team} is a symlink`);
    expect(readFileSync(join(dir, "team-moved", "testbot", "soul.md"), "utf-8")).toBe(
      "team persona\n",
    );
  });

  it("enforces the size cap and writes nothing when over it", async () => {
    const tool = wire(soulPath);
    const res = await tool.execute("c1", { content: "x".repeat(MAX_SOUL_BYTES + 1) });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain(String(MAX_SOUL_BYTES));
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("writes EVERY byte through a filesystem that only accepts 3 bytes per write", async () => {
    let calls = 0;
    const tool = wire(soulPath, {
      fs: {
        write: (fd, buffer, offset, length) => {
          calls++;
          return writeSync(fd, buffer, offset, Math.min(3, length));
        },
      },
    });
    const content = "# Sœul — ünïcode ✓\n".repeat(40);
    const res = await tool.execute("c1", { content });
    expect(res.details.refused).toBeUndefined();
    expect(readFileSync(soulPath, "utf-8")).toBe(content);
    expect(calls).toBe(Math.ceil(Buffer.byteLength(content, "utf8") / 3));
    expect(temps(agentDir)).toEqual([]);
  });

  it("refuses a write that makes NO progress, on the first zero-byte write, and renames nothing", async () => {
    let calls = 0;
    const tool = wire(soulPath, {
      fs: {
        write: () => {
          calls++;
          if (calls > 100) throw new Error("fake write: stuck after 100 zero-byte writes");
          return 0;
        },
      },
    });
    const res = await tool.execute("c1", { content: "# never lands\n" });
    expect(res.details.refused).toBe(true);
    expect(String(res.details.reason)).toContain("no progress");
    expect(calls).toBe(1);
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
    expect(temps(agentDir)).toEqual([]);
  });

  it("renames nothing when the temp cannot be synced", async () => {
    const tool = wire(soulPath, {
      fs: {
        fsync: () => {
          throw new Error("fake fsync: EIO");
        },
      },
    });
    const res = await tool.execute("c1", { content: "# unsynced\n" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("EIO");
    expect(firstText(res)).toContain("soul.md is unchanged");
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
    expect(temps(agentDir)).toEqual([]);
  });

  it("never unlinks a file it did not create: a pre-existing file at the temp name survives", async () => {
    const name = tempNameFor(1);
    const decoy = join(agentDir, name);
    writeFileSync(decoy, "not write_soul's\n");
    const tool = wire(soulPath, { tempName: () => name });
    const res = await tool.execute("c1", { content: "# collides\n" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("EEXIST");
    expect(readFileSync(decoy, "utf-8")).toBe("not write_soul's\n");
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("neither renames nor unlinks a file swapped in at the temp's name before the rename", async () => {
    const name = tempNameFor(2);
    const tool = wire(soulPath, {
      tempName: () => name,
      beforeRename: () => {
        unlinkSync(join(agentDir, name));
        writeFileSync(join(agentDir, name), "planted\n");
      },
    });
    const res = await tool.execute("c1", { content: "# mine\n" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("was replaced before the rename");
    expect(res.details.strandedTemp).toBe(name);
    expect(readFileSync(join(agentDir, name), "utf-8")).toBe("planted\n");
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("refuses a file swapped in at the temp's name even when the filesystem RECYCLES the temp's inode number", async () => {
    // ext4 hands a freed inode number to the next file at once, so a file
    // created at the temp's name after the temp is CLOSED can carry the temp's
    // (dev, ino). This fake filesystem does that on every host: once the temp's
    // fd is closed, an lstat of its name reports the temp's identity. write_soul
    // must hold the temp open until the rename and its cleanup are done.
    const name = tempNameFor(7);
    let tempFd: number | undefined;
    let tempId: { dev: bigint; ino: bigint } | undefined;
    let tempClosed = false;
    const tool = wire(soulPath, {
      tempName: () => name,
      fs: {
        open: (path, flags, mode) => {
          const fd = openSync(path, flags, mode);
          if (path.endsWith(name)) {
            tempFd = fd;
            const st = fstatSync(fd, { bigint: true });
            tempId = { dev: st.dev, ino: st.ino };
          }
          return fd;
        },
        close: (fd) => {
          if (fd === tempFd) tempClosed = true;
          closeSync(fd);
        },
        lstat: (path) => {
          const st = lstatSync(path, { bigint: true });
          return tempClosed && tempId !== undefined && path.endsWith(name)
            ? recycled(st, tempId)
            : st;
        },
      },
      beforeRename: () => {
        unlinkSync(join(agentDir, name));
        writeFileSync(join(agentDir, name), "planted\n");
      },
    });
    const res = await tool.execute("c1", { content: "# mine\n" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("was replaced before the rename");
    expect(readFileSync(join(agentDir, name), "utf-8")).toBe("planted\n");
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
    // Held to the end, then released: no fd leaks.
    expect(tempClosed).toBe(true);
  });

  it("never deletes a file on name-and-age evidence: an OLD file matching its temp pattern stays", async () => {
    // What a crash leaves behind looks exactly like this: an old file in the
    // tool's own name pattern. write_soul did not create it in THIS call, so it
    // is left in place (it is safe to delete by hand).
    const hourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    const orphan = join(agentDir, tempNameFor(3));
    writeFileSync(orphan, "a crashed call's draft\n");
    utimesSync(orphan, hourAgo, hourAgo);

    const res = await wire(soulPath).execute("c1", { content: "# new persona\n" });
    expect(res.details.refused).toBeUndefined();
    expect(readFileSync(soulPath, "utf-8")).toBe("# new persona\n");
    expect(readFileSync(orphan, "utf-8")).toBe("a crashed call's draft\n");
    expect(temps(agentDir)).toEqual([tempNameFor(3)]);
  });

  it("keeps an existing soul.md's permission bits", async () => {
    for (const mode of [0o644, 0o640]) {
      chmodSync(soulPath, mode);
      const res = await wire(soulPath).execute("c1", { content: `# mode ${mode.toString(8)}\n` });
      expect(res.details.refused).toBeUndefined();
      expect(statSync(soulPath).mode & 0o777).toBe(mode);
    }
  });

  it("creates a NEW soul.md as 0600", async () => {
    rmSync(soulPath);
    const res = await wire(soulPath).execute("c1", { content: "# first persona\n" });
    expect(res.details.refused).toBeUndefined();
    expect(NEW_SOUL_MODE).toBe(0o600);
    expect(readFileSync(soulPath, "utf-8")).toBe("# first persona\n");
    expect(statSync(soulPath).mode & 0o777).toBe(0o600);
  });

  // A directory swapped between the check and the rename. The swap moves the
  // agent directory away, puts an impostor in its place and moves write_soul's
  // temp INTO the impostor, so a path-based rename would succeed there.
  for (const mode of [
    { label: "default", opts: {} },
    { label: "path-verified (forced)", opts: { dirHandlePath: () => undefined } },
  ]) {
    it(`detects an agent directory swapped between the check and the rename — ${mode.label}`, async () => {
      const moved = join(dir, "testbot-moved");
      const tool = wire(soulPath, {
        ...mode.opts,
        beforeRename: () => {
          renameSync(agentDir, moved);
          mkdirSync(agentDir);
          writeFileSync(join(agentDir, "soul.md"), "impostor persona\n");
          for (const t of temps(moved)) renameSync(join(moved, t), join(agentDir, t));
        },
      });
      const res = await tool.execute("c1", { content: "# redirected?\n" });
      expect(res.details.refused).toBe(true);
      expect(firstText(res)).toContain("is no longer the directory write_soul opened");
      expect(readFileSync(join(agentDir, "soul.md"), "utf-8")).toBe("impostor persona\n");
      expect(readFileSync(join(moved, "soul.md"), "utf-8")).toBe("seed persona\n");
    });
  }

  it("path-verified mode: after a swap it unlinks nothing through the unverified path", async () => {
    const moved = join(dir, "testbot-moved");
    const name = tempNameFor(6);
    const tool = wire(soulPath, {
      dirHandlePath: () => undefined,
      tempName: () => name,
      beforeRename: () => {
        renameSync(agentDir, moved);
        mkdirSync(agentDir);
        writeFileSync(join(agentDir, "soul.md"), "impostor persona\n");
        writeFileSync(join(agentDir, name), "impostor's file\n");
      },
    });
    const res = await tool.execute("c1", { content: "# swapped\n" });
    expect(res.details.refused).toBe(true);
    expect(res.details.strandedTemp).toBe(name);
    expect(readFileSync(join(agentDir, name), "utf-8")).toBe("impostor's file\n");
    expect(temps(moved)).toEqual([name]);
    expect(readFileSync(join(moved, "soul.md"), "utf-8")).toBe("seed persona\n");
    expect(readFileSync(join(agentDir, "soul.md"), "utf-8")).toBe("impostor persona\n");
  });

  it("fd-relative mode: names resolve through the directory HANDLE, so cleanup follows the pinned directory", async () => {
    // Simulates /proc/self/fd/<fd>: a link that keeps pointing at the pinned
    // directory wherever it goes. On Linux the kernel does this for real.
    const handle = join(dir, "handle");
    const moved = join(dir, "testbot-moved");
    symlinkSync(agentDir, handle);
    const tool = wire(soulPath, {
      dirHandlePath: () => handle,
      beforeRename: () => {
        renameSync(agentDir, moved);
        mkdirSync(agentDir);
        writeFileSync(join(agentDir, "soul.md"), "impostor persona\n");
        unlinkSync(handle);
        symlinkSync(moved, handle);
      },
    });
    const res = await tool.execute("c1", { content: "# pinned\n" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("is no longer the directory write_soul opened");
    expect(res.details.strandedTemp).toBeUndefined();
    expect(temps(moved)).toEqual([]);
    expect(temps(agentDir)).toEqual([]);
    expect(readFileSync(join(moved, "soul.md"), "utf-8")).toBe("seed persona\n");
    expect(readFileSync(join(agentDir, "soul.md"), "utf-8")).toBe("impostor persona\n");
  });

  it("fd-relative mode writes through the handle when nothing moves", async () => {
    const handle = join(dir, "handle");
    symlinkSync(agentDir, handle);
    const res = await wire(soulPath, { dirHandlePath: () => handle }).execute("c1", {
      content: "# via handle\n",
    });
    expect(res.details.refused).toBeUndefined();
    expect(res.details.dirAccess).toBe("fd-relative");
    expect(readFileSync(soulPath, "utf-8")).toBe("# via handle\n");
    expect(temps(agentDir)).toEqual([]);
  });

  it("the inline extension registers write_soul bound to the given path", () => {
    const ext = createWriteSoulExtension(soulPath);
    expect(ext.name).toBe("bob-write-soul");
    expect(ext.hidden).toBe(true);
    let name = "";
    (ext.factory as (pi: unknown) => void)({
      registerTool: (t: { name: string }) => {
        name = t.name;
      },
    });
    expect(name).toBe("write_soul");
  });

  it("refuses to bind to anything but an absolute, normalized path to soul.md", () => {
    for (const bad of ["soul.md", join(agentDir, "bob.yaml"), `${agentDir}/../testbot/soul.md`]) {
      expect(() => createWriteSoulExtension(bad)).toThrow(/absolute, normalized path to soul\.md/);
    }
  });
});

// ─── Layer 2: the binding a setup session gets before it starts ─────────────

describe("bindSetupSoulTarget", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "bob-soul-bind-")));
    for (const name of ["testbot", "other"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "soul.md"), `${name} persona\n`);
    }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a requested agent directory that is not the one the session runs as", () => {
    expect(() =>
      bindSetupSoulTarget({
        command: "bob align",
        name: "testbot",
        requestedAgentDir: join(dir, "other"),
      }),
    ).toThrow(
      new RegExp(
        `refusing to start - the agent directory ${join(dir, "other")} is not testbot's.*Point --agent-dir at ${join(dir, "testbot")}`,
      ),
    );
  });

  it("accepts another spelling of the same directory and returns the canonical target", () => {
    const target = bindSetupSoulTarget({
      command: "bob align",
      name: "testbot",
      requestedAgentDir: `${dir}/other/../testbot/`,
    });
    expect(target).toEqual({
      agentsRoot: dir,
      agentDir: join(dir, "testbot"),
      soulPath: join(dir, "testbot", "soul.md"),
    });
  });

  it("canonicalizes the agents root ONCE: a linked root binds to the real path, and the ROOT is returned for the config", () => {
    symlinkSync(dir, join(dir, "root-link"));
    const target = bindSetupSoulTarget({
      command: "bob align",
      name: "testbot",
      requestedAgentDir: join(dir, "root-link", "testbot"),
    });
    expect(target.agentsRoot).toBe(dir);
    expect(target.soulPath).toBe(join(dir, "testbot", "soul.md"));
  });

  it("refuses a symlinked agent directory before the session starts", () => {
    symlinkSync(join(dir, "testbot"), join(dir, "alias"));
    expect(() =>
      bindSetupSoulTarget({
        command: "bob align",
        name: "alias",
        requestedAgentDir: join(dir, "alias"),
      }),
    ).toThrow(/is a symlink/);
  });

  it("refuses a symlinked soul.md before the session starts", () => {
    rmSync(join(dir, "testbot", "soul.md"));
    symlinkSync(join(dir, "other", "soul.md"), join(dir, "testbot", "soul.md"));
    expect(() =>
      bindSetupSoulTarget({
        command: "bob onboard",
        name: "testbot",
        requestedAgentDir: join(dir, "testbot"),
      }),
    ).toThrow(/soul\.md is a symlink/);
  });

  it("refuses a missing agent directory, naming the remedy", () => {
    expect(() =>
      bindSetupSoulTarget({
        command: "bob align",
        name: "ghost",
        requestedAgentDir: join(dir, "ghost"),
      }),
    ).toThrow(/the agent directory \S*ghost does not exist\. Run 'bob onboard ghost' first/);
  });
});

// ─── Layer 3: a REAL pi setup session ────────────────────────────────────────

const STUB_PROVIDER = "bob-stub";
const STUB_MODEL = "stub-1";

async function stubRuntime() {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider(STUB_PROVIDER, {
    name: "Bob Stub",
    apiKey: "stub-key",
    api: "bob-stub-api",
    baseUrl: "http://localhost:0",
    streamSimple: () => {
      throw new Error("the setup-session tests never run a model turn");
    },
    models: [
      {
        id: STUB_MODEL,
        name: "Stub",
        api: "bob-stub-api",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
  });
  return runtime;
}

describe("setup session gets write_soul and never pi's write", () => {
  let root: string;
  let agentsRoot: string;
  let agentDir: string;
  let cwd: string;
  let piAgentDir: string;
  let soulPath: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bob-soul-session-")));
    agentsRoot = join(root, "agents");
    const res = initAgent({
      name: "testbot",
      role: "ea",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentsRoot,
      flairKeysDir: join(root, ".flair", "keys"),
      skipFlair: true,
    });
    agentDir = res.agentDir;
    cwd = join(agentDir, "work");
    piAgentDir = join(agentDir, ".pi-agent");
    soulPath = join(agentDir, "soul.md");
    writeFileSync(soulPath, "seed persona\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function buildSession(
    opts: { setupSoulPath?: string; policy?: typeof SETUP_TOOL_POLICY } = {},
  ) {
    const runtime = await stubRuntime();
    const base = resolveRunConfig({ name: "testbot", agentsRoot }).config;
    const factory = createBobRuntimeFactory({
      config: {
        ...base,
        provider: STUB_PROVIDER,
        model: STUB_MODEL,
        extensionSources: [],
        ...(opts.setupSoulPath !== undefined ? { setupSoulPath: opts.setupSoulPath } : {}),
      },
      policy: opts.policy ?? SETUP_TOOL_POLICY,
      deps: { log: () => {}, exit: () => {} },
      modelRuntime: runtime,
    });
    const result = await factory({
      cwd,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(cwd) as never,
    });
    return result;
  }

  function registeredToolNames(result: Awaited<ReturnType<typeof buildSession>>): string[] {
    return result.services.resourceLoader
      .getExtensions()
      .extensions.flatMap((e) => [...e.tools.keys()]);
  }

  it("activates read + write_soul and NOT pi's generic write/edit/bash", async () => {
    const result = await buildSession({ setupSoulPath: soulPath });
    try {
      const active = result.session.getActiveToolNames();
      // The model holds EXACTLY these two tools: no shell, no other writer.
      expect(active.slice().sort()).toEqual(["read", "write_soul"]);
      expect(active).not.toContain("write");
      expect(active).not.toContain("edit");
      expect(active).not.toContain("bash");
    } finally {
      result.session.dispose();
    }
  });

  it("registers write_soul with a content-only schema and executes it to soul.md", async () => {
    const result = await buildSession({ setupSoulPath: soulPath });
    try {
      const tool = result.services.resourceLoader
        .getExtensions()
        .extensions.flatMap((e) => [...e.tools.values()])
        .map((t) => (t as { definition?: unknown }).definition)
        .find((d): d is { name: string } => (d as { name?: string })?.name === "write_soul");
      expect(tool, "write_soul is registered in the session").toBeTruthy();
      const params = (
        tool as unknown as {
          parameters: { properties?: Record<string, unknown>; additionalProperties?: boolean };
        }
      ).parameters;
      expect(Object.keys(params.properties ?? {})).toEqual(["content"]);
      expect(params.additionalProperties).toBe(false);

      const res = await (
        tool as unknown as {
          execute(
            id: string,
            p: Record<string, unknown>,
            s?: AbortSignal,
            u?: unknown,
            c?: unknown,
          ): Promise<SoulToolOutput>;
        }
      ).execute("call-1", { content: "# Refined persona\n" });
      expect(res.details.refused).toBeUndefined();
      expect(readFileSync(soulPath, "utf-8")).toBe("# Refined persona\n");

      // A path argument is refused and bob.yaml is untouched — the session
      // cannot write anything but soul.md.
      const bobYamlBefore = readFileSync(join(agentDir, "bob.yaml"), "utf-8");
      const refused = await (
        tool as unknown as {
          execute(id: string, p: Record<string, unknown>): Promise<SoulToolOutput>;
        }
      ).execute("call-2", { content: "x", path: join(agentDir, "bob.yaml") });
      expect(refused.details.refused).toBe(true);
      expect(readFileSync(join(agentDir, "bob.yaml"), "utf-8")).toBe(bobYamlBefore);
    } finally {
      result.session.dispose();
    }
  });

  it("does NOT register write_soul for a session without setupSoulPath", async () => {
    const policy = {
      tools: ["read"],
      excludeTools: [],
      resident: false,
      allowResidentShell: false,
    };
    const result = await buildSession({ policy });
    try {
      expect(registeredToolNames(result)).not.toContain("write_soul");
    } finally {
      result.session.dispose();
    }
  });

  it("a normal (non-setup) session — no setupSoulPath, pi's built-ins — neither registers nor activates write_soul", async () => {
    // Guard against a regression where the tool leaks into every session: a
    // session that did not set setupSoulPath gets no write_soul at all, even
    // with pi's generic tools granted.
    const policy = {
      tools: ["read", "write", "edit", "bash"],
      excludeTools: [],
      resident: false,
      allowResidentShell: false,
    };
    const result = await buildSession({ policy });
    try {
      const active = result.session.getActiveToolNames();
      expect(active).toContain("read");
      expect(active).toContain("write");
      expect(active).not.toContain("write_soul");
      expect(registeredToolNames(result)).not.toContain("write_soul");
    } finally {
      result.session.dispose();
    }
  });
});
