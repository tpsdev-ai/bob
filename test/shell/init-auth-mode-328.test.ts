import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const realOpenSync = realFs.openSync;
const realWriteFileSync = realFs.writeFileSync;
const realRenameSync = realFs.renameSync;
const realStatSync = realFs.statSync;
const realFchmodSync = realFs.fchmodSync;
const realCloseSync = realFs.closeSync;

let watchPath: string | undefined;
const observedModes: number[] = [];
const authFds = new Set<number>();
let failure: "write" | "chmod" | "rename" | undefined;
let beforeRename: ((temp: string, destination: string) => void) | undefined;
let renameCount = 0;

function isAuthPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    watchPath !== undefined &&
    (path === watchPath ||
      (dirname(path) === dirname(watchPath) &&
        basename(path).startsWith(`.${basename(watchPath)}-`) &&
        path.endsWith(".tmp")))
  );
}

function observe(path: unknown): void {
  if (!isAuthPath(path)) return;
  observedModes.push(realStatSync(path).mode & 0o777);
}

mock.module("node:fs", () => ({
  ...realFs,
  openSync: (...args: unknown[]) => {
    const fd = (realOpenSync as (...a: unknown[]) => number)(...args);
    if (isAuthPath(args[0])) {
      authFds.add(fd);
      if (args[0] !== watchPath) {
        expect(Number(args[1]) & realFs.constants.O_EXCL).toBe(realFs.constants.O_EXCL);
        expect(args[2]).toBe(0o600);
      }
    }
    observe(args[0]);
    return fd;
  },
  writeFileSync: (...args: unknown[]) => {
    if (failure === "write" && (authFds.has(Number(args[0])) || isAuthPath(args[0]))) {
      (realWriteFileSync as (...a: unknown[]) => unknown)(args[0], "partial");
      throw new Error("injected write failure");
    }
    const result = (realWriteFileSync as (...a: unknown[]) => unknown)(...args);
    observe(args[0]);
    return result;
  },
  renameSync: (...args: unknown[]) => {
    if (args[1] === watchPath) {
      beforeRename?.(String(args[0]), String(args[1]));
      if (failure === "rename") throw new Error("injected rename failure");
      renameCount++;
    }
    const result = (realRenameSync as (...a: unknown[]) => unknown)(...args);
    observe(args[1]);
    return result;
  },
  fchmodSync: (fd: number, mode: number) => {
    if (failure === "chmod" && authFds.has(fd)) throw new Error("injected chmod failure");
    return realFchmodSync(fd, mode);
  },
  closeSync: (fd: number) => {
    authFds.delete(fd);
    return realCloseSync(fd);
  },
}));

afterAll(() => {
  mock.restore();
});

const roots: string[] = [];

afterEach(() => {
  watchPath = undefined;
  failure = undefined;
  beforeRename = undefined;
  renameCount = 0;
  observedModes.length = 0;
  authFds.clear();
  for (const root of roots.splice(0)) realFs.rmSync(root, { recursive: true, force: true });
});

describe("bob#328 — auth.json under a --force init", () => {
  it.each([0o022, 0o077, 0o200])(
    "creates auth.json without group/other bits under umask %i",
    async (umask) => {
      const { initAgent } = await import("../../src/shell/init.js");
      const root = realFs.mkdtempSync(join(tmpdir(), "bob-328-"));
      roots.push(root);
      const authPath = join(root, "agent-a", ".pi-agent", "auth.json");

      for (const rel of ["", "bin", "work", "memory", ".pi-agent"]) {
        realFs.mkdirSync(join(root, "agent-a", rel), { recursive: true });
      }

      observedModes.length = 0;
      watchPath = authPath;
      const previousUmask = process.umask(umask);
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

      expect(observedModes.length).toBeGreaterThan(0);
      for (const mode of observedModes) expect(mode & 0o077).toBe(0);
      expect(realStatSync(authPath).mode & 0o777).toBe(0o600);
      expect(realStatSync(join(root, "agent-a", "bin", "agent-a")).mode & 0o777).toBe(0o755);
    },
  );

  async function replacement() {
    const { initAgent } = await import("../../src/shell/init.js");
    const root = realFs.mkdtempSync(join(tmpdir(), "bob-328-"));
    roots.push(root);
    const piDir = join(root, "agent-a", ".pi-agent");
    realFs.mkdirSync(piDir, { recursive: true });
    const authPath = join(piDir, "auth.json");
    const original = Buffer.from('{"original":"credential"}\n');
    realWriteFileSync(authPath, original);
    realFs.chmodSync(authPath, 0o644);
    watchPath = authPath;
    return {
      authPath,
      original,
      run: () =>
        initAgent({
          name: "agent-a",
          role: "coder",
          provider: "exe-dev-gateway",
          model: "fixture-model",
          contextWindow: 200_000,
          agentsRoot: root,
          skipFlair: true,
          noClobber: false,
        }),
      temps: () =>
        realFs
          .readdirSync(join(root, "agent-a"), { recursive: true })
          .filter((name) => String(name).endsWith(".tmp")),
    };
  }

  it("replaces a 0644 auth.json by renaming a completed 0600 sibling", async () => {
    const { authPath, original, run, temps } = await replacement();
    beforeRename = (temp, destination) => {
      expect(destination).toBe(authPath);
      expect(dirname(temp)).toBe(dirname(authPath));
      expect(realFs.readFileSync(destination)).toEqual(original);
      expect(realStatSync(destination).mode & 0o777).toBe(0o644);
      expect(JSON.parse(realFs.readFileSync(temp, "utf8"))).toEqual({
        anthropic: { type: "api_key", key: "exe-gateway-placeholder" },
      });
      expect(realStatSync(temp).mode & 0o777).toBe(0o600);
    };
    run();
    expect(renameCount).toBe(1);
    expect(observedModes.length).toBeGreaterThan(0);
    for (const mode of observedModes) expect(mode & 0o077).toBe(0);
    expect(realFs.readFileSync(authPath)).not.toEqual(original);
    expect(realStatSync(authPath).mode & 0o777).toBe(0o600);
    expect(temps()).toEqual([]);
  });

  for (const stage of ["write", "chmod", "rename"] as const) {
    it(`preserves auth.json and removes the temp after a ${stage} failure`, async () => {
      const { authPath, original, run, temps } = await replacement();
      failure = stage;
      expect(run).toThrow(`injected ${stage} failure`);
      expect(realFs.readFileSync(authPath)).toEqual(original);
      expect(realStatSync(authPath).mode & 0o777).toBe(0o644);
      expect(temps()).toEqual([]);
    });
  }
});
