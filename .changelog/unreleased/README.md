# Changelog fragments

One file per change. Pull requests whose fragments have distinct filenames no
longer share an edit to the `[Unreleased]` section of `CHANGELOG.md`, so adding
a changelog entry stops being a routine merge conflict, and a review round is
no longer spent resolving one (bob#236). Two pull requests that add the same
filename with different contents can conflict on that file, so make the slug
specific.

## Adding an entry

Create `<category>-<slug>.md` in this directory:

```
.changelog/unreleased/fixed-doctor-reply-transport.md
```

- **category** — the text before the first hyphen, in lowercase. One of
  `added`, `changed`, `deprecated`, `removed`, `fixed`, `security` ([Keep a
  Changelog](https://keepachangelog.com/en/1.1.0/)). It determines which
  `### Heading` the entry lands under.
- **slug** — everything after it. Make it descriptive; you own uniqueness. A
  PR number works but is not expected — the branch is usually pushed before the
  PR number exists.

The file contains the entry as it should appear under its heading, including
the leading `- `. Every continuation line is indented with spaces only, an even
number of them, and every nonblank one by at least 2:

```markdown
- **The thing that changed, in bold.** What it means for someone running bob,
  and what they have to do about it (usually nothing).

  A second paragraph, indented two spaces so it stays inside the list item.
```

**The bold lede is required: non-empty, ≤ 25 words, with no sentence break.** A
sentence break is a `.`, `!` or `?` followed by whitespace inside the lede:
any character JavaScript's `\s` matches, including a space, a tab, a line
break and the non-breaking space. `check` counts nothing else as one, so
`First.Second.` passes. The lede is
the entry's summary, the line a reader skims first. The release workflow passes
the whole `## [<version>]` section to the GitHub release, as
`scripts/changelog-extract.mjs` extracts it (trimming only the whitespace around
it), so detail is not shortened; it belongs in the body, where it reads as detail. `check` fails
naming the fragment and this rule, and gives the word count when the lede is
too long.

Reading a fragment decodes it as UTF-8 and refuses it, by name, if its bytes are
not valid UTF-8, instead of reading them with replacement characters; `check`
and `promote` read `CHANGELOG.md` the same way. Reading then trims the
whitespace at the end of the file and changes nothing else. Assembly joins the fragments as read — no reflow, no re-indent, no
rewrapping — so tables and nested code blocks come through unchanged. The flip
side is that a fragment that breaks a rule `check` enforces (listed below) is a
hard error rather than something the tooling quietly fixes up: silent normalisation
is how content goes missing.

The reader skips `README.md` and dotfiles (such as `.gitkeep`) without looking
at them. Every other entry in this directory is read as a fragment and must be a
regular file: a symbolic link, a directory or any other kind of entry is
refused.

## Checking your work

```bash
node scripts/changelog-fragments.mjs render   # preview the assembled section
node scripts/changelog-fragments.mjs list     # available fragments, by category
node scripts/changelog-fragments.mjs check    # what CI runs
```

CI runs `check` in its test job, for every pull request that targets `main`
and every push to `main`, once the build job has succeeded. It fails on a
malformed fragment (a bad name; a missing, empty or over-long bold lede; a body
that is not a list item; a continuation line indented by an odd number of spaces
or not at all; a fragment holding more than one entry), on a fragment entry that
is not a regular file, on a missing fragment directory, and on a `CHANGELOG.md`
whose `[Unreleased]` heading is missing, repeated, or anything but the line
`## [Unreleased]` byte for byte, or that holds anything but the managed note
under it. Here a line counts as an `[Unreleased]` heading when, after at most
three leading spaces, it starts with `##`, optional spaces or tabs, `[`,
optional spaces or tabs, and `unreleased` in any letter case, whatever follows.
Every command refuses an argument it does not take (exit status 2).

## At release time

`node scripts/changelog-fragments.mjs promote <version> [--date=YYYY-MM-DD]`
keeps `## [Unreleased]` with its note, writes every fragment into a new
`## [<version>] - <date>` section below it (in Keep a Changelog category order,
and by filename within each category), then deletes the fragments.
`<version>` is `MAJOR.MINOR.PATCH` with no leading zeros, optionally followed by
a pre-release of dot-separated identifiers of letters and digits, a numeric one
with no leading zero (`1.0.0-rc.1`); build metadata
is not accepted, and neither is a version that already has a section in
`CHANGELOG.md`. `--date` must be a real date written `YYYY-MM-DD`, given at most
once; without it the date is today's (UTC). An invalid version or date is
refused before anything is written. Entry order within a
category carries no meaning; stability does, and filename sort is stable across
machines and filesystems.

`promote` runs only in a git work tree. Before it writes anything, it refuses
while `CHANGELOG.md` is not a regular file or has more than one hard link, or
while it or any fragment is untracked (not in the index) or differs from the
index byte for byte (so a file that `core.autocrlf` or a clean filter changes on
its way into git counts as differing), naming each, so that `git checkout -- CHANGELOG.md .changelog/unreleased`
restores everything it changed. To close the window between that check and the
fragments' deletion, `promote` then moves each fragment it will fold into a
private staging directory (`.changelog/promote-staging`, on the same filesystem)
with a rename, folds the section from the moved bytes once they hash to the index
blob, and deletes them only after the section is written. A fragment that changed
before the move is moved back and refused, folding nothing; a fragment that
changes after the move leaves a new file at its path, which `promote` does not
touch and reports as `changed during promote, kept: <path>`. Any failure before
the section is written moves every staged fragment back. If a run leaves the
staging directory behind, the next `promote` refuses, naming it. If `promote` cannot write `CHANGELOG.md`, it deletes no fragment. If it cannot
remove a staged fragment after writing the section, it names each one left: those
are already in the new section, so remove `.changelog/promote-staging`, or restore
both (`git checkout -- CHANGELOG.md .changelog/unreleased`) and run it again.

Do not add anything to `## [Unreleased]` in `CHANGELOG.md` by hand. `promote`
rewrites that section's body to the note, so `check` and `promote` both refuse
while it holds a list entry or any other text.
