import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultStateRoot, JobManager, RunRefusal } from "../../../src/capabilities/work/run.js";

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
    // beforeEach sets TMPDIR to scratch/tmp, so this is the path os.tmpdir() gives the code under test.
    const legacy = join(scratch, "tmp", `bob-work-${process.getuid?.() ?? "user"}`);
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
      await expect(manager.start({ command: "true" }, cwd)).rejects.toThrow(
        /state directory .* is inside/,
      );
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

  it("names an explicit stateRoot as the state directory in a containment refusal", async () => {
    delete process.env.BOB_STATE_DIR;
    const workspace = join(scratch, "workspace");
    const stateRoot = join(workspace, "state");
    manager = new JobManager({ stateRoot });
    await expect(manager.start({ command: "true" }, workspace)).rejects.toThrow(
      `run refused: state directory (${stateRoot}) is inside`,
    );
    expect(existsSync(stateRoot)).toBe(false);
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

  for (const failedRemoval of ["scratch", "run", "both"] as const) {
    it(`preserves the storage refusal when ${failedRemoval} removal throws`, async () => {
      let run = "";
      let out = "";
      manager = new JobManager({
        writeRecord: (path, value) => {
          run = dirname(path);
          out = (value as { scratch_dir: string }).scratch_dir;
          throw Object.assign(new Error("allocation failed"), { code: "EIO" });
        },
      });
      const attempts: string[] = [];
      const remove = fs.rmSync;
      const removal = spyOn(fs, "rmSync").mockImplementation((path, options) => {
        const target = String(path);
        attempts.push(target);
        if (failedRemoval === "both" || target === (failedRemoval === "scratch" ? out : run)) {
          throw Object.assign(new Error("removal failed"), { code: "EACCES" });
        }
        remove(path, options);
      });
      let caught: unknown;
      try {
        await manager.start({ command: "touch started" }, join(scratch, "workspace"));
      } catch (err) {
        caught = err;
      } finally {
        removal.mockRestore();
      }
      expect(attempts).toEqual([out, run]);
      expect(caught).toBeInstanceOf(RunRefusal);
      const message = (caught as Error).message;
      expect(message).toStartWith("run refused: private run storage could not be created (EIO).");
      for (const path of [out, run]) {
        const failed =
          failedRemoval === "both" || path === (failedRemoval === "scratch" ? out : run);
        expect(existsSync(path)).toBe(failed);
        if (failed) expect(message).toContain(`Cleanup could not remove ${path} (EACCES).`);
      }
      expect(manager.runDir).toBeNull();
      expect(existsSync(join(scratch, "workspace", "started"))).toBe(false);
    });
  }

  it("rethrows the original RunRefusal after attempting both removals", async () => {
    const refusal = new RunRefusal("run refused: injected allocation refusal.");
    let run = "";
    let out = "";
    manager = new JobManager({
      writeRecord: (path, value) => {
        run = dirname(path);
        out = (value as { scratch_dir: string }).scratch_dir;
        throw refusal;
      },
    });
    const attempts: string[] = [];
    const remove = fs.rmSync;
    const removal = spyOn(fs, "rmSync").mockImplementation((path, options) => {
      attempts.push(String(path));
      if (String(path) === out) {
        throw Object.assign(new Error("removal failed"), { code: "EACCES" });
      }
      remove(path, options);
    });
    let caught: unknown;
    try {
      await manager.start({ command: "true" }, join(scratch, "workspace"));
    } catch (err) {
      caught = err;
    } finally {
      removal.mockRestore();
    }
    expect(attempts).toEqual([out, run]);
    expect(caught).toBe(refusal);
    expect(refusal.message).toStartWith("run refused: injected allocation refusal.");
    expect(refusal.message).toContain(`Cleanup could not remove ${out} (EACCES).`);
    expect(existsSync(run)).toBe(false);
  });

  it("sweeps a crashed run's captures after TMPDIR changes", async () => {
    manager = new JobManager();
    const job = await manager.start({ command: "echo captured" }, join(scratch, "workspace"));
    await job.done;
    const capture = manager.report(job).output_ref;
    const run = manager.runDir as string;
    const record = join(run, "run.json");
    const meta = JSON.parse(readFileSync(record, "utf8"));
    meta.supervisor_instance = "gone";
    writeFileSync(record, JSON.stringify(meta));
    const originalRoot = realpathSync(tmpdir());
    process.env.TMPDIR = join(scratch, "other-tmp");
    mkdirSync(process.env.TMPDIR);

    await new JobManager().bootSweep();

    expect(existsSync(dirname(capture))).toBe(false);
    expect(existsSync(join(run, "ended.json"))).toBe(true);
    expect(meta.scratch_root).toBe(originalRoot);
  });

  for (const root of ["different-root", "parent-root", "relative", "", null, 42] as const) {
    it(`refuses the tampered recorded scratch root ${JSON.stringify(root)}`, async () => {
      manager = new JobManager();
      const job = await manager.start({ command: "echo captured" }, join(scratch, "workspace"));
      await job.done;
      const capture = manager.report(job).output_ref;
      const run = manager.runDir as string;
      const record = join(run, "run.json");
      const meta = JSON.parse(readFileSync(record, "utf8"));
      const otherRoot = join(scratch, "other-tmp");
      mkdirSync(otherRoot);
      meta.supervisor_instance = "gone";
      meta.scratch_root =
        root === "different-root" ? otherRoot : root === "parent-root" ? scratch : root;
      writeFileSync(record, JSON.stringify(meta));

      await new JobManager().bootSweep();

      expect(readFileSync(capture, "utf8")).toBe("captured\n");
      expect(existsSync(join(run, "ended.json"))).toBe(true);
    });
  }

  for (const recordedRoot of [false, true]) {
    for (const kind of [
      "matching",
      "changed-inode",
      "changed-device",
      "symlink",
      "group-writable",
      "world-readable",
      "outside-temp",
    ] as const) {
      it(`boot sweep handles ${kind} scratch with recorded root ${recordedRoot}`, async () => {
        const out = mkdtempSync(join(kind === "outside-temp" ? scratch : tmpdir(), "bob-run-"));
        const st = statSync(out, { bigint: true });
        let path = out;
        if (kind === "symlink") {
          path = join(tmpdir(), "bob-run-abcdef");
          symlinkSync(out, path);
        }
        if (kind === "group-writable" || kind === "world-readable") {
          chmodSync(out, kind === "group-writable" ? 0o720 : 0o704);
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
            ...(recordedRoot ? { scratch_root: realpathSync(tmpdir()) } : {}),
            scratch_dev: kind === "changed-device" ? "-1" : String(st.dev),
            scratch_ino: kind === "changed-inode" ? "-1" : String(st.ino),
          }),
        );
        await manager.bootSweep();
        expect(existsSync(out)).toBe(kind !== "matching");
        expect(existsSync(join(run, "ended.json"))).toBe(true);
      });
    }
  }
});
