#!/usr/bin/env node
// Changelog fragment files (bob#236), ported from flair's
// scripts/changelog-fragments.mjs (flair#835).
//
// PROBLEM. A PR's changelog entry went into the single `[Unreleased]` block at
// the top of CHANGELOG.md, so two PRs that each added an entry could make
// overlapping edits there, and the second to merge could conflict. The cost is not the
// resolution — it is that a merge/rebase to resolve DISMISSES the existing
// approvals, so a conflict can buy a full second review round for zero content
// change. (bob's own [Unreleased] had also drifted into repeated
// `### Fixed`/`### Changed` headers from earlier resolutions.)
//
// FIX. One file per change under `.changelog/unreleased/`. PRs whose fragments
// have distinct filenames no longer share an edit to `[Unreleased]`; two PRs
// that add the same filename with different contents can conflict on that file. `promote` writes the
// fragments into a `## [<version>]` section below `[Unreleased]` and deletes them.
//
// FILE NAMING: `.changelog/unreleased/<category>-<slug>.md`
//   category  one of added|changed|deprecated|removed|fixed|security
//             (Keep a Changelog), in lowercase and matched exactly, taken
//             from the text BEFORE the first hyphen
//   slug      anything else; make it descriptive, uniqueness is on you (a PR
//             number is a fine slug, but is not required — the branch is pushed
//             before the PR number exists)
//
// FILE CONTENT: the entry as it should appear under its `### Category` heading,
// INCLUDING the leading `- `. Every continuation line is indented with spaces
// only, an even number of them, and every nonblank one by at least 2.
// Reading decodes the file as UTF-8 and refuses it by name when its bytes are not
// valid UTF-8, instead of reading them with replacement characters; it then
// trims the whitespace at the end of the file. Assembly joins the fragments as
// read: no reflow, no re-indent, no re-wrapping. That is
// deliberate. The failure this design exists to prevent is silent
// content loss, and every normalisation step is somewhere content can be
// silently altered. A fragment that does not already look like a list item is a
// hard error, not something to be helpfully fixed up.
//
// USAGE
//   node scripts/changelog-fragments.mjs render      print the assembled section
//   node scripts/changelog-fragments.mjs list        one line per fragment
//   node scripts/changelog-fragments.mjs check       validate; non-zero on error
//   node scripts/changelog-fragments.mjs promote <version> [--date=YYYY-MM-DD]
//                                                    write the section into
//                                                    CHANGELOG.md and delete the
//                                                    fragments; --date must be a
//                                                    real date (default: today, UTC)
//   Every command refuses an argument it does not take, with exit status 2.

import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
export const FRAGMENT_DIR_REL = join(".changelog", "unreleased");
export const FRAGMENT_DIR = join(ROOT, FRAGMENT_DIR_REL);
export const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");

// Keep a Changelog order. This array IS the ordering — categories are emitted in
// this sequence regardless of what the filesystem hands back.
export const CATEGORIES = ["added", "changed", "deprecated", "removed", "fixed", "security"];
const HEADING = {
  added: "Added",
  changed: "Changed",
  deprecated: "Deprecated",
  removed: "Removed",
  fixed: "Fixed",
  security: "Security",
};

// The body `## [Unreleased]` carries once entries live in fragments, and the
// ONLY body `check` and `promote` accept there (whitespace around it aside).
// Kept as a constant so both agree on it and `promote` can restore it.
export const UNRELEASED_NOTE = [
  "Entries for the next release live as **fragment files** under [`.changelog/unreleased/`](.changelog/unreleased/) —",
  "one file per change, so pull requests with distinct fragment filenames do not share an edit to this section.",
  "",
  "Add `.changelog/unreleased/<category>-<slug>.md` containing your entry as it should read under",
  "its `### Category` heading, leading `- ` included. Categories: `added`, `changed`, `deprecated`,",
  "`removed`, `fixed`, `security`.",
  "",
  "```bash",
  "node scripts/changelog-fragments.mjs render   # preview the assembled section",
  "node scripts/changelog-fragments.mjs check    # what CI checks",
  "```",
  "",
  "`node scripts/changelog-fragments.mjs promote <version>` writes them into a `## [<version>]` section",
  "below this one and deletes them as part of a version cut. **Do not add anything to this section by",
  "hand**: `check` and `promote` refuse while it holds anything but this note.",
].join("\n");

// ─── Fragment reading ─────────────────────────────────────────────────────────

export class FragmentError extends Error {
  constructor(message, file, line = 1) {
    super(message);
    this.file = file;
    this.line = line;
  }
}

