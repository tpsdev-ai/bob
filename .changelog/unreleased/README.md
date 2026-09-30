# Changelog fragments

One file per change. Pull requests whose fragments have distinct filenames no
longer share an edit to the `[Unreleased]` section of `CHANGELOG.md`, so adding
a changelog entry stops being a routine merge conflict, and a review round is
no longer spent resolving one (bob#236). Two pull requests that pick the same
filename still conflict, on that file, so make the slug specific.

## Adding an entry

Create `<category>-<slug>.md` in this directory:

```
.changelog/unreleased/fixed-doctor-reply-transport.md
```

- **category** — the text before the first hyphen. One of `added`, `changed`,
  `deprecated`, `removed`, `fixed`, `security` ([Keep a
  Changelog](https://keepachangelog.com/en/1.1.0/)). It determines which
  `### Heading` the entry lands under.
- **slug** — everything after it. Make it descriptive; you own uniqueness. A
  PR number works but is not expected — the branch is usually pushed before the
  PR number exists.

The file contains the entry as it should appear under its heading, including
the leading `- ` and a 2-space indent on every continuation line:

```markdown
- **The thing that changed, in bold.** What it means for someone running bob,
  and what they have to do about it (usually nothing).

  A second paragraph, indented two spaces so it stays inside the list item.
```

**The bold lede is required: non-empty, ≤ 25 words and one sentence.** It is
the entry's summary, the line a reader skims first. The GitHub release carries
the whole `## [<version>]` section (`scripts/changelog-extract.mjs`), so detail
is never cut; it belongs in the body, where it reads as detail. `check` fails
naming the fragment and this rule, and gives the word count when the lede is
too long.

Reading a fragment trims the whitespace at the end of the file; nothing else is
changed. Assembly joins the fragments as read — no reflow, no re-indent, no
rewrapping — so tables and nested code blocks come through unchanged. The flip
side is that a fragment which is not already a well-formed list item is a hard
error rather than something the tooling quietly fixes up: silent normalisation
is how content goes missing.

The reader skips `README.md` and dotfiles (such as `.gitkeep`) without looking
at them. Every other entry in this directory is read as a fragment and must be a
regular file: a symbolic link, a directory or any other kind of entry is
refused.

## Checking your work

```bash
node scripts/changelog-fragments.mjs render   # preview the assembled section
node scripts/changelog-fragments.mjs list     # what is staged, by category
node scripts/changelog-fragments.mjs check    # what CI runs
```

CI runs `check` in its test job, for every pull request that targets `main`
and every push to `main`, once the build job has succeeded. It fails on a
malformed fragment (a bad name; a missing, empty or over-long bold lede; a body
that is not a list item; a continuation line indented by an odd number of spaces
or not at all; a fragment holding more than one entry), on a fragment entry that
is not a regular file, on a missing fragment directory, and on a `CHANGELOG.md`
whose `[Unreleased]` heading is missing, repeated, or anything but the line
`## [Unreleased]` byte for byte (another case, a suffix, trailing spaces or
tabs), or that holds anything but the managed note under it. Every command
refuses an argument it does not take (exit status 2).

## At release time

`node scripts/changelog-fragments.mjs promote <version> [--date=YYYY-MM-DD]`
keeps `## [Unreleased]` with its note, writes every fragment into a new
`## [<version>] - <date>` section below it (in Keep a Changelog category order,
and by filename within each category), then deletes the fragments.
`<version>` is `MAJOR.MINOR.PATCH` with no leading zeros, optionally followed by
a pre-release of dot-separated letters and digits (`1.0.0-rc.1`); build metadata
is not accepted, and neither is a version that already has a section in
`CHANGELOG.md`. `--date` must be a real date written `YYYY-MM-DD`, given at most
once; without it the date is today's (UTC). An invalid version or date is
refused before anything is written. Entry order within a
category carries no meaning; stability does, and filename sort is stable across
machines and filesystems.

If `promote` cannot write `CHANGELOG.md`, it deletes no fragment. If it cannot
delete a fragment after writing the section, it names each one left: those are
already in the new section, so delete them, or restore both
(`git checkout -- CHANGELOG.md .changelog/unreleased`) and run it again.

Do not add anything to `## [Unreleased]` in `CHANGELOG.md` by hand. `promote`
rewrites that section's body to the note, so `check` and `promote` both refuse
while it holds a list entry or any other text.
