import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
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

afterEach(async () => {
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
        writeFileSync(targetFile, "target\n");
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
        expect(readFileSync(targetFile, "utf8")).toBe("target\n");
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
          writeFileSync(join(agentDir, name), "replacement\n");
          swapped = true;
        },
      }),
    ).toEqual([]);

    expect(swapped).toBe(true);
    expect(readFileSync(temp, "utf8")).toBe("replacement\n");
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