// `<category>-<slug>.md` → { category, slug }. Throws with the offending name and
// the remedy — a fragment that cannot be placed must never be silently skipped.
export function parseFragmentName(filename) {
  if (!filename.endsWith(".md")) {
    throw new FragmentError(
      `${FRAGMENT_DIR_REL}/${filename}: not a .md file. Changelog fragments must be named ` +
        `<category>-<slug>.md (categories: ${CATEGORIES.join(", ")}).`,
    );
  }
  const stem = filename.slice(0, -".md".length);
  const dash = stem.indexOf("-");
  const category = dash === -1 ? stem : stem.slice(0, dash);
  if (!CATEGORIES.includes(category)) {
    throw new FragmentError(
      `${FRAGMENT_DIR_REL}/${filename}: '${dash === -1 ? stem : stem.slice(0, dash)}' is not a changelog ` +
        `category. Rename it <category>-<slug>.md with category one of: ${CATEGORIES.join(", ")}.`,
    );
  }
  const slug = dash === -1 ? "" : stem.slice(dash + 1);
  if (slug.length === 0) {
    throw new FragmentError(
      `${FRAGMENT_DIR_REL}/${filename}: missing the '-<slug>' part. Name it ${category}-<something-descriptive>.md.`,
    );
  }
  return { category, slug };
}

// The body must already be a top-level list item that passes the checks below,
// because assembly does not rewrite it. A body that fails them is an error the
// author fixes, not something this script guesses at.
export function validateFragmentBody(relPath, body) {
  if (body.trim().length === 0) {
    throw new FragmentError(
      `${relPath}: fragment is empty. Write the changelog entry into it, or delete the file.`,
    );
  }
  if (!body.startsWith("- ")) {
    throw new FragmentError(
      `${relPath}: fragment must start with '- ' (the markdown list marker) so it can be placed under its ` +
        `### heading as written. Indent continuation lines by 2 spaces.`,
    );
  }

  // One entry per file, checked HERE rather than only at assembly, so the author
  // hears it while the change is still theirs to fix. Checked before the indent
  // rule below, so a second top-level entry is named as such.
  //
  // Fenced code blocks are stripped before counting: fragments routinely quote
  // terminal output, and a line like `- foo` inside a fence is content, not a
  // second entry. Fence markers are INDENTED in practice (continuation content
  // under the entry's `- `), so the strip anchors on optional leading whitespace.
  const withoutFences = body.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, "");
  const entries = (withoutFences.match(/^- /gm) ?? []).length;
  if (entries > 1) {
    throw new FragmentError(
      `${relPath}: holds ${entries} top-level '- ' entries; a fragment is ONE changelog entry. ` +
        `Split it into one file per entry (<category>-<slug>.md) so each can be categorised, ordered ` +
        `and reviewed on its own. Indent continuation lines by 2 spaces so they stay part of their entry.`,
    );
  }

  // A whitespace convention, independent of Markdown syntax or fence state. Every
  // nonblank continuation line is indented by at least 2 spaces: a line at column
  // 0 (a heading, a paragraph) would render outside the entry.
  const lines = body.split("\n");
  for (let index = 1; index < lines.length; index++) {
    const leading = lines[index].match(/^[ \t]*/)[0];
    const indent = lines[index].match(/^ */)[0].length;
    const hasTab = leading.includes("\t");
    if (hasTab || indent % 2 !== 0) {
      throw new FragmentError(
        `${relPath}:${index + 1}: continuation indent ${indent}; ` +
          (hasTab ? "tabs are not allowed; " : "") +
          "indent continuation lines by an even number of spaces: 2 for the entry, 4 or more for nested content.",
        relPath,
        index + 1,
      );
    }
    if (indent < 2 && lines[index].trim().length > 0) {
      throw new FragmentError(
        `${relPath}:${index + 1}: continuation line is not indented, so it would render outside the entry; ` +
          "indent it by 2 spaces (4 or more for nested content).",
        relPath,
        index + 1,
      );
    }
  }
}

// ─── Lede (flair#1392; bob also refuses a MISSING or EMPTY lede, bob#236) ────
//
// The lede is the entry's summary, the line a reader skims first.
// bob's release workflow passes the whole `## [<version>]` section to the GitHub
// release (release-publish.yml runs scripts/changelog-extract.mjs, which trims
// only the whitespace around it), so no entry is shortened; but a 105-word lede is not a summary, it IS the entry. Hence
// <= 25 words with no sentence break, the rule flair#1392 set. A sentence break
// is a `.`, `!` or `?` followed by whitespace; nothing else is counted, so
// `First.Second.` is one sentence. Historical CHANGELOG.md is
// not rewritten; this rule is fragments only.

export const LEDE_WORD_LIMIT = 25;

/** First `**...**` after the list marker. Null when the fragment has no bold run. */
export function extractFragmentLede(body) {
  const m = String(body).match(/^- \*\*([\s\S]*?)\*\*/);
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").trim();
}

export function countLedeWords(lede) {
  return lede.split(/\s+/).filter(Boolean).length;
}

export function countLedeSentences(lede) {
  const t = lede.trim();
  if (t.length === 0) return 0;
  const parts = t.split(/(?<=[.!?])\s+/).filter((p) => p.length > 0);
  return Math.max(parts.length, 1);
}

