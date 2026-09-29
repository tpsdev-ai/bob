// Run end by PROCESS EXIT (bob#211): `bob run` disposes its session and exits
// without pi's session_shutdown, so the work capability also sweeps from the
// process `exit` hook — synchronously, with SIGKILL to every group it still
// owns. This runs a real child process (the supervisor) that starts a
// background job through the registered `run` tool and then exits; the test
// checks, from outside, that the job's group is gone and the record says why.

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupAlive, waitFor } from "./helpers.js";

const CAPABILITY = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "src",
  "capabilities",
  "work",
  "capability.ts",
);

// The child supervisor: CONSTANT text. What it needs (the capability module,
// the state root, the workspace) arrives through its environment.
const SUPERVISOR_SOURCE = `const { wireWork } = await import(process.env.WORK_TEST_CAPABILITY);
const tools = new Map();
const pi = { registerTool(t) { tools.set(t.name, t); } };
const { bootSweep } = wireWork({ pi, stateRoot: process.env.WORK_TEST_STATE_ROOT });
await bootSweep;
const res = await tools.get("run").execute("c1", { command: "sleep 30", background: true }, undefined, undefined, { cwd: process.env.WORK_TEST_WORKSPACE });
process.stdout.write(JSON.stringify({ pgid: res.details.pgid }) + "\\n");
process.exit(0);
`;

let scratch: string | undefined;
let pgid = 0;
afterEach(() => {
  if (pgid > 1) {
    try {
      process.kill(-pgid, "SIGKILL"); // the group the child's tool started, if it survived
    } catch {
      // gone, as expected
    }
  }
  pgid = 0;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("run end on process exit", () => {
  it("SIGKILLs every group the run still owns, records it and logs it", async () => {
    scratch = mkdtempSync(join(tmpdir(), "bob-work-exit-"));
    const stateRoot = join(scratch, "state");
    const workspace = join(scratch, "workspace");
    mkdirSync(workspace);
    const script = join(scratch, "supervisor.ts");
    writeFileSync(script, SUPERVISOR_SOURCE);
    // Every value reaches the child as data (its environment); the script text
    // is constant.
    const child = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        WORK_TEST_CAPABILITY: CAPABILITY,
        WORK_TEST_STATE_ROOT: stateRoot,
        WORK_TEST_WORKSPACE: workspace,
      },
    });
    expect(child.status).toBe(0);
    pgid = Number(JSON.parse(child.stdout.trim().split("\n").pop() ?? "{}").pgid);
    expect(pgid).toBeGreaterThan(1);
    expect(await waitFor(() => !groupAlive(pgid), 3000)).toBe(true);
    expect(child.stderr).toContain("work: run end (process exit): run-1");

    const [runDir] = readdirSync(stateRoot).filter((n) => n.startsWith("run-"));
    const [file] = readdirSync(join(stateRoot, runDir, "jobs"));
    expect(file).toBe(`pg-${pgid}.run-1.json`);
    const entry = JSON.parse(readFileSync(join(stateRoot, runDir, "jobs", file), "utf8"));
    expect(entry).toMatchObject({
      state: "finished",
      outcome: "cancelled",
      cancel_reason: "run_end",
      escalated: true,
      output_complete: false,
    });
    // The killed leader is still an unreaped zombie of the exiting supervisor;
    // the exit sweep checks that with ps and reports the group killed.
    expect(entry.cleanup_state).toBe("group_killed");
    // The capture directory went with the run.
    expect(readdirSync(join(stateRoot, runDir))).not.toContain("out");
  }, 30_000);
});
