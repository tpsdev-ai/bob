# work

Managed command execution for builders running on a local model (bob#211,
slice 1 of bob#210).

With raw `bash`, a local-model builder ran commands with no deadline (pi's bash
has no default timeout) and stopped them with a pattern kill that could match
its own runtime. This capability gives the builder a tool that owns execution:
every command has a deadline, the tool owns and cancels only the process groups
it started, and a command's outcome is never reported as success unless it was.

It registers four tools through `pi.registerTool`:

| tool | takes | does |
| --- | --- | --- |
| `run` | `command`, `cwd?`, `timeout_s?`, `background?` | runs `bash -c command`; waits for the outcome, or with `background: true` returns a `run_id` at once |
| `run_status` | `run_id?` | one job's state, outcome, cleanup and output excerpt; with no `run_id`, every job this run owns |
| `run_cancel` | `run_id` | cancels one of this run's jobs by its recorded process group |
| `apply_patch` | `patch_artifact: { path, sha256 }`, `expected_base` | applies a patch artifact under the task's artifact root to a fresh tool-owned index built from the task's pinned base and attempts candidate storage (see below) |

`cwd` is relative to the workspace, or an absolute path inside it; omitted, the
command starts in the workspace. It must be an existing directory, and after
symlinks are resolved it must be inside the workspace when it is checked;
otherwise `run` refuses the call, naming the path it resolved, and starts
nothing. A path that cannot be resolved is refused too: whether it is inside is
then unknown. This confines where a command starts (up to the windows described
next), not what it can reach: the command itself can still change directory.

**Where a command starts, and the windows that remain (bob#224).** Checking
`cwd` and starting the command are separate steps, and Node names a child's
working directory by a string that the child resolves again when it changes into
it. So `run` cannot make the directory a command starts in *be* the one it
checked. It narrows the window in which the two can differ:

1. It resolves `cwd` and the workspace through symlinks, records the workspace
   root's device and inode, and confines the one to the other, keeping that
   canonical workspace.
2. It opens the resolved path (no-follow on the final component) and holds
   it open: the pin. While the pin is held, the directory's inode stays
   allocated (on a local POSIX file system), so no other directory can take its
   device + inode.
3. As the pin is taken, and again immediately before the spawn, it re-resolves
   `cwd`. The result must still be the same canonical path, inside the canonical
   workspace it kept, a no-follow stat of it must still be a directory with the
   pin's device + inode, and the workspace root must still match the device and
   inode recorded in step 1. If, at either re-check, a path component — the
   final one or an intermediate one — has been replaced or moved so that this no
   longer holds, `run` refuses and starts nothing. It also refuses when any step
   cannot establish its fact (a realpath, stat, open, fstat or close that fails);
   a realpath that fails (when `cwd` is first resolved, or at a re-check) and a
   re-check's no-follow stat that fails are reported as a failure to resolve or
   check the directory, without a cause assigned to it.
4. It then releases the pin (closes its descriptor), and only then spawns. A
   release that fails refuses, so no pin step can fail after a command has
   started.

When a close of the pin's descriptor fails — on the release, or on the cleanup
after another failed step — `run` still refuses and starts nothing, and its
refusal says that whether the descriptor is still open is unknown: a failed
close may or may not have released it. When the final re-check failed as well,
the refusal reports both failures. The refusal says the descriptor was closed
only when the close returned.

The re-check NARROWS the race; it does not close it. Among the windows that
remain, one is before the pin: the pin is taken after `cwd` is resolved (step 1
comes before step 2; see Limits). Another runs from the last re-check until the
child has changed directory, because the child's `chdir` re-resolves the path
by name. A component replaced in that window can change where the command
starts or prevent startup; the re-check cannot detect a later replacement.
Closing that window needs a directory-descriptor boundary (`fchdir`, or
resolution beneath an open directory) that Node does not offer a child; a
helper that changes into the pinned directory before running the command would
be OS-specific, so bob does not ship one. See Limits.

The pin opens the directory for reading: Node has no search-only open. A
directory with search but not read permission is therefore refused, although a
command could start in it. That is the safe direction; make it readable
(`chmod u+r`) or pass another directory.

## apply_patch and the task binding (bob#275, S2a)

`apply_patch` builds a candidate tree from a patch artifact under the task's
artifact root; `publish` (below) turns a stored candidate into a remote commit.

**The task binding.** A task binding is the launcher's authority over a builder
session: the task and publication identities, the repository and workspace, the
pinned base commit, the mode (`build` or `apply`), the artifact root, the
declared paths, the required check commands and the authorized publication
destination. It is supplied by the LAUNCHER, carried by the ONE session factory
(`session.ts`) into this capability through the environment variable
`BOB_TASK_BINDING`, and kept here, independent of model messages. A missing
binding refuses the dependent operation with the reason `unknown_task`; a
malformed one refuses with `invalid_binding`. No tool argument, repository file
or agent-writable `bob.yaml` can supply it: the resolver never reads a task
binding from configuration.

**What it does.** It takes `patch_artifact: { path, sha256 }` (a patch file under
the task's artifact root) and `expected_base` (the task's pinned base commit
object ID). It reads the artifact once, verifies its digest, and applies those
**verified bytes** — never a reopened pathname — to a fresh, tool-owned
`GIT_INDEX_FILE` initialized from the pinned base (`git read-tree`), then writes
the resulting tree. In `apply` mode the artifact must
also match the task-authorized digest.

It supports ordinary file additions, modifications, deletions, renames,
executable-bit changes and Git binary patches, and preserves line endings. It
refuses a symlink or a submodule change explicitly (`unsupported_entry_type`),
and never selects paths, drops hunks, repairs whitespace, resolves conflicts or
falls back to another base: the whole patch applies to the fresh index or
nothing does (`patch_does_not_apply`).

**Refusals.** A structured refusal carries a stable reason: `unknown_task`,
`invalid_binding`, `invalid_base`, `base_mismatch`, `artifact_missing`,
`unsafe_artifact_path`, `digest_mismatch`, `tree_mismatch`, `malformed_patch`,
`patch_does_not_apply`, `unsafe_git_path`, `unsupported_entry_type`,
`apply_failed`, `storage_failed`. A refusal returns no candidate.

**Success** returns `{ candidate_id, base_oid, patch_sha256, tree_oid,
changed_paths }`. Storage targets `<state dir>/candidates/<candidate_id>.json`.
The tool refuses detected changes to the staging directory, source or destination.
A concurrent same-user writer can still race rename until builder confinement
(bob#189); pathname checks cannot close that race.
**A candidate id is not permission to publish it.**

`apply_patch` builds a candidate; it writes no file the model names and runs no
command the model writes, so its `TOOL_EFFECTS` row is `writer` and a resident
agent drops it unless its role permits resident writers.

## publish and publication recovery (bob#275, S2b)

`publish` takes `candidate_id` and `commit_message`; `pr` refuses with
`pr_unsupported` because PR creation is a later slice.

Candidates are read from `<state dir>/candidates/` after ID and directory checks.
The record must match its content-derived ID and the task binding.
Publication checks literal paths against scope and checks the expected tree, materializes the candidate,
and runs the required commands through the executor with an environment allowlist.
A nonzero exit, timeout, cancellation, missing exit status, uncertain cleanup,
incomplete capture, failed index refresh or changed tracked source refuses publication.

The journal pins the binding, resolved endpoint and commit before pushing.
Recovery reuses passing checks only for the same authority and candidate.
A missing executor refuses when checks still need to run.
Unexpected inspection output or uncertain ancestry returns indeterminate.
The resolved endpoint is used for both remote inspection and push; URL rewrites refuse.
Pushes require a fast-forward and an atomic expected-ref match; creating an absent
ref requires `destination.create: true`.

Journal writes sync the file, rename it, then sync the directory and state root;
write failures after a push attempt return indeterminate with the known push state.
In-process retries queue; another process holding the publication lock causes
`publication_locked`. A crash can leave a lock requiring operator removal after
confirming the publisher has stopped.
A concurrent same-user writer can still race pathname operations (bob#189).

The result includes `status` (`published`, `refused` or `indeterminate`),
`commit_oid`, `phase`, `push_state` and a refusal `reason` when applicable.

## Enabling it

The `work` capability is what enables `run`. `roles/builder-local/role.json`
allows `run`, `run_status`, `run_cancel`, `apply_patch` and `publish`, and does
not allow `bash`: in that role, `run` replaces pi's shell, and that is a fact of
the config (tool availability is a per-role allow-list), not of load order. An
agent opts in the same way as for `anchored-edit`: `work` under `capabilities:`
in `bob.yaml` and the names in `tools.allow:`.

`run` executes arbitrary commands, so the resident policy treats it as a shell:
its `TOOL_EFFECTS` row is `writer`, so it is in `RESIDENT_EXCLUDED_TOOLS` with
`bash` and `powershell`, and a resident agent keeps it only when its role sets
`tools.allowResidentShell` (builder-local does). `run_status` and `run_cancel`
execute nothing and are not gated.

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

- stdout and stderr are captured, in arrival order and up to a 64 MiB cap, to
  `output_ref`: a file
  (mode 0600) in a private `bob-run-XXXXXX` directory created with `mkdtemp`
  under the OS temp directory. `run` refuses scratch inside the workspace or
  repository. Captures are created exclusively (`O_CREAT|O_EXCL|O_NOFOLLOW`).
- **It is same-user readable.**
- The model sees a bounded tail excerpt (16 KiB, 400 lines). Before the cut, the
  window is passed through bob's existing secret redaction (the observatory's
  `redactSecrets`: provider token shapes, `Authorization` / `Proxy-Authorization`
  header values of any scheme and length — the whole value through the end of
  its line, quoted Digest parameters included, the header name kept —
  `key=`/`token=` and `*_TOKEN=`/`*_PASSWORD=`-style
  assignments, URL userinfo, PEM blocks, long opaque runs), with a margin before
  the excerpt so a secret that straddles the cut is redacted whole. `redactions`
  counts what was replaced. The full capture stays local: it is never in the
  model transcript or a tool result, and the run log records only the redacted
  excerpt.
- **An unterminated final line is withheld until the capture is complete.**
  While a job runs, or when its capture hit the cap, its drain was stopped or a
  write failed, the capture can end in the middle of a line — and a token cut
  there is a fragment no redaction rule recognizes. So the excerpt ends at the
  last complete line, before redaction, and `output_tail_withheld_bytes` says
  how much was held back. A finished, complete capture shows its final line.
- `output_complete: false` says the capture itself was cut short — draining was
  stopped (see below), the capture reached its 64 MiB cap
  (`output_dropped_bytes` counts the rest), or a write failed — or that the
  capture file has gone missing since it was written (`output_missing: true`,
  named in the result rather than shown as an empty excerpt).
- Draining is bounded, never by EOF: once the job's group is gone the tool waits
  at most 500 ms for the pipes to close, then stops. A pipe still open then is
  held by a descendant that left the group; the result says
  `output_complete: false` and `cleanup_state: escaped_or_unverified`, and the
  tool does not hang.
- **Retention.** Run end attempts to remove captures; boot sweep removes leftovers
  only after the checks below pass. The small job records
  (no output, a SHA-256 of
  the command rather than the command) are kept 24 hours after their run ended,
  then deleted by a later boot sweep.

## Job state and the sweeps

Persistent work state uses `$XDG_STATE_HOME/bob` on Linux when `XDG_STATE_HOME`
is absolute (otherwise `~/.local/state/bob`) and `~/Library/Application Support/bob` on macOS.
`BOB_STATE_DIR` overrides these defaults and must be absolute. The root is
created with mode 0700; symlinks, other owners, group/world permissions, and
locations inside the workspace or repository are refused. The old
`<temp dir>/bob-work-<uid>` root is not selected automatically, and nothing is migrated from it.

- Every job is recorded on disk, keyed by its process group, in the run's own
  state directory: `<state dir>/run-XXXXXX/jobs/pg-<pgid>.<run_id>.json`
  (supervisor pid, deadline, the group leader's pinned identity, command digest,
  outcome, cleanup). The first record is written right after spawn — the
  command is already running by then — and before the job's deadline is armed.
  If that first write fails, termination is attempted with the deadline's
  escalation: SIGTERM to the process group only if a first membership probe
  finds members the tool may signal (an empty, unsignallable or unanswerable
  probe sends nothing), then SIGKILL is attempted if no probe reports the
  group empty during the grace. `run` returns a refusal naming the job's process group and saying
  whether that group was verified empty.
- **Identity.** A pid can be reused, even within one second, so a pid (or a
  1-second `ps` start time) is not an identity. On Linux the tool pins a process
  as the boot id plus the start time in clock ticks, the process group and the
  session, all read from `/proc/<pid>/stat`. Elsewhere (macOS included) there is
  no sub-second start time, and nothing is pinned.
- The run record (`run.json`) carries the supervisor's pid, a random instance id
  for its process, its pinned identity where there is one, and a heartbeat (the
  record's modification time, refreshed every minute while the run lives).
- **Run end.** When pi ends the session (`session_shutdown`), every job the run
  still owns is cancelled (SIGTERM, grace, SIGKILL, verify) and each one's
  cleanup is logged. When the process exits without that event (`bob run`
  disposes its session and exits), an exit hook SIGKILLs every group the run
  still owns, records it and logs it.
- **Boot sweep.** When the capability loads, it looks at every earlier run:
  - An **ended** run's records are deleted after 24 hours, regardless of its
    supervisor's pid.
  - The sweep attempts to mark a run ended when its supervisor is **gone** —
    its pid is dead; or the pid is this
    process but the instance id is another's; or the pid is live but no longer
    has the pinned identity; or its identity cannot be compared (none on
    record, or the read could not tell) and the heartbeat is more than 10
    minutes stale — and reports each job still recorded as running.
    An identity read that fails for any
    reason other than "no such process" means "cannot tell", never "replaced".
  - For ended or gone-supervisor runs, captures are deleted only from a
    non-symlink, same-owner directory with no group/world permissions, named
    `bob-run-XXXXXX`, whose device/inode match the run record and whose parent
    matches the recorded temporary root (the current OS temp root for older
    records without one).
  - Such a job's group is signalled **only while its leader has the identity
    pinned at spawn**, checked again immediately before every signal: SIGTERM,
    then SIGKILL after the grace. If the identity was never pinned (no
    sub-second start time on this platform), does not match (a reused pid, even
    in the same second), or is lost before a signal, that signal is not sent and
    the job is reported `escaped_or_unverified`. Every such job is recorded and
    logged (`work: boot sweep: …`).
- **No run-level wall clock in S1.** `run` bounds each command, not the run:
  there is no in-bob run wall clock in this slice. An unattended launch must be
  bounded by its launcher. An in-bob `--max-runtime` supervisor lands with S4
  (bob#210).

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
- **The boot sweep signals only what it can pin.** Where the platform gives no
  sub-second start time (macOS included), it signals nothing: orphans of a
  crashed run are reported `escaped_or_unverified`, and ending them is left to
  the operator. A group whose leader is gone (its descendants still running) is
  reported, not signalled. Between the last identity check and the signal there
  is one system call: POSIX has no handle for a process group, so that window
  cannot be closed from here. A live supervisor with no pinned identity whose
  event loop stalls for more than 10 minutes reads as dead to another bob's
  sweep, which then deletes that run's captures.
- **The pin is taken after `cwd` is resolved.** `resolveCwd` records the workspace
  root's device and inode, and each re-check compares them. This detects a
  replacement while the original inode remains allocated. No descriptor holds
  the root inode allocated, so inode reuse before a re-check can make a
  replacement indistinguishable. A component below the root (`cwd` itself, or
  an intermediate one) replaced by
  another directory that keeps the same canonical path inside the workspace still
  becomes the pinned directory, and the re-checks, which compare against the pin,
  do not detect it. Containment still holds: the re-check as the pin is taken
  still requires that path to resolve inside the workspace.
- **The `cwd` re-check narrows the race between the check and the start; it
  does not close it.** A path component replaced after the last re-check and
  before the child has changed directory is not detected (see "Where a command
  starts" above). It matters where another process can rename entries in the
  workspace while `run` starts a command.
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