/**
 * Null when the fragment is fine. Otherwise a message naming the fragment, the
 * problem and the rule. bob refuses a fragment with NO bold lede, one whose bold
 * run is empty (`- **** detail`), and one whose lede is over budget; only the
 * last reports a word count.
 */
export function ledeViolation(relPath, body) {
  const lede = extractFragmentLede(body);
  if (lede == null) {
    return (
      `${relPath}: no bold lede. Start the entry with '- **<summary>**' (<= ${LEDE_WORD_LIMIT} words, no sentence break): ` +
      `the lede is the entry's summary, the line a reader skims first.`
    );
  }
  if (lede.length === 0) {
    return (
      `${relPath}: empty bold lede. Put the entry's summary (<= ${LEDE_WORD_LIMIT} words, no sentence break) ` +
      `inside the leading '**...**'.`
    );
  }
  const words = countLedeWords(lede);
  const sentences = countLedeSentences(lede);
  if (words <= LEDE_WORD_LIMIT && sentences <= 1) return null;
  const extra = sentences > 1 ? ` in ${sentences} sentences` : "";
  return (
    `${relPath}: bold lede is ${words} words${extra}; a lede is the entry's summary, so it must be ` +
    `<= ${LEDE_WORD_LIMIT} words with no sentence break (a '.', '!' or '?' followed by whitespace) (flair#1392). ` +
    `Move detail below the bold run.`
  );
}

export function validateLede(relPath, body) {
  const msg = ledeViolation(relPath, body);
  if (msg) throw new FragmentError(msg);
}

// Fatal UTF-8 decoding for every file this script reads (fragments and
// CHANGELOG.md): bytes that are not valid UTF-8 are refused by the file's name,
// not decoded with U+FFFD replacement characters that `check` would pass and
// `promote` would write back. A leading byte-order mark is kept, as the plain
// `utf8` read kept it.
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeUtf8OrThrow(bytes, what) {
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    throw new FragmentError(
      `${what}: not valid UTF-8, so it is refused rather than read with replacement characters; ` +
        `nothing was written. Save it as UTF-8.`,
    );
  }
}

// CHANGELOG.md is read and written only as a REGULAR file, never through a
// symbolic link: promote's recovery is `git checkout -- CHANGELOG.md`, which
// restores a tracked link, not the file it points at. Each access opens the
// path with O_NOFOLLOW (a link fails with ELOOP) and judges the file by fstat on
// that descriptor, which gives lstat's answer without a separate path check a
// swap could race. A file with more than one hard link is refused too: the
// truncating write would change every link, and git checkout restores only this
// path. The write reopens the path the same way and refuses unless the file it
// opened has the same device and inode as the file that was read, then truncates
// and writes through that descriptor. So a symbolic link, or a file with another
// device or inode, swapped in between the read and the write fails closed. The
// read descriptor is closed before the write opens, so a replacement that the
// filesystem gives the same inode number is not told apart.
const CHANGELOG_READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const CHANGELOG_WRITE_FLAGS = constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

// Device and inode as BigInt: as JS numbers, distinct values above 2^53 can
// round to the same number, and the identity check would accept another file.
// `fstat` is a test seam; every caller but a test uses this default.
const fstatBigint = (fd) => fstatSync(fd, { bigint: true });

function openRegularChangelog(changelogPath, flags, fstat = fstatBigint) {
  let fd;
  try {
    fd = openSync(changelogPath, flags);
  } catch (err) {
    if (err?.code === "ELOOP") {
      throw new FragmentError(
        "CHANGELOG.md is a symbolic link; it must be a regular file, so that git checkout -- CHANGELOG.md " +
          "can undo what promote writes. Replace the link with the file itself.",
      );
    }
    throw err;
  }
  const st = fstat(fd);
  if (!st.isFile()) {
    closeSync(fd);
    throw new FragmentError(
      "CHANGELOG.md is not a regular file; it must be one, so that git checkout -- CHANGELOG.md can undo " +
        "what promote writes.",
    );
  }
  if (st.nlink > 1n) {
    closeSync(fd);
    throw new FragmentError(
      `CHANGELOG.md has ${st.nlink} hard links; it must have one, so that git checkout -- CHANGELOG.md ` +
        "can undo what promote writes (a write would change the other links too). Replace it with a copy " +
        "(cp CHANGELOG.md CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md).",
    );
  }
  return { fd, st };
}

