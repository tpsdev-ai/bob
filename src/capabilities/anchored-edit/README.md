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
| `edit_lines` | `path`, `from`, `to`, `new_text`, `fingerprint` | replaces lines `from..to` inclusive (empty `new_text` deletes) |
| `insert_after` | `path`, `anchor`, `text`, `fingerprint` | inserts after a line anchor, or `L0` for before line 1 |
| `write_file` | `path`, `content` | creates a NEW file exclusively; no fingerprint |

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
  a lone CR is refused.

## Paths and the workspace root

- The **root is pi's tool execution context `cwd`**. Neither a tool argument nor
  `bob.yaml` can name it.
- Absolute paths and any `..` segment are refused before the filesystem is
  touched.
- For an existing file the target is resolved within the root and the **canonical
  (realpath) target** is used for the critical-section key and for I/O, so an
  internal symlink is allowed (its directory entry is preserved) and a symlink
  leading outside is refused. Containment is checked on the path used for I/O.
- Creation is exclusive and does not follow symlinks: any existing directory
  entry, including a dangling symlink, counts as occupied.
- Every refusal names the path and the rule.

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
- **`bash` is outside every guard.** The tripwire and the anchored rules govern
  `read_lines`/`edit_lines`/`insert_after`/`write_file` only. A shell command can
  still rewrite a tracked file (including a write followed by a commit in one
  command). This is slice 2.
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
