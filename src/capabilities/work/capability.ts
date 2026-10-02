// The work capability's tools, decoupled from pi's real ExtensionAPI so tests can
// drive them through a real pi session (an inline probe extension) or a fake.
// `index.ts` is the thin pi extension factory.
//
// What this wires — three tools via pi.registerTool, plus two lifecycle hooks:
//   run         — start a command with a deadline; foreground (wait for the
//                 outcome) or background (return a run_id at once)
//   run_status  — one job's state/outcome and output excerpt, or (no run_id)
//                 every job this run owns
//   run_cancel  — cancel one of this run's jobs by its recorded process group
//   session_shutdown → cancel every job the run still owns (run.ts endRun)
//   process exit     → SIGKILL whatever is left (run.ts endRunSync)
//
// The workspace is pi's tool execution context `cwd` (the 5th `execute`
// argument); `run`'s own `cwd` resolves against it.

import { type TSchema, Type } from "typebox";
import {
  type ApplyPatchDeps,
  type ApplyPatchParams,
  type ApplyPatchRefusal,
  type ApplyPatchSuccess,
  applyPatch,
} from "./apply-patch.js";
import {
  type BootReap,
  CAPTURE_MAX_BYTES,
  DEFAULT_TIMEOUT_S,
  JobManager,
  type JobManagerOptions,
  type JobReport,
  LIMITS_TEXT,
  MAX_TIMEOUT_S,
  PI_PRIMITIVES,
  RunRefusal,
} from "./run.js";
import type { TaskBinding } from "./task-binding.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };

// The minimal slice of pi's ExtensionAPI this capability needs. Declared
// structurally so a test fake and the real ExtensionAPI both satisfy it.
export interface WorkPiLike {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: { cwd: string },
    ) => Promise<ToolResult>;
  }): void;
  on?(event: "session_shutdown", handler: () => unknown): void;
}

export interface WireWorkOptions extends JobManagerOptions {
  pi: WorkPiLike;
  // The launcher-supplied task binding (bob#275, S2a) this session retained, or
  // the parse error when one was present but malformed. Retained here, never
  // read from a tool argument, a model message or a file.
  taskBinding?: TaskBinding;
  taskBindingError?: string;
  // Seams for apply_patch (a fake git runner, the artifact-swap hook).
  applyPatchDeps?: ApplyPatchDeps;
}

// The two Limits sentences of bob#211, verbatim, plus what else the reader needs.
const RUN_DESCRIPTION =
  `Run a shell command (bash -c) in the workspace and report an honest outcome. ` +
  `Every command has a deadline: omit timeout_s for the default of ${DEFAULT_TIMEOUT_S} s; a larger request is capped at the hard maximum of ${MAX_TIMEOUT_S} s. ` +
  `(Slice 1 applies this default and maximum only; it does not yet clamp to the run's remaining budget.) ` +
  `At the deadline the command's process group gets SIGTERM, then SIGKILL after a short grace. ` +
  `outcome is one of exited, timed_out (escalated: true means SIGKILL was needed), signalled (a signal from outside the deadline), cancelled, no_exit_status; ` +
  `cleanup_state is one of group_empty, group_killed, escaped_or_unverified, verify_unavailable. ` +
  `Only outcome exited with exit_code 0 and cleanup_state group_empty or group_killed is success. ` +
  `stdout and stderr are captured to output_ref up to ${CAPTURE_MAX_BYTES / (1024 * 1024)} MiB (bytes past that cap are counted, not kept); it is an owner-only file outside the workspace, deleted when the bob run ends, and same-user readable, so it is not a confidentiality boundary. ` +
  `You get a bounded tail excerpt with secrets redacted; until the capture is complete, an unterminated final line is withheld. output_complete: false says the capture itself was cut short (the cap, a stopped drain, a failed write) or has gone missing. ` +
  `background: true returns a run_id at once: check it with run_status, stop it with run_cancel. Every job still running when the bob run ends is cancelled. ` +
  `Limits: A process-group backend cannot promise cleanup of descendants that leave the group. cleanup_state reports what was verified. ` +
  `run does not stop arbitrary same-user code from signalling the supervisor. It removes the builder's reason to do that; it is not a sandbox. ` +
  `It runs as the same user and is not containment: it can read and write anything this user can, so the workspace is not isolated. ` +
  `Cancellation covers only jobs this tool started, by their recorded process group; it never matches processes by name or command line.`;