/** CHANGELOG.md's text and the identity (device, inode) of the file read. */
export function readChangelog(changelogPath, { fstat = fstatBigint } = {}) {
  const { fd, st } = openRegularChangelog(changelogPath, CHANGELOG_READ_FLAGS, fstat);
  try {
    return { text: decodeUtf8OrThrow(readFileSync(fd), "CHANGELOG.md"), dev: st.dev, ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace CHANGELOG.md's content, only if the regular file opened for writing has
 * the same device and inode as the file `read` came from.
 */
export function writeChangelog(changelogPath, text, read, { fstat = fstatBigint } = {}) {
  const { fd, st } = openRegularChangelog(changelogPath, CHANGELOG_WRITE_FLAGS, fstat);
  try {
    if (st.dev !== read.dev || st.ino !== read.ino) {
      throw new FragmentError(
        "CHANGELOG.md was replaced after it was read; nothing was written. Run promote again.",
      );
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

// Read every fragment in `dir`. Dotfiles are ignored (.DS_Store, .gitkeep);
// README.md documents the convention and is not a fragment. EVERYTHING else is
// parsed, and a file that will not parse throws — a fragment directory that
// quietly skips files is the silent-drop bug this whole change exists to remove.
//
// A MISSING directory is refused, not read as "no fragments": `check` would
// otherwise pass a tree whose fragments were deleted along with the directory.
// Check both directory entries with lstat before reading their contents, so a
// link at either level is refused before check or promote reaches the fragments.
//
// Each entry is opened ONCE and every question about it is answered from that
// descriptor. Checking the path (stat) and then reading the path lets the entry
// be swapped in between, so the file that passed the check need not be the file
// that was read (CodeQL js/file-system-race). O_NONBLOCK makes opening a FIFO
// return at once, so it is refused below instead of blocking on a writer.
// O_NOFOLLOW refuses a symbolic link: a fragment (any entry but README.md and a
// dotfile, which the loop below skips without opening) is a regular file in this
// directory, never a pointer to content elsewhere.
const FRAGMENT_OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

function assertFragmentDirectories(dir) {
  for (const [path, rel] of [
    [dirname(dir), ".changelog"],
    [dir, FRAGMENT_DIR_REL],
  ]) {
    let st;
    try {
      st = lstatSync(path);
    } catch (err) {
      // A missing directory is left to readFragments, which names .changelog/unreleased/.
      if (err?.code === "ENOENT") return;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new FragmentError(
        `${rel}/ is a symbolic link; it must be a real directory. Replace the link with the ` +
          `directory itself and put the fragment files in ${FRAGMENT_DIR_REL}/.`,
      );
    }
    if (!st.isDirectory()) {
      throw new FragmentError(`${rel}/ is not a directory. Restore ${FRAGMENT_DIR_REL}/.`);
    }
  }
}

export function readFragments(dir = FRAGMENT_DIR) {
  assertFragmentDirectories(dir);
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new FragmentError(
        `${FRAGMENT_DIR_REL}/: directory not found. It holds the changelog fragments and their README.md; ` +
          `restore it (git checkout -- ${FRAGMENT_DIR_REL}). An empty directory is fine.`,
      );
    }
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (name === "README.md") continue;
    const full = join(dir, name);
    let fd;
    try {
      fd = openSync(full, FRAGMENT_OPEN_FLAGS);
    } catch (err) {
      if (err?.code === "ELOOP") {
        throw new FragmentError(
          `${FRAGMENT_DIR_REL}/${name}: a symbolic link. Fragments are regular files named ` +
            `<category>-<slug>.md; commit the entry itself in place of the link.`,
        );
      }
      throw err;
    }
    let category;
    let slug;
    let body;
    try {
      const st = fstatSync(fd);
      if (st.isDirectory()) {
        throw new FragmentError(
          `${FRAGMENT_DIR_REL}/${name}: unexpected directory. Fragments are flat files named <category>-<slug>.md.`,
        );
      }
      if (!st.isFile()) {
        throw new FragmentError(
          `${FRAGMENT_DIR_REL}/${name}: not a regular file. Fragments are flat files named <category>-<slug>.md.`,
        );
      }
      ({ category, slug } = parseFragmentName(name));
      body = decodeUtf8OrThrow(readFileSync(fd), `${FRAGMENT_DIR_REL}/${name}`);
    } finally {
      closeSync(fd);
    }
    validateFragmentBody(`${FRAGMENT_DIR_REL}/${name}`, body);
    validateLede(`${FRAGMENT_DIR_REL}/${name}`, body);
    out.push({ name, path: full, category, slug, body: body.replace(/\s+$/, "") });
  }
  return out;
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

// Deterministic by construction: categories in CATEGORIES order, fragments within
// a category by codepoint-ordered filename. Never readdir order, never
// localeCompare (locale-dependent). Same fragments in ⇒ same bytes out.
export function assemble(fragments) {
  const blocks = [];
  for (const category of CATEGORIES) {
    const inCategory = fragments
      .filter((f) => f.category === category)
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (inCategory.length === 0) continue;
    blocks.push(`### ${HEADING[category]}\n\n${inCategory.map((f) => f.body).join("\n\n")}`);
  }
  return blocks.join("\n\n");
}

// Count of top-level entries in an assembled section. Used by `check` and
// `promote` to report "N entries" against the fragment count. If those two ever
// disagree, either an entry was dropped (fewer) or a fragment carried an extra
// top-level item (more); both are refused.
export function countEntries(section) {
  return section.split("\n").filter((l) => l.startsWith("- ")).length;
}

// ─── CHANGELOG.md surgery ─────────────────────────────────────────────────────

// The heading is ONE line, equal to `## [Unreleased]` byte for byte. A CANDIDATE
// is any line that, after at most three leading spaces, starts with `##`,
// optional spaces or tabs, `[`, optional spaces or tabs, and `unreleased` in any
// letter case, whatever follows. That covers every Markdown level-two heading
// written that way (another case, a suffix, a missing `]`, trailing spaces or
// tabs, up to three leading spaces) and the same text with no space after `##`.
// Exactly one candidate may exist, and it must be the exact line: a candidate
// before or after it is refused, so no entry can sit under another such line
// that `check` and `promote` do not read. A heading written another way, such as
// a setext `[Unreleased]` underlined with `---`, is not a candidate.
const UNRELEASED_HEADING = "## [Unreleased]";
const UNRELEASED_LOOKALIKE = /^ {0,3}##[ \t]*\[[ \t]*unreleased/i;

/** `{ index }` of the one exact heading, or `{ problem }` saying what is wrong. */
export function findUnreleasedHeading(lines) {
  const found = [];
  lines.forEach((l, i) => {
    if (UNRELEASED_LOOKALIKE.test(l)) found.push(i);
  });
  if (found.length === 0) return { problem: `no '${UNRELEASED_HEADING}' heading` };
  if (found.length > 1) {
    return {
      problem:
        `${found.length} [Unreleased] headings (lines ${found.map((i) => i + 1).join(", ")}); ` +
        `keep exactly one, the line '${UNRELEASED_HEADING}'`,
    };
  }
  const index = found[0];
  if (lines[index] !== UNRELEASED_HEADING) {
    return {
      problem: `line ${index + 1} is ${JSON.stringify(lines[index])}, not exactly '${UNRELEASED_HEADING}'`,
    };
  }
  return { index };
}

export function locateUnreleased(lines) {
  const heading = findUnreleasedHeading(lines);
  if (heading.problem !== undefined) return null;
  const start = heading.index;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, body: lines.slice(start + 1, end).join("\n") };
}

// `promote` rewrites the `## [Unreleased]` body to UNRELEASED_NOTE, so anything
// else there would be dropped at the version cut. Both `check` and `promote`
// therefore refuse unless that body is the note (whitespace around it aside).
// A list entry gets its own message, because its remedy is a fragment.
export function strayUnreleasedEntries(body) {
  return body.split("\n").filter((l) => l.startsWith("- "));
}

/**
 * Null when the `[Unreleased]` body located by `locateUnreleased` is the managed
 * note. Otherwise where it first differs: a 1-based CHANGELOG.md line number and
 * that line's text ("(end of section)" when the note is cut short).
 */
export function unreleasedNoteMismatch(loc) {
  if (loc.body.trim() === UNRELEASED_NOTE) return null;
  const bodyLines = loc.body.split("\n");
  let lead = 0;
  while (lead < bodyLines.length && bodyLines[lead].trim() === "") lead++;
  const got = loc.body.trim().split("\n");
  const want = UNRELEASED_NOTE.split("\n");
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  // Report the first NONBLANK line from the difference on, so an added paragraph
  // is shown by its text rather than by the blank line before it.
  let j = i;
  while (j < got.length && got[j].trim() === "") j++;
  // Body line k (0-based, untrimmed) is CHANGELOG.md line loc.start + 2 + k.
  if (j < got.length) return { line: loc.start + 2 + lead + j, text: got[j].slice(0, 80) };
  return { line: loc.start + 2 + lead + i, text: "(end of section)" };
}

// ─── check (what CI runs) ─────────────────────────────────────────────────────

/**
 * Validate the fragments + CHANGELOG. Throws a FragmentError on the first
 * problem; returns a summary on success. Exported (not just driven from argv) so
 * a test can point it at a temp dir + temp CHANGELOG.
 */
export function check({ changelogPath = CHANGELOG_PATH, dir = FRAGMENT_DIR } = {}) {
  const fragments = readFragments(dir);
  const section = assemble(fragments);
  const entries = countEntries(section);
  if (entries !== fragments.length) {
    throw new FragmentError(
      `assembled ${entries} entries from ${fragments.length} fragments — a fragment holds more than one ` +
        `top-level '- ' item. Split it into one file per entry.`,
    );
  }
  // The stray-entry rule cannot be evaluated without the header, so a missing
  // header is an error, not "no stray entries ⇒ OK" — otherwise the PR-time
  // check is weaker than the release-time one and a mangled header sails through
  // CI green and detonates mid-release-cut (flair#953).
  const changelogLines = readChangelog(changelogPath).text.split("\n");
  const heading = findUnreleasedHeading(changelogLines);
  if (heading.problem !== undefined) {
    throw new FragmentError(
      `CHANGELOG.md: ${heading.problem}, so the stray-entry check could not run — and 'promote' will ` +
        `refuse for the same reason at release time. Make it the one line '## [Unreleased]'.`,
    );
  }
  const loc = locateUnreleased(changelogLines);
  const stray = strayUnreleasedEntries(loc.body);
  if (stray.length > 0) {
    throw new FragmentError(
      `CHANGELOG.md '## [Unreleased]' has ${stray.length} hand-written entr${stray.length === 1 ? "y" : "ies"}; ` +
        `move ${stray.length === 1 ? "it" : "them"} into ${FRAGMENT_DIR_REL}/.`,
    );
  }
  const drift = unreleasedNoteMismatch(loc);
  if (drift) {
    throw new FragmentError(
      `CHANGELOG.md '## [Unreleased]' holds text other than the managed note (line ${drift.line}: ` +
        `${drift.text}). 'promote' rewrites that section to the note, so move any change into ` +
        `${FRAGMENT_DIR_REL}/<category>-<slug>.md and restore the note (UNRELEASED_NOTE in ` +
        `scripts/changelog-fragments.mjs).`,
    );
  }
  return { fragments: fragments.length, entries };
}

// ─── promote ──────────────────────────────────────────────────────────────────

export function promote(
  version,
  { date, changelogPath = CHANGELOG_PATH, dir = FRAGMENT_DIR, fstat } = {},
) {
  if (!isReleaseVersion(version)) {
    throw new FragmentError(
      `promote: invalid version '${version}'. Expected MAJOR.MINOR.PATCH with no leading zeros, optionally ` +
        `followed by -<pre-release> of dot-separated identifiers of letters and digits, a numeric one with no ` +
        `leading zero (e.g. 0.31.0 or 1.0.0-rc.1); build ` +
        `metadata (+...) is not accepted.`,
    );
  }
  if (date !== undefined && !isCalendarDate(date)) {
    throw new FragmentError(
      `promote: invalid --date '${date}'. Expected a real date as YYYY-MM-DD, e.g. 2026-09-29; nothing was written.`,
    );
  }
  const fragments = readFragments(dir);
  if (fragments.length === 0) {
    throw new FragmentError(
      `promote: no fragments in ${FRAGMENT_DIR_REL}/ — refusing to cut v${version} with an empty changelog section. ` +
        `Add the entries for this release before running the release step.`,
    );
  }
  const changelogRead = readChangelog(changelogPath, { fstat });
  const text = changelogRead.text;
  const lines = text.split("\n");
  const heading = findUnreleasedHeading(lines);
  if (heading.problem !== undefined) {
    throw new FragmentError(
      `promote: CHANGELOG.md: ${heading.problem}. Make it the one line '## [Unreleased]'.`,
    );
  }
  const loc = locateUnreleased(lines);
  // Matched the way scripts/changelog-extract.mjs finds a release's section, which
  // would publish only the first of two.
  const existing = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (existing !== -1) {
    throw new FragmentError(
      `promote: CHANGELOG.md already has a '## [${version}]' section (line ${existing + 1}); a version is cut ` +
        `once. Promote under the next version, or remove that section first.`,
    );
  }

  const stray = strayUnreleasedEntries(loc.body);
  if (stray.length > 0) {
    throw new FragmentError(
      `promote: '## [Unreleased]' contains ${stray.length} hand-written entr${stray.length === 1 ? "y" : "ies"} ` +
        `that this step would overwrite. Move ${stray.length === 1 ? "it" : "them"} into ` +
        `${FRAGMENT_DIR_REL}/<category>-<slug>.md first. First one: ${stray[0].slice(0, 80)}`,
    );
  }
  const drift = unreleasedNoteMismatch(loc);
  if (drift) {
    throw new FragmentError(
      `promote: '## [Unreleased]' holds text other than the managed note (line ${drift.line}: ${drift.text}), ` +
        `which this step would overwrite. Move any change into ${FRAGMENT_DIR_REL}/<category>-<slug>.md and ` +
        `restore the note first.`,
    );
  }

  const section = assemble(fragments);
  const entries = countEntries(section);
  if (entries !== fragments.length) {
    throw new FragmentError(
      `promote: assembled ${entries} entries from ${fragments.length} fragments. A fragment holds more than ` +
        `one top-level '- ' item; split it into one file per entry.`,
    );
  }

  gitRestorableOrThrow({ changelogPath, dir, names: fragments.map((f) => f.name) });

  const day = date ?? new Date().toISOString().slice(0, 10);
  const replacement = ["", UNRELEASED_NOTE, "", `## [${version}] - ${day}`, "", section, ""];
  const next = [...lines.slice(0, loc.start + 1), ...replacement, ...lines.slice(loc.end)];
  // A failure part-way must say what state it left and how to recover: the
  // section is written first, and the fragments are deleted only after that.
  try {
    writeChangelog(changelogPath, next.join("\n"), changelogRead, { fstat });
  } catch (err) {
    if (err instanceof FragmentError) {
      throw new FragmentError(`promote: ${err.message} No fragment was deleted.`);
    }
    throw new FragmentError(
      `promote: could not write CHANGELOG.md (${err?.code ?? err}); no fragment was deleted. Restore it ` +
        `(git checkout -- CHANGELOG.md) and run promote again.`,
    );
  }
  const left = [];
  for (const f of fragments) {
    try {
      unlinkSync(f.path);
    } catch (err) {
      left.push(`${f.name} (${err?.code ?? err})`);
    }
  }
  if (left.length > 0) {
    throw new FragmentError(
      `promote: '## [${version}] - ${day}' is written to CHANGELOG.md, but ${left.length} fragment(s) could ` +
        `not be deleted: ${left.join(", ")}. They are already in that section: delete them before the next ` +
        `check or promote, or restore both (git checkout -- CHANGELOG.md ${FRAGMENT_DIR_REL}) and run promote again.`,
    );
  }
  return { version, date: day, entries, removed: fragments.map((f) => f.name) };
}

// `promote` rewrites CHANGELOG.md and deletes the fragments, and its recovery from
// a part-way failure is `git checkout -- CHANGELOG.md .changelog/unreleased`,
// which restores files from the INDEX. So before it writes anything, promote
// requires a git work tree and refuses while CHANGELOG.md or any fragment is
// untracked (not in the index) or differs from the index, naming each: git could
// not restore those as they are, and a deleted untracked fragment would be gone.
// Explicit `env`: under Bun 1.3.10, where the tests import this module, a child
// spawned without it does not see process.env changes made after startup.
function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: process.env,
  });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? "" };
}

