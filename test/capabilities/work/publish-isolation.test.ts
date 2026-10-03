import { afterEach, beforeEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CandidateRecord,
  candidateIdentity,
  candidateRecordPath,
  type GitRunner,
} from "../../../src/capabilities/work/apply-patch.js";
import { type WorkPiLike, wireWork } from "../../../src/capabilities/work/capability.js";
import {
  type PublishDeps,
  publish,
  publishJournalPath,
  writeJournalAtomic,
} from "../../../src/capabilities/work/publish.js";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-check-isolation-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(command: string) {
  const repo = join(scratch, "repo");
  const stateRoot = join(scratch, "state");
  mkdirSync(repo);
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(join(stateRoot, "candidates"), { mode: 0o700 });
  writeFileSync(join(repo, "source.txt"), "builder");
  const binding: TaskBinding = {
    task_id: "task",
    publication_id: "publication",
    repository: repo,
    workspace: repo,
    artifact_root: join(scratch, "artifacts"),
    base_oid: "a".repeat(40),
    mode: "build",
    declared_paths: ["source.txt"],
    check_commands: [command],
    destination: { remote: join(scratch, "remote.git"), ref: "refs/heads/main" },
  };
  const record: CandidateRecord = {
    ...binding,
    candidate_id: "",
    tree_oid: "b".repeat(40),
    patch_sha256: "c".repeat(64),
    artifact_path: "patch",
    changed_paths: ["source.txt"],
    created_at: new Date().toISOString(),
  };
  record.candidate_id = candidateIdentity(record);
  writeFileSync(candidateRecordPath(stateRoot, record.candidate_id), JSON.stringify(record));
  let pushes = 0;
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const git: GitRunner = (args, inv) => {
    calls.push({ args, cwd: inv.cwd });
    let stdout = "";
    if (args[0] === "config") return { status: 1, stdout, stderr: "" };
    if (args[0] === "remote") return { status: 2, stdout, stderr: "not a remote name" };
    if (args[0] === "diff-tree")
      stdout = `:100644 100644 ${binding.base_oid} ${record.tree_oid} M\0source.txt\0`;
    if (args[0] === "hash-object") stdout = "d".repeat(40);
    if (args[0] === "rev-parse") stdout = join(repo, ".git");
    if (args[0] === "checkout-index") writeFileSync(join(inv.cwd, "source.txt"), "candidate");
    if (args[0] === "ls-remote")
      stdout = `${pushes ? "d".repeat(40) : binding.base_oid}\trefs/heads/main\n`;
    if (args[0] === "merge-base" && args[2] === "d".repeat(40))
      return { status: 1, stdout, stderr: "" };
    if (args[0] === "push") pushes++;
    return { status: 0, stdout, stderr: "" };
  };
  const tools: Record<
    string,
    { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }
  > = {};
  const pi: WorkPiLike = {
    registerTool(tool) {
      tools[tool.name] = tool as never;
    },
  };
  const session = wireWork({
    pi,
    taskBinding: binding,
    stateRoot,
    publishDeps: { git },
    log: () => {},
  });
  return { ...session, tools, repo, record, binding, stateRoot, git, calls, pushes: () => pushes };
}

it("an ordinary successful run is not candidate-bound publication evidence", async () => {
  const command = 'test "$(cat source.txt)" = builder';
  const f = fixture(command);
  try {
    const run = await f.tools.run.execute("run", { command }, undefined, undefined, {
      cwd: f.repo,
    });
    expect(run.details.outcome).toBe("exited");
    expect(run.details.exit_code).toBe(0);
    const published = await f.tools.publish.execute("publish", {
      candidate_id: f.record.candidate_id,
      commit_message: "candidate",
    });
    expect(published.details.reason).toBe("check_failed");
    expect(published.details.status).toBe("refused");
    expect(f.pushes()).toBe(0);
  } finally {
    await f.manager.endRun();
  }
});