const STATUS_DESCRIPTION =
  "Report a job this bob run started with run: its state (running or finished), and once finished its outcome, exit_code, signal and cleanup_state, plus a redacted tail excerpt of its output so far. " +
  "With no run_id, list every job this run owns — use it after a context compaction to find jobs you lost track of. " +
  "An unknown run_id is refused by name; a run_id from an earlier bob run cannot be queried.";

const CANCEL_DESCRIPTION =
  "Cancel a job this bob run started with run, by its recorded process group: SIGTERM, then SIGKILL after a short grace, then a check that the group is empty. " +
  "Reports the job's REAL terminal outcome: a job that had already finished is reported as it finished, never as cancelled, and a second cancel is idempotent. " +
  "It cancels only this tool's own jobs; it never matches processes by name or command line, and it is not a way to stop any other process. " +
  "Limits: process-group backend, same user, not a sandbox; a descendant that left the job's group may survive.";

const APPLY_PATCH_DESCRIPTION =
  "Apply the launcher-authorized patch to a fresh, tool-owned index built from the task's pinned base, and store the resulting candidate. " +
  "Takes patch_artifact { path, sha256 } (a patch file under the task's artifact root) and expected_base (the task's pinned base commit object ID). " +
  "The artifact is read once, its sha256 verified, and those verified bytes applied with git apply; the caller's worktree, index, HEAD and refs are never used and are left untouched. " +
  "It never selects paths, drops hunks, repairs whitespace, resolves conflicts or falls back to another base: the whole patch applies to the fresh index or nothing does. " +
  "It refuses, with a stable reason, when the session holds no valid task binding, the base or the digest does not match, the artifact is missing or outside its root, the patch is malformed or does not apply, it changes a symlink or a submodule, or it names an unsafe Git path. " +
  `Returns { candidate_id, base_oid, patch_sha256, tree_oid, changed_paths }. A candidate id is not permission to publish it.`;

function applyPatchSuccessText(r: ApplyPatchSuccess): string {
  return [
    `apply_patch: candidate ${r.candidate_id} stored`,
    `base_oid: ${r.base_oid}`,
    `patch_sha256: ${r.patch_sha256}`,
    `tree_oid: ${r.tree_oid}`,
    `changed_paths: ${r.changed_paths.length === 0 ? "(none)" : r.changed_paths.join(", ")}`,
    "The caller's worktree, index and HEAD are untouched. A candidate id is not permission to publish it.",
  ].join("\n");
}

function applyPatchRefusalText(r: ApplyPatchRefusal): string {
  return `${r.message} (reason: ${r.reason})`;
}

function statusLine(r: JobReport): string {
  switch (r.outcome) {
    case "exited":
      return `exited with code ${r.exit_code}`;
    case "signalled":
      return `ended by signal ${r.signal ?? "(unknown)"} from outside the deadline`;
    case "timed_out":
      return `TIMED OUT at its ${r.effective_timeout_s} s deadline${
        r.escalated ? " (SIGTERM was not enough; escalated to SIGKILL)" : " (ended by SIGTERM)"
      }`;
    case "cancelled":
      return `CANCELLED (${r.cancel_reason ?? "run_cancel"})`;
    case "no_exit_status":
      return "ended with NO exit status (not a success)";
    default:
      return "running";
  }
}