// The paths (relative to `cwd`) whose RAW working-tree bytes (`git hash-object
// --no-filters`) hash to something other than their index blob; null when git
// cannot answer.
function differsFromIndex(cwd, paths) {
  if (paths.length === 0) return [];
  const staged = git(cwd, ["--literal-pathspecs", "ls-files", "-s", "-z", "--", ...paths]);
  const hashed = git(cwd, ["hash-object", "--no-filters", "--", ...paths]);
  if (!staged.ok || !hashed.ok) return null;
  const index = new Map();
  for (const record of staged.out.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    index.set(record.slice(tab + 1), record.slice(0, tab).split(" ")[1]);
  }
  const work = hashed.out.split("\n").filter(Boolean);
  if (work.length !== paths.length) return null;
  return paths.filter((p, i) => index.get(p) !== work[i]);
}

export function gitRestorableOrThrow({ changelogPath, dir, names }) {
  const inside = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out.trim() !== "true") {
    throw new FragmentError(
      `promote: ${FRAGMENT_DIR_REL}/ is not in a git work tree. promote runs in the repository, so that a ` +
        `part-way failure can be undone with git checkout -- CHANGELOG.md ${FRAGMENT_DIR_REL}; nothing was written.`,
    );
  }
  const clDir = dirname(changelogPath);
  const clName = basename(changelogPath);
  const lists = [
    git(dir, ["ls-files", "-z", "--", "."]),
    git(dir, ["ls-files", "-m", "-z", "--", "."]),
    git(clDir, ["ls-files", "-z", "--", clName]),
    git(clDir, ["ls-files", "-m", "-z", "--", clName]),
  ];
  if (lists.some((l) => !l.ok)) {
    throw new FragmentError(
      `promote: git ls-files failed, so nothing was written; repair the Git index or its environment ` +
        `until ls-files succeeds, then retry promote.`,
    );
  }
  const set = (l) => new Set(l.out.split("\0").filter(Boolean));
  const [tracked, modified, clTracked, clModified] = lists.map(set);
  const untracked = names.filter((n) => !tracked.has(n));
  const changed = names.filter((n) => modified.has(n));
  if (!clTracked.has(clName)) untracked.unshift("CHANGELOG.md");
  if (clModified.has(clName)) changed.unshift("CHANGELOG.md");
  // `ls-files -m` trusts the index flags: a file marked assume-unchanged or
  // skip-worktree reports no change even when it was edited. So every tracked
  // file promote will change or delete is also compared with its index blob on
  // its RAW bytes (`ls-files -s` against `hash-object --no-filters`), whatever its
  // flags say. A filtered hash would miss an edit a filter normalizes away (with
  // core.autocrlf=input, a CRLF rewrite of an LF file hashes like the original),
  // so a file whose bytes a filter changes counts as changed: conservative, and
  // the refusal says so.
  const fragmentsDiffer = differsFromIndex(
    dir,
    names.filter((n) => tracked.has(n)),
  );
  const changelogDiffers = clTracked.has(clName) ? differsFromIndex(clDir, [clName]) : [];
  if (fragmentsDiffer === null || changelogDiffers === null) {
    throw new FragmentError(
      `promote: git ls-files -s or git hash-object failed or gave an unexpected answer, so it cannot tell whether git could restore ` +
        `CHANGELOG.md and the fragments; nothing was written.`,
    );
  }
  for (const n of fragmentsDiffer) if (!changed.includes(n)) changed.push(n);
  if (changelogDiffers.length > 0 && !changed.includes("CHANGELOG.md"))
    changed.unshift("CHANGELOG.md");
  if (untracked.length > 0 || changed.length > 0) {
    const parts = [];
    if (untracked.length > 0) parts.push(`untracked (not in the index): ${untracked.join(", ")}`);
    if (changed.length > 0)
      parts.push(`changed since staged (differs from the index): ${changed.join(", ")}`);
    const rawNote =
      changed.length > 0
        ? " A file can count as changed with no edit: promote also compares raw bytes with the index, so " +
          "a file that a line-ending conversion or a clean filter (core.autocrlf, a .gitattributes filter) " +
          "changes on its way into git differs; for such a file, run promote in a checkout where git " +
          "stores these files byte for byte."
        : "";
    throw new FragmentError(
      `promote: git could not restore these as they are, so nothing was written. ${parts.join("; ")}. ` +
        `Stage them (git add) or remove them, then run promote again.${rawNote}`,
    );
  }
}

