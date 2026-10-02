import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultStateRoot, JobManager } from "../../../src/capabilities/work/run.js";

let scratch: string;
let savedState: string | undefined;
let savedTmp: string | undefined;
let manager: JobManager | undefined;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "bob-state-test-")));
  savedState = process.env.BOB_STATE_DIR;
  savedTmp = process.env.TMPDIR;
  process.env.BOB_STATE_DIR = join(scratch, "state");
  process.env.TMPDIR = join(scratch, "tmp");
  mkdirSync(process.env.TMPDIR);
  mkdirSync(join(scratch, "workspace"));
});
afterEach(async () => {
  await manager?.endRun();
  manager = undefined;
  if (savedState === undefined) delete process.env.BOB_STATE_DIR;
  else process.env.BOB_STATE_DIR = savedState;
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  rmSync(scratch, { recursive: true, force: true });
});

describe("private persistent work state", () => {
  for (const [platform, env, suffix] of [
    ["linux", {}, ".local/state/bob"],
    ["linux", { XDG_STATE_HOME: "/xdg" }, "/xdg/bob"],
    ["linux", { XDG_STATE_HOME: "relative" }, ".local/state/bob"],
    ["darwin", { XDG_STATE_HOME: "/ignored" }, "Library/Application Support/bob"],
  ] as const) {
    it(`resolves ${platform} with ${JSON.stringify(env)} without creating anything`, () => {
      const home = join(scratch, "home");
      const expected = suffix.startsWith("/") ? suffix : join(home, suffix);
      expect(defaultStateRoot({ platform, env, home })).toBe(expected);
      expect(existsSync(home)).toBe(false);
    });
  }

  for (const platform of ["linux", "darwin"] as const) {
    it(`BOB_STATE_DIR wins on ${platform}`, () => {
      expect(
        defaultStateRoot({
          platform,
          env: { BOB_STATE_DIR: scratch, XDG_STATE_HOME: "/ignored" },
          home: "/unused",
        }),
      ).toBe(scratch);
    });
  }

  for (const override of ["relative", ""]) {
    it(`refuses the non-absolute override ${JSON.stringify(override)}`, () => {
      process.env.BOB_STATE_DIR = override;
      expect(() => defaultStateRoot()).toThrow(/BOB_STATE_DIR.*absolute/);
    });
  }

  for (const unsafe of ["symlink", "group-writable", "world-readable"] as const) {
    it(`refuses a ${unsafe} state root before starting a command`, async () => {
      const state = process.env.BOB_STATE_DIR as string;
      if (unsafe === "symlink") {
        mkdirSync(join(scratch, "target"), { mode: 0o700 });
        symlinkSync(join(scratch, "target"), state);
      } else {
        mkdirSync(state, { mode: 0o700 });
        chmodSync(state, unsafe === "group-writable" ? 0o720 : 0o704);
      }
      manager = new JobManager();
      await expect(
        manager.start({ command: "touch started" }, join(scratch, "workspace")),
      ).rejects.toThrow(/not a plain directory|mode/);
      expect(existsSync(join(scratch, "workspace", "started"))).toBe(false);
    });
  }

  it("creates private persistent records and separate temporary captures, ignoring the legacy root", async () => {
    const legacy = join(tmpdir(), `bob-work-${process.getuid?.() ?? "user"}`);
    mkdirSync(legacy);
    writeFileSync(join(legacy, "sentinel"), "unchanged");
    process.env.BOB_STATE_DIR = join(scratch, "missing", "parent", "state");
    manager = new JobManager();
    await manager.bootSweep();
    const job = await manager.start({ command: "echo private-state" }, join(scratch, "workspace"));
    await job.done;
    const capture = manager.report(job).output_ref;
    const run = manager.runDir as string;
    expect(manager.stateRoot).toBe(process.env.BOB_STATE_DIR);
    expect(statSync(manager.stateRoot).mode & 0o777).toBe(0o700);
    expect(dirname(run)).toBe(manager.stateRoot);
    expect(dirname(dirname(capture))).toBe(tmpdir());
    expect(statSync(dirname(capture)).mode & 0o777).toBe(0o700);
    expect(statSync(capture).mode & 0o777).toBe(0o600);
    await manager.endRun();
    expect(existsSync(dirname(capture))).toBe(false);
    expect(existsSync(join(run, "ended.json"))).toBe(true);
    expect(readdirSync(legacy)).toEqual(["sentinel"]);
  });

  for (const location of ["workspace", "repository"] as const) {
    it(`refuses a root inside the ${location}`, async () => {
      const repo = join(scratch, "workspace");
      mkdirSync(join(repo, ".git"));
      const cwd = join(repo, "subdir");
      mkdirSync(cwd);
      process.env.BOB_STATE_DIR = join(location === "workspace" ? cwd : repo, "state");
      manager = new JobManager();
      await expect(manager.start({ command: "true" }, cwd)).rejects.toThrow(/inside/);
      expect(existsSync(process.env.BOB_STATE_DIR)).toBe(false);
    });
  }

  it("refuses a symlink override with a trailing slash", async () => {
    mkdirSync(join(scratch, "target"), { mode: 0o700 });
    symlinkSync(join(scratch, "target"), process.env.BOB_STATE_DIR as string);
    process.env.BOB_STATE_DIR += "/";
    manager = new JobManager();
    await expect(manager.start({ command: "true" }, join(scratch, "workspace"))).rejects.toThrow(
      /not a plain directory/,
    );
  });

  it("removes scratch and partial records when the supervisor record cannot be written", async () => {
    manager = new JobManager({
      writeRecord: () => {
        throw new Error("injected");
      },
    });
    await expect(manager.start({ command: "true" }, join(scratch, "workspace"))).rejects.toThrow(
      /storage could not be created/,
    );
    expect(readdirSync(tmpdir())).toEqual([]);
    expect(readdirSync(manager.stateRoot)).toEqual([]);
  });

  for (const kind of ["matching", "changed-inode", "symlink", "outside-temp"] as const) {
    it(`boot sweep handles ${kind} scratch without trusting a path alone`, async () => {
      const out = mkdtempSync(join(kind === "outside-temp" ? scratch : tmpdir(), "bob-run-"));
      const st = statSync(out, { bigint: true });
      let path = out;
      if (kind === "symlink") {
        path = join(tmpdir(), "bob-run-abcdef");
        symlinkSync(out, path);
      }
      manager = new JobManager();
      const run = join(manager.stateRoot, "run-stale");
      mkdirSync(join(run, "jobs"), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(run, "run.json"),
        JSON.stringify({
          v: 1,
          supervisor_pid: process.pid,
          supervisor_instance: "gone",
          scratch_dir: path,
          scratch_dev: String(st.dev),
          scratch_ino: kind === "changed-inode" ? "-1" : String(st.ino),
        }),
      );
      await manager.bootSweep();
      expect(existsSync(out)).toBe(kind !== "matching");
      expect(existsSync(join(run, "ended.json"))).toBe(true);
    });
  }
});
