# work

Managed command execution for builders running on a local model (bob#211,
slice 1 of bob#210).

With raw `bash`, a local-model builder ran commands with no deadline (pi's bash
has no default timeout) and stopped them with a pattern kill that could match
its own runtime. This capability gives the builder a tool that owns execution:
every command has a deadline, the tool owns and cancels only the process groups
it started, and a command's outcome is never reported as success unless it was.

It registers three tools through `pi.registerTool`:

| tool | takes | does |
| --- | --- | --- |
| `run` | `command`, `cwd?`, `timeout_s?`, `background?` | runs `bash -c command`; waits for the outcome, or with `background: true` returns a `run_id` at once |
| `run_status` | `run_id?` | one job's state, outcome, cleanup and output excerpt; with no `run_id`, every job this run owns |
| `run_cancel` | `run_id` | cancels one of this run's jobs by its recorded process group |

## Enabling it

`roles/builder-local/role.json` allows `run`, `run_status` and `run_cancel`, and
does not allow `bash`: in that role, `run` replaces pi's shell, and that is a
fact of the config (tool availability is a per-role allow-list), not of load
order. An agent opts in the same way as for `anchored-edit`: `work` under
`capabilities:` in `bob.yaml` and the three names in `tools.allow:`.

`run` executes arbitrary commands, so the resident policy treats it as a shell:
it is in `RESIDENT_EXCLUDED_TOOLS` with `bash` and `powershell`, and a resident
agent keeps it only when its role sets `tools.allowResidentShell` (builder-local
does). `run_status` and `run_cancel` execute nothing and are not gated.

## The deadline

- `timeout_s` may be omitted; the deadline may not be absent. An omitted timeout
  gets the default, **600 s**. A value above the hard maximum, **3600 s**, is
  capped, and the result says so (`timeout_source: "clamped"`). A non-positive
  value is refused by name; a non-numeric one is refused by pi's argument
  validation, naming the field.
- **Slice 1 applies this default and maximum only.** Both are fixed in the
  capability (bob has no channel yet from a role to a capability, and no
  `bob.yaml` knob can remove or raise them). The clamp to the run's remaining
  budget arrives with the supervisor-owned deadline (bob#210 slice 4).
- The deadline is the tool's own timer, independent of the child's I/O. At the
  deadline the job's process group gets SIGTERM, then SIGKILL after a grace
  (3 s), then the tool checks the group is empty (up to 2 s more).
- Background jobs get the same deadline.

## Outcomes

Two fields, kept separate: what happened to the **command**, and what the tool
**verified** about its process group afterwards.

`outcome`:

- `exited` — the command ended with an exit code (`exit_code`).
- `timed_out` — the deadline fired. `escalated: true` means SIGTERM was not
  enough and SIGKILL was sent. A deadline always reports `timed_out`, never
  `signalled`.
- `signalled` — the command was ended by a signal from outside the deadline
  (`signal`).
- `cancelled` — `run_cancel`, the end of the run, or an abort of the tool call
  ended it (`cancel_reason`).
- `no_exit_status` — no exit status was observed. Never success.

`cleanup_state`:

- `group_empty` — no process remained in the job's process group; the tool
  signalled nothing.
- `group_killed` — the tool signalled the group and then verified it empty.
- `escaped_or_unverified` — something may survive: members remained after
  SIGKILL, a member exists the tool may not signal, the job's output pipe was
  still held open after the group was gone (so a process outside the group has
  it), or the group exists but could not be matched to the job (boot sweep).
- `verify_unavailable` — the tool could not check at all.

**Success is only `outcome: exited`, `exit_code: 0`, and `cleanup_state`
`group_empty` or `group_killed`.** A clean state is unreachable when survivors
could not be checked. Anything a foreground command leaves running inside its
own group when it exits is still that job's: the tool ends it and reports
`group_killed`.

`run_cancel` returns the same fields. A cancel that reaches a job whose exit the
tool had already observed reports the job's real terminal outcome
(`cancel: "already_finished"`), never `cancelled`; a second cancel is idempotent
(`cancel: "already_cancelled"`, `idempotent: true`). An unknown `run_id` is a
named error.

## Output

- stdout and stderr are captured, in arrival order, to `output_ref`: a file
  (mode 0600) in the run's own directory under an owner-only state directory,
  `<temp dir>/bob-work-<uid>/` — outside the git worktree, so it can never be a
  committable stray file, and never a shared path. `run` refuses to start when
  that state directory is inside the workspace, is a symlink, belongs to another
  user, or is readable by group or others.
- The run's directory is created by `mkdtemp` under the verified state
  directory: a fresh, unpredictable name (`run-XXXXXX`), mode 0700, never an
  existing entry. Each capture file is created inside it exclusively
  (`O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600): anything already at the path — a
  file, or a live or dangling symlink — refuses the call by name, nothing is
  started, and nothing is written through it.
- **It is same-user readable.** The permissions keep it off the candidate tree
  and out of shared paths; they are not a confidentiality boundary against code
  running as the same user.
- The model sees a bounded tail excerpt (16 KiB, 400 lines). Before the cut, the
  window is passed through bob's existing secret redaction (the observatory's
  `redactSecrets`: provider token shapes, bearer headers, `key=`/`token=` and
  `*_TOKEN=`/`*_PASSWORD=`-style assignments, URL userinfo, PEM blocks, long
  opaque runs), with a margin before the excerpt so a secret that straddles the
  cut is redacted whole. `redactions` counts what was replaced. The full capture
  stays local: it is never in the model transcript or a tool result, and the run
  log records only the redacted excerpt.
- `output_complete: false` says the capture itself was cut short: draining was
  stopped (see below), the capture reached its 64 MiB cap
  (`output_dropped_bytes` counts the rest), or a write failed.
- Draining is bounded, never by EOF: once the job's group is gone the tool waits
  at most 500 ms for the pipes to close, then stops. A pipe still open then is
  held by a descendant that left the group; the result says
  `output_complete: false` and `cleanup_state: escaped_or_unverified`, and the
  tool does not hang.
- **Retention.** Captures are deleted when the run ends (or, after a crash, by
  the next session's boot sweep). The small job records (no output, a SHA-256 of
  the command rather than the command) are kept 24 hours after their run ended,
  then deleted by a later boot sweep.

## Job state and the sweeps

- Every job is recorded on disk, keyed by its process group, in the run's own
  state directory: `<state dir>/run-XXXXXX/jobs/pg-<pgid>.<run_id>.json`
  (supervisor pid, deadline, the group leader's start time, command digest,
  outcome, cleanup).
- **Run end.** When pi ends the session (`session_shutdown`), every job the run
  still owns is cancelled (SIGTERM, grace, SIGKILL, verify) and each one's
  cleanup is logged. When the process exits without that event (`bob run`
  disposes its session and exits), an exit hook SIGKILLs every group the run
  still owns, records it and logs it.
- **Boot sweep.** When the capability loads, it looks for runs whose supervisor
  process is gone. For each job still recorded as running, it cancels the group
  only when the group's leader still has the start time recorded for it; a
  group it cannot match is not signalled and is reported
  `escaped_or_unverified`. Every such job is recorded and logged
  (`work: boot sweep: …`).
- **Not a run-level wall clock.** `run` bounds each command; it does not bound
  the run, and this slice changes nothing that does. The tps-mail consumer
  bounds a mail turn with its turn timeout; `bob run` itself has no run-level
  wall clock, so whatever starts an unattended builder must still bound it,
  until the supervisor-owned run deadline lands (bob#210 slice 4).

## Limits (read this before trusting it as a sandbox)

- **A process-group backend cannot promise cleanup of descendants that leave the
  group.** `cleanup_state` reports what was verified.
- **`run` does not stop arbitrary same-user code from signalling the
  supervisor.** It removes the builder's reason to do that; it is not a sandbox.
  The builder-local soul keeps the prohibition the tool cannot own: never signal
  or kill a process outside `run`'s own jobs.
- **It runs as the same user and is not containment.** A command can read and
  write anything that user can, so the candidate tree is not isolated; what
  bounds the export is `publish`'s scope check (bob#210 slice 2).
- **Cancellation covers only jobs this tool started**, by their recorded process
  group. It never matches processes by name or command line.
- **A cancel can race the job's own exit.** A job whose exit the tool had
  already observed is reported as it ended. In the remaining window — the job
  exits on its own after the tool last looked and before the signal lands — the
  tool reports `cancelled`: never a success, so the error is in the safe
  direction.
- **The boot sweep is conservative.** A dead supervisor whose pid was reused
  reads as alive and its jobs are left alone; a group whose leader is gone or
  does not match is reported, not signalled.
- **POSIX only.** On Windows `run` refuses with a named error.

## Reuse

`run` takes pi's `getShellConfig` (which shell and argv), `truncateTail` and
`formatSize` by import from `@earendil-works/pi-coding-agent`, and starts
commands detached with stdin closed, as pi's bash tool does on Unix (the
environment is bob's own: pi's bash also prepends pi's tool bin directory to
`PATH`, through a helper it does not export). pi 0.84.3 does not
export its process-tree kill or its child wait from the package root, and its
`exports` map forbids a deep import; the group signal and probe are bob's own
`src/shell/process-group.ts`, shared with the tps-mail consumer. pi's wait is
also the wrong policy here: it keeps reading while a detached descendant writes
to the inherited pipe.