// The versions `promote` accepts: MAJOR.MINOR.PATCH, each 0 or a number with no
// leading zero, optionally followed by a pre-release: `-` and dot-separated
// identifiers of letters and digits, a numeric identifier again with no leading
// zero (1.0.0-rc.1). Narrower than SemVer (no build metadata, no hyphen inside a
// pre-release) and a subset of what the release workflow and
// scripts/changelog-extract.mjs accept, so a promoted version can be released.
const VERSION_NUMBER = "(?:0|[1-9][0-9]*)";
const PRE_RELEASE_ID = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z][0-9A-Za-z]*)";
const RELEASE_VERSION = new RegExp(
  `^${VERSION_NUMBER}\\.${VERSION_NUMBER}\\.${VERSION_NUMBER}(?:-${PRE_RELEASE_ID}(?:\\.${PRE_RELEASE_ID})*)?$`,
);

export function isReleaseVersion(v) {
  return typeof v === "string" && RELEASE_VERSION.test(v);
}

// `YYYY-MM-DD` naming a day that exists (no 2026-02-30).
export function isCalendarDate(s) {
  if (typeof s !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

// Compared by REAL path: the module's own URL is resolved through symlinks while
// argv[1] is not, so comparing them as given made the CLI a silent no-op (exit 0,
// `check` included) whenever the script was run through a symlinked path.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  const USAGE = "render | list | check | promote <version> [--date=YYYY-MM-DD]";
  // A usage error exits 2 and does nothing; an argument a command does not take
  // is refused rather than ignored, for every command.
  const usageError = (msg) => {
    process.stderr.write(
      `changelog-fragments: ${msg}\nUsage: node scripts/changelog-fragments.mjs ${USAGE}\n`,
    );
    process.exit(2);
  };
  const [cmd = "render", ...rest] = process.argv.slice(2);
  try {
    if ((cmd === "render" || cmd === "list" || cmd === "check") && rest.length > 0) {
      usageError(`${cmd}: unexpected argument(s): ${rest.join(" ")}`);
    }
    if (cmd === "render") {
      const section = assemble(readFragments());
      if (section.length > 0) process.stdout.write(`${section}\n`);
    } else if (cmd === "list") {
      const fragments = readFragments();
      for (const c of CATEGORIES) {
        for (const f of fragments
          .filter((x) => x.category === c)
          .sort((a, b) => (a.name < b.name ? -1 : 1))) {
          process.stdout.write(`${HEADING[c].padEnd(10)} ${f.name}\n`);
        }
      }
      process.stdout.write(`\n${fragments.length} fragment(s) in ${FRAGMENT_DIR_REL}/\n`);
    } else if (cmd === "check") {
      const res = check();
      process.stdout.write(
        `✓ ${res.fragments} fragment(s), ${res.entries} entr(ies), [Unreleased] holds only the managed note.\n`,
      );
    } else if (cmd === "promote") {
      const [version, ...opts] = rest;
      const unknown = opts.filter((a) => !a.startsWith("--date="));
      if (unknown.length > 0) usageError(`promote: unexpected argument(s): ${unknown.join(" ")}`);
      const dates = opts.filter((a) => a.startsWith("--date="));
      if (dates.length > 1) usageError(`promote: --date given ${dates.length} times; give it once`);
      const date = dates.length === 1 ? dates[0].slice("--date=".length) : undefined;
      const res = promote(version, { date });
      process.stdout.write(
        `✓ promoted ${res.entries} entr(ies) into '## [${res.version}] - ${res.date}'; removed ${res.removed.length} fragment(s).\n`,
      );
    } else {
      usageError(`unknown command '${cmd}'`);
    }
  } catch (err) {
    process.stderr.write(`changelog-fragments: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
