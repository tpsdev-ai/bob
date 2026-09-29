# anchored-edit

Byte-exact, anchor-keyed line edits for builders running on a local model
(bob#185, slice 1).

A local model that edits code by retyping whole files drifts: it loses the final
newline, flips CRLF to LF, drops a BOM, and changes lines it never meant to
touch. This capability replaces whole-file rewriting with addressable line
edits. It registers four tools through `pi.registerTool`, **beside** pi's own
`read`/`edit`/`write` (which are untouched):

| tool | takes | does |
| --- | --- | --- |
| `read_lines` | `path`, `start?`, `end?` | returns a fingerprint header + one `L<n>#<h> <content>` per line |
| `edit_lines` | `path`, `from`, `to`, `new_text`, `fingerprint` | replaces the range from the `from` anchor to the `to` anchor, inclusive (empty `new_text` deletes) |
| `insert_after` | `path`, `anchor`, `text`, `fingerprint` | inserts after a line anchor, or `L0` for before line 1 |
| `write_file` | `path`, `content` | creates a NEW file exclusively; no fingerprint |

## Enabling it

Opting an agent in is **three things together**, and a freshly initialized agent
stamps only Flair — so all three must be set for the tools to load:

1. `agent.role: builder-local` in `bob.yaml` (the role that holds these four
   tools and no `read`/`edit`/`write`);
2. `anchored-edit` under `capabilities:` in `bob.yaml`; and
3. the four tool names (`read_lines`, `edit_lines`, `insert_after`, `write_file`)
   in the `tools.allow:` list.

The role is the ceiling: `bob.yaml` may narrow the allowlist but cannot widen it
past what `roles/builder-local/role.json` allows, and a name the role does not
hold is a load error, not a silent drop.

## The model

- **Anchor token** `L<n>#<h>` — line number `n` and `h`, the 8 lowercase hex of
  FNV-1a 32 over the line's UTF-8 bytes with its terminator and a trailing CR
  stripped. Fixed, unseeded. The line number is **not** folded into the hash:
  position already travels in the token, so `L120#…` and `L340#…` are distinct
  addresses even when their content is identical.
- **Fingerprint** `F#<16 hex>` — the first 16 hex of SHA-256 over the raw file
  bytes (BOM included). Every mutation of an existing file must carry the
  current fingerprint; a change since the model's last read or edit refuses the
  call.
- **Reads** return the fingerprint, the line count, the dominant line ending and
  whether a BOM is present. Pages show at most 200 lines and 16 KiB, and the
  header says when a page was cut. A line over 2000 characters is shown
  truncated with a marker; its hash still covers the full line.
- **Edits** splice raw byte spans: every byte outside the affected span is
  unchanged. The BOM is stored separately and preserved. When a call touches
  EOF, the old file's final-newline state is kept; when it removes the final
  line or inserts after an unterminated final line, the adjacent separator
  belongs to the affected span. New separators use the dominant style (LF on a
  tie). Input text is split into logical lines on LF or CRLF, one terminal empty
  segment from a trailing separator is discarded (`"\n"` is one blank line), and
  a lone CR is refused. A blank line that would become the file's unterminated
  final line cannot be represented and is refused rather than silently dropped.

## Paths and the workspace root

- The **root is pi's tool execution context `cwd`**. Neither a tool argument nor
  `bob.yaml` can name it. The canonical root pathname is pinned ONCE per session; a
  root replaced by a path that resolves elsewhere is refused, but a root replaced
  by another directory at the same pathname is not detected (see the documented
  gaps).
- Absolute paths and any `..` segment are refused before the filesystem is
  touched.
- A target is resolved to its canonical (realpath) form inside the pinned root,
  and the path is **resolved and checked inside the pinned root before each
  operation**: an internal symlink is allowed (its directory entry is preserved)
  and a symlink leading outside the root is refused, and the parent directory is
  re-checked before path-based opens and the rename. Those are resolution-time checks that
  run *before* the operation, not atomically with it — a directory (or the root)
  swapped by another process between the check and the I/O is **not** guarded
  (see the documented gaps).
- Writes go through a temporary file created *exclusively* (no symlink follow) in
  the target's directory and then renamed over the target, and a write is
  completed until the writer accepts every byte — an incomplete write is cleaned
  up and refused, never reported as a success.
- Creation is exclusive and does not follow symlinks: any existing directory
  entry, including a dangling symlink, counts as occupied, and a refused
  creation leaves nothing behind, even when the write was incomplete.
- Every refusal names the caller's path and the rule (binary file, out-of-range
  read, lone CR, overlong line included).

## The rewrite tripwire

The tripwire counts original raw bytes removed or replaced by `edit_lines`, per
file per run. The limit is **half the file's size when first touched, with no
floor**, so it is below the file's size for every nonempty file and no full
replacement fits under it. A call that would exceed it is refused, and every
further mutation of that file in that run is refused too, naming the file and the
limit and telling the model to report BLOCKED. Because the count is cumulative,
splitting a rewrite into many small edits does not get under it. **Pure
insertions are not counted** — an insertion destroys no existing content, and
counting it would refuse the common case of appending tests to a file. The cost
is that some legitimate edits to small files are refused.

## Signals

`edit_without_read`, `stale_anchor` and `budget_stop` ride the structured tool
result (`details.signals`). They are signals, not gates — they never disable a
guard.

## Documented gaps (read this before trusting it as a sandbox)

- **The critical section is per-path and in-process only.** Each call checks the
  fingerprint and its anchors, then writes, under a per-path lock. A
  **cross-process** change after that check is an explicitly unguarded race.
- **Containment is checked at resolution time, not bound to the I/O.** Paths are
  resolved and checked inside the pinned root before each operation; a directory
  (or the root) swapped by another process between that check and the I/O is not
  guarded — the same class as the cross-process race above (and the shell —
  builder-local's `run`, or `bash` in other roles — stays outside every guard in
  slice 1).
- **The checks compare canonical pathnames.** A directory (or the root) replaced
  by another directory at the SAME pathname passes the check, even before it runs;
  only a replacement that resolves elsewhere (for example a symlink leading outside
  the root) is refused.
- **The shell is outside every guard.** builder-local's shell is the work
  capability's `run` (bob#211), which replaced `bash` there. The tripwire and
  the anchored rules govern `read_lines`/`edit_lines`/`insert_after`/`write_file`
  only. A shell command can still rewrite a tracked file (including a write
  followed by a commit in one command). This is slice 2.
- **No role-owned overrides.** Slice 1 ships the fixed page, line and tripwire
  limits; no path from `bob.yaml` can raise them. Role-owned limit overrides and
  a role-owned replace permission are slice 2.
- **The tripwire guards byte removal, not semantics.** It refuses corrupting
  rewrites; it does not stop a semantic override such as an appended
  reassignment.
- **A stale call never retargets.** It returns a bounded re-read window around the
  requested position, the expected token, the observed token (or "line absent"),
  and a nearby equal hash labelled a candidate only when it is unique. The model
  must re-read and retarget itself.