function outputBlock(r: JobReport): string {
  const size = PI_PRIMITIVES.formatSize(r.output_bytes);
  const notes: string[] = [];
  if (r.output_excerpt_truncated) notes.push("excerpt is the tail only");
  if (r.redactions > 0)
    notes.push(`${r.redactions} secret${r.redactions === 1 ? "" : "s"} redacted`);
  if (r.output_dropped_bytes > 0) {
    notes.push(`${PI_PRIMITIVES.formatSize(r.output_dropped_bytes)} not captured`);
  }
  if (r.output_tail_withheld_bytes > 0) {
    notes.push(
      `an unterminated final line (${PI_PRIMITIVES.formatSize(r.output_tail_withheld_bytes)}) withheld until the capture is complete`,
    );
  }
  if (r.output_missing) {
    notes.push(
      "the capture file is GONE (removed by something outside the tool after it was written), so no excerpt can be shown",
    );
  }
  if (r.output_excerpt.length === 0) {
    return `--- no output${r.output_bytes > 0 ? ` shown (${size} captured)` : ""}${notes.length > 0 ? `; ${notes.join("; ")}` : ""} ---`;
  }
  return [
    `--- output (${size} captured${notes.length > 0 ? `; ${notes.join("; ")}` : ""}) ---`,
    r.output_excerpt.replace(/\n+$/, ""),
    "--- end of output ---",
  ].join("\n");
}

function timeoutLabel(r: JobReport): string {
  return `${r.effective_timeout_s} s (${r.timeout_source === "clamped" ? `requested more; capped at the ${MAX_TIMEOUT_S} s maximum` : r.timeout_source})`;
}

export function terminalText(r: JobReport, note?: string): string {
  return [
    `${r.run_id}: ${statusLine(r)} — ${r.success ? "SUCCESS" : "NOT a success"}${note ? ` (${note})` : ""}`,
    `cleanup_state: ${r.cleanup_state} · output_complete: ${r.output_complete} · deadline: ${timeoutLabel(r)} · elapsed: ${r.elapsed_s} s`,
    outputBlock(r),
    `full capture: ${r.output_ref} (owner-only, same-user readable, deleted when this bob run ends)`,
    LIMITS_TEXT,
  ].join("\n");
}

function runningText(r: JobReport): string {
  return [
    `${r.run_id}: running in the background (process group ${r.pgid}) for ${r.elapsed_s} s of its ${timeoutLabel(r)} deadline`,
    outputBlock(r),
    `full capture so far: ${r.output_ref}`,
    `Check again with run_status {"run_id":"${r.run_id}"}; stop it with run_cancel {"run_id":"${r.run_id}"}.`,
  ].join("\n");
}

function listText(reports: JobReport[]): string {
  if (reports.length === 0) return "This bob run has started no jobs.";
  return [
    `This bob run owns ${reports.length} job${reports.length === 1 ? "" : "s"}:`,
    ...reports.map(
      (r) =>
        `  ${r.run_id}: ${r.state === "running" ? `running ${r.elapsed_s} s (deadline ${r.effective_timeout_s} s)` : `${statusLine(r)}; cleanup_state ${r.cleanup_state}`}${r.background ? " [background]" : ""}`,
    ),
    "run_status with a run_id shows one job's output excerpt.",
  ].join("\n");
}

function detailsOf(r: JobReport, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...r, ...extra };
}

export interface WorkSession {
  manager: JobManager;
  // Resolves when the boot sweep (jobs left by a dead bob run) has finished.
  bootSweep: Promise<BootReap[]>;
}

