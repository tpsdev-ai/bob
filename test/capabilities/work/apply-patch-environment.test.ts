import { afterEach, beforeEach, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "../../../src/capabilities/work/apply-patch.js";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-apply-env-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function setup() {
  const repo = join(scratch, "repo");
  const artifacts = join(scratch, "artifacts");
  mkdirSync(repo);
  mkdirSync(artifacts);
  const git = (args: string[], input?: string) => {
    const r = spawnSync("git", args, {
      cwd: repo,
      input,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  git(["init", "-q"]);
  const tree = git(["hash-object", "-t", "tree", "-w", "--stdin"], "");
  const base = git(
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    `tree ${tree}\nauthor t <t@t> 0 +0000\ncommitter t <t@t> 0 +0000\n\nbase\n`,
  );
  const binding: TaskBinding = {
    task_id: "task",
    publication_id: "publication",
    repository: repo,
    workspace: repo,
    base_oid: base,
    mode: "build",
    artifact_root: artifacts,
    declared_paths: [],
    check_commands: [],
    destination: { remote: "origin", ref: "refs/heads/main" },
  };
  const params = (name: string) => {
    const patch = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${name}\n`;
    writeFileSync(join(artifacts, name), patch);
    return {
      expected_base: base,
      patch_artifact: { path: name, sha256: createHash("sha256").update(patch).digest("hex") },
    };
  };
  return { repo, git, binding, params, stateRoot: join(scratch, "state") };
}

it("ambient GIT_OBJECT_DIRECTORY cannot redirect candidate objects", () => {
  const fx = setup();
  const params = fx.params("new.txt");
  const objects = join(scratch, "objects");
  cpSync(join(fx.repo, ".git", "objects"), objects, { recursive: true });
  const before = readdirSync(objects, { recursive: true }).sort();
  const saved = process.env.GIT_OBJECT_DIRECTORY;
  process.env.GIT_OBJECT_DIRECTORY = objects;
  let out: ReturnType<typeof applyPatch>;
  try {
    out = applyPatch({ binding: fx.binding, params, stateRoot: fx.stateRoot });
  } finally {
    if (saved === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
    else process.env.GIT_OBJECT_DIRECTORY = saved;
  }
  expect(out.ok).toBe(true);
  expect(readdirSync(objects, { recursive: true }).sort()).toEqual(before);
  if (out.ok) {
    const blob = fx.git(["rev-parse", `${out.tree_oid}:new.txt`]);
    for (const oid of [out.tree_oid, blob]) {
      expect(existsSync(join(fx.repo, ".git", "objects", oid.slice(0, 2), oid.slice(2)))).toBe(
        true,
      );
    }
    expect(fx.git(["cat-file", "-p", blob])).toBe("new.txt");
  }
});

it("concurrent processes use independent indexes in a shared state root", async () => {
  const fx = setup();
  mkdirSync(fx.stateRoot, { mode: 0o700 });
  const worker = join(scratch, "worker.ts");
  const release = join(scratch, "release");
  writeFileSync(
    worker,
    `
    import { applyPatch } from ${JSON.stringify(import.meta.resolve("../../../src/capabilities/work/apply-patch.js"))};
    import { existsSync, writeFileSync } from "node:fs";
    import { spawnSync } from "node:child_process";
    const [binding, params, stateRoot, ready, release] = JSON.parse(process.argv[2]);
    const out = applyPatch({ binding, params, stateRoot, deps: { git(args, inv) {
      const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      if (inv.indexFile !== undefined) env.GIT_INDEX_FILE = inv.indexFile;
      const r = spawnSync("git", args, { cwd: inv.cwd, env, input: inv.input, encoding: "utf8" });
      if (args[0] === "read-tree" && r.status === 0) {
        writeFileSync(ready, inv.indexFile);
        const deadline = Date.now() + 10000;
        while (!existsSync(release)) {
          if (Date.now() > deadline) throw new Error("barrier timeout");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    } } });
    console.log(JSON.stringify(out));
  `,
  );
  const children = ["one.txt", "two.txt"].map((name) => {
    const ready = join(scratch, `${name}.ready`);
    const child = spawn(
      process.execPath,
      [worker, JSON.stringify([fx.binding, fx.params(name), fx.stateRoot, ready, release])],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const result = new Promise<ReturnType<typeof applyPatch>>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(stderr));
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch (err) {
            reject(err);
          }
        }
      });
    });
    return { child, result, ready };
  });
  try {
    const deadline = Date.now() + 10000;
    while (!children.every(({ ready }) => existsSync(ready))) {
      if (Date.now() > deadline) throw new Error("workers did not reach the barrier");
      await Bun.sleep(10);
    }
    const indexes = children.map(({ ready }) => readFileSync(ready, "utf8"));
    expect(indexes[0]).not.toBe(indexes[1]);
    for (const index of indexes) {
      expect(index).toContain(join(fx.stateRoot, "apply-"));
      expect(existsSync(index)).toBe(true);
    }
    writeFileSync(release, "go");
    const outcomes = await Promise.all(children.map(({ result }) => result));
    expect(outcomes.every((out) => out.ok)).toBe(true);
    if (outcomes[0].ok && outcomes[1].ok) {
      expect(outcomes[0].tree_oid).not.toBe(outcomes[1].tree_oid);
      expect(outcomes[0].changed_paths).toEqual(["one.txt"]);
      expect(outcomes[1].changed_paths).toEqual(["two.txt"]);
      for (const out of outcomes) {
        expect(
          JSON.parse(
            readFileSync(join(fx.stateRoot, "candidates", `${out.candidate_id}.json`), "utf8"),
          ).tree_oid,
        ).toBe(out.tree_oid);
      }
    }
    expect(readdirSync(fx.stateRoot).sort()).toEqual(["candidates"]);
    expect(readdirSync(fx.repo).sort()).toEqual([".git"]);
    expect(existsSync(join(fx.repo, ".git", "index"))).toBe(false);
  } finally {
    for (const { child } of children) child.kill();
    await Promise.allSettled(children.map(({ result }) => result));
  }
}, 20000);
