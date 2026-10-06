// bob#328 item 1: a `--force` init must create auth.json at its published mode.
//
// The `--force` publication path wrote each file with `writeFileSync(path,
// content)` — creating it at 0o666 masked by the process umask — and narrowed
// auth.json to 0600 with a later `chmod`, so under a permissive umask the file
// existed with group/other bits until that `chmod` ran. The mode is observed at
// creation by wrapping the node:fs calls that can create the path and reading the
// path's mode right after each returns, before any later call runs.
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realOpenSync = realFs.openSync;
const realWriteFileSync = realFs.writeFileSync;
const realRenameSync = realFs.renameSync;
const realStatSync = realFs.statSync;

let watchPath: string | undefined;
const observedModes: number[] = [];

/** Record the mode of `path` as soon as a call that could have created it returns. */
function observe(path: unknown): void {
  if (typeof path !== "string" || path !== watchPath) return;
  try {
    observedModes.push(realStatSync(path).mode & 0o777);
  } catch {
    // The call did not create the path (e.g. an open that failed).
  }
}

mock.module("node:fs", () => ({
  ...realFs,
  openSync: (...args: unknown[]) => {
    const fd = (realOpenSync as (...a: unknown[]) => number)(...args);
    observe(args[0]);
    return fd;
  },
  writeFileSync: (...args: unknown[]) => {
    const result = (realWriteFileSync as (...a: unknown[]) => unknown)(...args);
    observe(args[0]);
    return result;
  },
  renameSync: (...args: unknown[]) => {
    const result = (realRenameSync as (...a: unknown[]) => unknown)(...args);
    observe(args[1]);
    return result;
  },
}));

afterAll(() => {
  mock.restore();
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) realFs.rmSync(root, { recursive: true, force: true });
});

describe("bob#328 — auth.json under a --force init", () => {
  it("is never created with group or other bits, even under a permissive umask", async () => {
    const { initAgent } = await import("../../src/shell/init.js");
    const root = realFs.mkdtempSync(join(tmpdir(), "bob-328-"));
    roots.push(root);
    const authPath = join(root, "agent-a", ".pi-agent", "auth.json");

    observedModes.length = 0;
    watchPath = authPath;
    const previousUmask = process.umask(0o022);
    let thrown: unknown;
    try {
      initAgent({
        name: "agent-a",
        role: "coder",
        provider: "exe-dev-gateway",
        model: "fixture-model",
        contextWindow: 200_000,
        agentsRoot: root,
        skipFlair: true,
        noClobber: false,
      });
    } catch (err) {
      thrown = err;
    } finally {
      process.umask(previousUmask);
      watchPath = undefined;
    }
    if (thrown !== undefined) throw thrown;

    // The creation was observed (the test cannot pass by seeing nothing).
    expect(observedModes.length).toBeGreaterThan(0);
    for (const mode of observedModes) expect(mode & 0o077).toBe(0);
    expect(realStatSync(authPath).mode & 0o777).toBe(0o600);
  });
});