it("publication's executor excludes a Bob credential and BASH_ENV", async () => {
  const oldCredential = process.env.BOB_TEST_CREDENTIAL;
  const oldStartup = process.env.BASH_ENV;
  const f = fixture(
    'test -z "$BOB_TEST_CREDENTIAL$BASH_ENV" && test "$(cat source.txt)" = candidate',
  );
  const startup = join(scratch, "startup.sh");
  writeFileSync(startup, "exit 41\n");
  process.env.BOB_TEST_CREDENTIAL = "fixture-secret";
  process.env.BASH_ENV = startup;
  try {
    const published = await f.tools.publish.execute("publish", {
      candidate_id: f.record.candidate_id,
      commit_message: "candidate",
    });
    expect(published.details.status).toBe("published");
    expect(f.pushes()).toBe(1);
  } finally {
    if (oldCredential === undefined) delete process.env.BOB_TEST_CREDENTIAL;
    else process.env.BOB_TEST_CREDENTIAL = oldCredential;
    if (oldStartup === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = oldStartup;
    await f.manager.endRun();
  }
});

for (const field of ["candidate_id", "tree_oid", "patch_sha256"]) {
  it(`refuses a candidate with a mismatched ${field} before Git`, async () => {
    const f = fixture("true");
    try {
      const path = candidateRecordPath(f.stateRoot, f.record.candidate_id);
      const record = JSON.parse(readFileSync(path, "utf8"));
      record[field] = "f".repeat(field === "patch_sha256" ? 64 : 40);
      writeFileSync(path, JSON.stringify(record));
      const out = await f.tools.publish.execute("publish", {
        candidate_id: f.record.candidate_id,
        commit_message: "x",
      });
      expect(out.details.reason).toBe("candidate_mismatch");
      expect(f.calls).toEqual([]);
    } finally {
      await f.manager.endRun();
    }
  });
}

for (const target of ["candidate", "journal", "candidates", "publications"]) {
  it(`refuses a dangling ${target} symlink`, async () => {
    const f = fixture("true");
    try {
      const path =
        target === "candidate"
          ? candidateRecordPath(f.stateRoot, f.record.candidate_id)
          : target === "journal"
            ? publishJournalPath(f.stateRoot, f.binding.publication_id)
            : join(f.stateRoot, target);
      if (target === "journal") mkdirSync(join(f.stateRoot, "publications"), { mode: 0o700 });
      if (target === "candidate" || target === "candidates") renameSync(path, `${path}.saved`);
      symlinkSync(`${path}.absent`, path);
      const out = await f.tools.publish.execute("publish", {
        candidate_id: f.record.candidate_id,
        commit_message: "x",
      });
      expect(out.details.reason).toBe("storage_failed");
      expect(f.pushes()).toBe(0);
    } finally {
      await f.manager.endRun();
    }
  });
}

it("a second process cannot publish while the first holds the publication lock", async () => {
  const f = fixture("true");
  const input = {
    binding: f.binding,
    params: { candidate_id: f.record.candidate_id, commit_message: "x" },
    stateRoot: f.stateRoot,
  };
  const modulePath = new URL("../../../src/capabilities/work/publish.ts", import.meta.url).href;
  try {
    const out = await publish({
      ...input,
      deps: {
        git: f.git,
        runCheck: async () => {
          const child = spawnSync(
            process.execPath,
            [
              "-e",
              `import { publish } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await publish(${JSON.stringify(input)})));`,
            ],
            { encoding: "utf8" },
          );
          expect(child.status).toBe(0);
          expect(JSON.parse(child.stdout).reason).toBe("publication_locked");
          return {
            outcome: "exited",
            exit_code: 0,
            cleanup_state: "group_empty",
            output_complete: true,
          };
        },
      },
    });
    expect(out.status).toBe("published");
    expect(f.pushes()).toBe(1);
  } finally {
    await f.manager.endRun();
  }
});

it("an abandoned publication lock refuses", async () => {
  const f = fixture("true");
  try {
    mkdirSync(join(f.stateRoot, "publications"), { mode: 0o700 });
    mkdirSync(join(f.stateRoot, "publications", `${f.binding.publication_id}.lock`));
    const out = await f.tools.publish.execute("publish", {
      candidate_id: f.record.candidate_id,
      commit_message: "x",
    });
    expect(out.details.reason).toBe("publication_locked");
    expect(f.calls).toEqual([]);
  } finally {
    await f.manager.endRun();
  }
});

for (const changed of ["checks", "ref", "create", "workspace", "endpoint"]) {
  it(`refuses changed ${changed} authority before reusing journal checks`, async () => {
    const f = fixture("true");
    const params = { candidate_id: f.record.candidate_id, commit_message: "x" };
    try {
      const first = await f.tools.publish.execute("publish", params);
      expect(first.details.status).toBe("published");
      const binding = structuredClone(f.binding);
      if (changed === "checks") binding.check_commands = ["different check"];
      if (changed === "ref") binding.destination.ref = "refs/heads/other";
      if (changed === "create") binding.destination.create = true;
      if (changed === "workspace") binding.workspace = join(scratch, "other-workspace");
      if (changed === "endpoint") binding.destination.remote = join(scratch, "other.git");
      f.calls.length = 0;
      const out = await publish({ binding, params, stateRoot: f.stateRoot, deps: { git: f.git } });
      expect(out.reason).toBe(
        changed === "workspace" ? "candidate_mismatch" : "publication_conflict",
      );
      expect(f.calls.filter(({ args }) => args[0] === "push" || args[0] === "ls-remote")).toEqual(
        [],
      );
      expect(f.manager.list()).toHaveLength(1);
    } finally {
      await f.manager.endRun();
    }
  });
}

function attempt(f: ReturnType<typeof fixture>, deps: PublishDeps = {}) {
  return publish({
    binding: f.binding,
    params: { candidate_id: f.record.candidate_id, commit_message: "candidate" },
    stateRoot: f.stateRoot,
    deps: {
      git: f.git,
      runCheck: async () => ({
        outcome: "exited",
        exit_code: 0,
        cleanup_state: "group_empty",
        output_complete: true,
      }),
      ...deps,
    },
  });
}

for (const output of [
  `${"d".repeat(40)}\trefs/heads/other\n`,
  `${"d".repeat(40)}\trefs/heads/main\n${"a".repeat(40)}\trefs/heads/other\n`,
  `${"a".repeat(40)}\trefs/heads/other\n${"d".repeat(40)}\trefs/heads/main\n`,
  `${"d".repeat(40)}\trefs/heads/main\n${"d".repeat(40)}\trefs/heads/main\n`,
  `${"d".repeat(40)}\trefs/heads/main\n\n`,
  `${"d".repeat(40)}\trefs/heads/main\textra\n`,
  " \n",
]) {
  for (const stage of ["inspection", "confirmation"]) {
    it(`rejects unexpected remote output during ${stage}: ${JSON.stringify(output)}`, async () => {
      const f = fixture("true");
      try {
        const out = await attempt(f, {
          git: (args, inv) => {
            if (args[0] === "ls-remote" && (stage === "inspection" || f.pushes() > 0))
              return { status: 0, stdout: output, stderr: "" };
            return f.git(args, inv);
          },
        });
        expect(out.status).toBe("indeterminate");
        expect(out.push_state).toBe("unknown");
        expect(f.pushes()).toBe(stage === "inspection" ? 0 : 1);
        const journal = JSON.parse(
          readFileSync(publishJournalPath(f.stateRoot, f.binding.publication_id), "utf8"),
        );
        expect(journal.phase).not.toBe("published");
      } finally {
        await f.manager.endRun();
      }
    });
  }
}

for (const phase of ["pushed", "published"]) {
  it(`a failed ${phase} journal write returns indeterminate with the accepted push`, async () => {
    const f = fixture("true");
    try {
      let failed = false;
      const out = await attempt(f, {
        writeJournal: (path, data) => {
          if (JSON.parse(data).phase === phase) {
            failed = true;
            throw new Error("disk full");
          }
          writeJournalAtomic(path, data);
        },
      });
      expect(failed).toBe(true);
      expect(out.status).toBe("indeterminate");
      expect(out.reason).toBe("journal_write_failed");
      expect(out.phase).toBe(phase);
      expect(out.commit_oid).toBe("d".repeat(40));
      expect(out.push_state).toBe("confirmed_present");
      expect(f.pushes()).toBe(1);
      const retry = await attempt(f);
      expect(retry.status).toBe("published");
      expect(retry.commit_oid).toBe(out.commit_oid);
      expect(f.pushes()).toBe(1);
    } finally {
      await f.manager.endRun();
    }
  });
}

for (const phase of ["pushing", "pushed", "published"]) {
  it(`a failed retry write retains the ${phase} journal's push state`, async () => {
    const f = fixture("true");
    try {
      if (phase === "published") expect((await attempt(f)).status).toBe("published");
      else {
        const out = await attempt(f, {
          writeJournal: (path, data) => {
            const next = JSON.parse(data).phase;
            if (next === (phase === "pushing" ? "pushed" : "published"))
              throw new Error("disk full");
            writeJournalAtomic(path, data);
          },
        });
        expect(out.status).toBe("indeterminate");
      }
      const journal = JSON.parse(
        readFileSync(publishJournalPath(f.stateRoot, f.binding.publication_id), "utf8"),
      );
      expect(journal.phase).toBe(phase);
      const out = await attempt(f, {
        writeJournal: () => {
          throw new Error("still full");
        },
      });
      expect(out.status).toBe("indeterminate");
      expect(out.reason).toBe("journal_write_failed");
      expect(out.push_state).toBe(journal.push_state);
      expect(out.commit_oid).toBe(journal.commit_oid);
      expect(f.pushes()).toBe(1);
    } finally {
      await f.manager.endRun();
    }
  });
}

for (const statuses of [
  [128, 128],
  [128, 0],
  [1, 128],
  [-1, 1],
]) {
  it(`ancestry errors ${statuses.join("/")} are indeterminate`, async () => {
    const f = fixture("true");
    let comparisons = 0;
    try {
      const out = await attempt(f, {
        git: (args, inv) => {
          if (args[0] === "merge-base")
            return { status: statuses[comparisons++], stdout: "", stderr: "object unavailable" };
          return f.git(args, inv);
        },
      });
      expect(out.status).toBe("indeterminate");
      expect(out.reason).toBe("ancestry_unknown");
      expect(out.push_state).toBe("unknown");
      expect(f.pushes()).toBe(0);
    } finally {
      await f.manager.endRun();
    }
  });
}

for (const stage of ["before", "after"]) {
  it(`a failed index refresh ${stage} checks stops verification before a clean diff`, async () => {
    const f = fixture("true");
    let refreshes = 0;
    let diffs = 0;
    try {
      const out = await attempt(f, {
        git: (args, inv) => {
          if (args[0] === "update-index" && ++refreshes === (stage === "before" ? 1 : 2))
            return { status: 1, stdout: "", stderr: "refresh failed" };
          if (args[0] === "diff-index") {
            diffs++;
            return { status: 0, stdout: "", stderr: "" };
          }
          return f.git(args, inv);
        },
      });
      expect(out.status).toBe("refused");
      expect(out.message).toContain("verify_failed");
      expect(diffs).toBe(stage === "before" ? 0 : 1);
      expect(f.pushes()).toBe(0);
    } finally {
      await f.manager.endRun();
    }
  });
}