export function wireWork(opts: WireWorkOptions): WorkSession {
  const { pi } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));
  const manager = new JobManager({ ...opts, log });

  // Every result goes through here: a RunRefusal becomes a thrown Error, which
  // pi reports to the model as a tool error carrying the message.
  async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RunRefusal) throw new Error(err.message);
      throw err;
    }
  }

  pi.registerTool({
    name: "run",
    label: "Run",
    description: RUN_DESCRIPTION,
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "The shell command (run as bash -c)." }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory, relative to the workspace or an absolute path inside it. Omit to run in the workspace.",
        }),
      ),
      timeout_s: Type.Optional(
        Type.Number({
          description: `Deadline in seconds (greater than 0). Omit for the ${DEFAULT_TIMEOUT_S} s default; values above ${MAX_TIMEOUT_S} are capped.`,
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "true: start the job and return its run_id at once (check with run_status, stop with run_cancel).",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return guarded(async () => {
        const job = await manager.start(params, ctx?.cwd);
        if (job.background) {
          const r = manager.report(job);
          return {
            content: [
              {
                type: "text",
                text: [
                  `${r.run_id}: started in the background (process group ${r.pgid}); deadline ${timeoutLabel(r)}.`,
                  `Check it with run_status {"run_id":"${r.run_id}"}; stop it with run_cancel {"run_id":"${r.run_id}"}. It is cancelled when this bob run ends.`,
                  LIMITS_TEXT,
                ].join("\n"),
              },
            ],
            details: detailsOf(r),
          };
        }
        // Foreground: an abort of the tool call (the session stopping the turn)
        // cancels the job rather than leaving it running unowned.
        const onAbort = () => void manager.cancel(job.runId, "abort");
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        try {
          await job.done;
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
        const r = manager.report(job);
        return { content: [{ type: "text", text: terminalText(r) }], details: detailsOf(r) };
      });
    },
  });

  pi.registerTool({
    name: "run_status",
    label: "Run Status",
    description: STATUS_DESCRIPTION,
    parameters: Type.Object({
      run_id: Type.Optional(
        Type.String({ description: "A run_id from run. Omit to list every job this run owns." }),
      ),
    }),
    async execute(_id, params) {
      return guarded(async () => {
        if (params.run_id === undefined || params.run_id === null || params.run_id === "") {
          const reports = manager.list().map((j) => manager.report(j, false));
          return {
            content: [{ type: "text", text: listText(reports) }],
            details: { jobs: reports },
          };
        }
        const job = manager.get(params.run_id, "run_status");
        const r = manager.report(job);
        const text = r.state === "running" ? runningText(r) : terminalText(r);
        return { content: [{ type: "text", text }], details: detailsOf(r) };
      });
    },
  });

  pi.registerTool({
    name: "run_cancel",
    label: "Run Cancel",
    description: CANCEL_DESCRIPTION,
    parameters: Type.Object({
      run_id: Type.String({ minLength: 1, description: "The run_id of a job this run started." }),
    }),
    async execute(_id, params) {
      return guarded(async () => {
        const { job, note } = await manager.cancel(params.run_id, "run_cancel");
        const r = manager.report(job);
        const why =
          note === "already_finished"
            ? "it had already finished before the cancel; this is how it ended"
            : note === "already_cancelled"
              ? "already cancelled; this cancel changed nothing"
              : undefined;
        return {
          content: [{ type: "text", text: terminalText(r, why) }],
          details: detailsOf(r, { cancel: note, idempotent: note === "already_cancelled" }),
        };
      });
    },
  });

  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: APPLY_PATCH_DESCRIPTION,
    parameters: Type.Object({
      patch_artifact: Type.Object({
        path: Type.String({
          minLength: 1,
          description:
            "Path to the patch file, relative to the task's artifact root (or absolute inside it).",
        }),
        sha256: Type.String({
          pattern: "^[0-9a-fA-F]{64}$",
          description: "The artifact's expected sha256 digest.",
        }),
      }),
      expected_base: Type.String({
        pattern: "^[0-9a-f]{40}$",
        description: "The full Git commit object ID that must equal the task's pinned base.",
      }),
    }),
    async execute(_id, params) {
      const outcome = applyPatch({
        binding: opts.taskBinding,
        ...(opts.taskBindingError !== undefined ? { bindingError: opts.taskBindingError } : {}),
        params: params as unknown as ApplyPatchParams,
        stateRoot: manager.stateRoot,
        ...(opts.applyPatchDeps !== undefined ? { deps: opts.applyPatchDeps } : {}),
      });
      if (outcome.ok) {
        return {
          content: [{ type: "text", text: applyPatchSuccessText(outcome) }],
          details: { refused: false, ...outcome },
        };
      }
      return {
        content: [{ type: "text", text: applyPatchRefusalText(outcome) }],
        details: {
          refused: true,
          reason: outcome.reason,
          message: outcome.message,
          ...(outcome.detail ?? {}),
        },
      };
    },
  });

  pi.on?.("session_shutdown", async () => {
    await manager.endRun();
  });

  const bootSweep = manager.bootSweep().catch((err) => {
    log(`work: boot sweep failed: ${(err as Error).message}`);
    return [] as BootReap[];
  });
  log("work capability: registered run / run_status / run_cancel / apply_patch");
  return { manager, bootSweep };
}
