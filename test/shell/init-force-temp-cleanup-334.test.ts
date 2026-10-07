import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { initAgent } from "../../src/shell/init.js";

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

describe("bob#334 — a killed --force publish's temp is cleaned up safely", () => {
  it("keeps a live init's temp, then removes it once the owner has exited", async () => {
    const root = freshRoot();
    const { child, agentDir, temp } = await holdInit(root, "agent-a", "soul.md");

    // --force over the live temp must not remove it.
    initAgent({ ...initOptions(root, "agent-a"), noClobber: false });
    expect(tempsIn(agentDir)).toContain(basename(temp));

    // Once the owner is gone the same temp is orphaned and is removed.
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

  it("does not follow a symlinked parent, but removes a temp reached directly", async () => {
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
