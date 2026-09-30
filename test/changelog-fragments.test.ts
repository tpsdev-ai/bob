// bob#236: changelog fragments. Ported from flair's model; these tests cover the
// issue's acceptance: two PRs whose fragments have distinct filenames merge
// cleanly in either order; `check` fails on anything but the managed note under
// [Unreleased] and on a malformed fragment; `render` carries the migrated list
// entries reordered by category and filename, and apart from that order they
// differ only by the eleven repairs the migration tests name and the whitespace
// trimmed at the end of each fragment (the block body's two HTML comment
// markers, `<!-- START #221 -->` and `<!-- END #221 -->`, are not list entries
// and do not render); `promote`
// writes a dated section below [Unreleased] and deletes the fragments.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cf from "../scripts/changelog-fragments.mjs";

const NOTE = cf.UNRELEASED_NOTE;
// Whole entries: a `- ` line plus its indented continuation lines and the blank
// lines between them, so a change past an entry's first line is still seen.
function ENTRIES(s: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of s.split("\n")) {
    if (line.startsWith("- ")) {
      if (cur) out.push(cur.join("\n").trimEnd());
      cur = [line];
    } else if (cur && (line.startsWith("  ") || line.trim() === "")) {
      cur.push(line);
    } else if (cur) {
      out.push(cur.join("\n").trimEnd());
      cur = null;
    }
  }
  if (cur) out.push(cur.join("\n").trimEnd());
  return out;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-fragments-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A minimal project: a CHANGELOG whose [Unreleased] body is the note (no stray
// entries), and an (empty) fragment dir.
function project(): { dir: string; changelogPath: string } {
  const changelogPath = join(root, "CHANGELOG.md");
  writeFileSync(
    changelogPath,
    `# Changelog\n\n## [Unreleased]\n\n${NOTE}\n\n## [0.0.1] - 2020-01-01\n\nold\n`,
  );
  const dir = join(root, ".changelog", "unreleased");
  mkdirSync(dir, { recursive: true });
  return { dir, changelogPath };
}

// promote runs only in a git work tree, with CHANGELOG.md and every fragment
// matching the index: make `root` one and stage everything in it.
function stageAll(): void {
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
  ]) {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
}

function fragment(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body);
}

describe("changelog fragments — check (bob#236)", () => {
  it("passes on a well-formed fragment set", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a-thing.md", "- **A thing was fixed.** Detail.\n");
    const res = cf.check({ dir, changelogPath });
    expect(res).toEqual({ fragments: 1, entries: 1 });
  });

  it("REFUSES a hand-written entry left in [Unreleased]", () => {
    const { dir, changelogPath } = project();
    writeFileSync(
      changelogPath,
      `# Changelog\n\n## [Unreleased]\n\n- a hand-written entry\n\n## [0.0.1] - 2020-01-01\n`,
    );
    expect(() => cf.check({ dir, changelogPath })).toThrow(/hand-written entr/);
  });

  it("REFUSES a fragment whose name is not <category>-<slug>.md", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "nope-thing.md", "- **x.** y.\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/not a changelog category/);
  });

  it("REFUSES a category prefix that is not lowercase", () => {
    for (const name of ["Fixed-a-thing.md", "FIXED-a-thing.md"]) {
      const { dir, changelogPath } = project();
      fragment(dir, name, "- **A thing was fixed.** Detail.\n");
      expect(() => cf.check({ dir, changelogPath }), name).toThrow(
        `'${name.split("-")[0]}' is not a changelog category`,
      );
      rmSync(join(dir, name));
    }
  });

  // A sentence break is `.`, `!` or `?` followed by whitespace; nothing else is
  // counted (the README and the lede error say so).
  it("counts a lede's sentences by a '.', '!' or '?' followed by whitespace, and nothing else", () => {
    expect(cf.countLedeSentences("First.Second.")).toBe(1);
    expect(cf.countLedeSentences("Version 1.2.3 and scripts/x.mjs ship.")).toBe(1);
    expect(cf.countLedeSentences("First. Second.")).toBe(2);
    expect(cf.countLedeSentences("First!\nSecond?")).toBe(2);
    expect(cf.countLedeSentences("First.\tSecond.")).toBe(2);
    expect(cf.countLedeSentences("First.\u00a0Second.")).toBe(2);
  });

  it("REFUSES a fragment with no bold lede", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-no-lede.md", "- a fix with no bold run.\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/no bold lede/);
  });

  it("REFUSES a fragment whose bold lede is over the word limit", () => {
    const { dir, changelogPath } = project();
    fragment(
      dir,
      "fixed-long-lede.md",
      `- **${"word ".repeat(cf.LEDE_WORD_LIMIT + 5).trim()}.** x.\n`,
    );
    expect(() => cf.check({ dir, changelogPath })).toThrow(/bold lede is \d+ words/);
  });

  it("REFUSES a fragment body that is not a list item", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-not-list.md", "just some prose\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/must start with '- '/);
  });

  it("REFUSES a fragment holding more than one entry", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-two-entries.md", "- **one.** a.\n- **two.** b.\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/ONE changelog entry/);
  });

  it("REFUSES an odd continuation indent", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-odd-indent.md", "- **x.** y.\n   three spaces\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/continuation indent 3/);
  });

  it("REFUSES a continuation line that is not indented (it would render outside the entry)", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-flush-left.md", "- **Valid.** Detail\n### Added\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(
      /fixed-flush-left\.md:2: continuation line is not indented/,
    );
  });

  it("REFUSES an empty bold lede", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-empty-lede.md", "- **** detail\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/fixed-empty-lede\.md: empty bold lede/);
  });

  it("passes on an empty fragment directory (the state right after `promote`)", () => {
    const { dir, changelogPath } = project();
    expect(cf.check({ dir, changelogPath })).toEqual({ fragments: 0, entries: 0 });
  });

  it("REFUSES a missing fragment directory rather than reading it as empty", () => {
    const { dir, changelogPath } = project();
    rmSync(dir, { recursive: true });
    expect(() => cf.check({ dir, changelogPath })).toThrow(/unreleased\/: directory not found/);
  });

  // Each entry is opened once and judged by its descriptor, not by a separate
  // stat of the path. The open does not block on a FIFO (O_NONBLOCK).
  it("REFUSES an entry that is not a regular file (a directory, a FIFO)", () => {
    const { dir, changelogPath } = project();
    mkdirSync(join(dir, "fixed-a-directory.md"));
    expect(() => cf.check({ dir, changelogPath })).toThrow(/unexpected directory/);
    rmSync(join(dir, "fixed-a-directory.md"), { recursive: true });
    const made = spawnSync("mkfifo", [join(dir, "fixed-a-fifo.md")], { encoding: "utf8" });
    expect(made.status, made.stderr).toBe(0);
    expect(() => cf.check({ dir, changelogPath })).toThrow(/fixed-a-fifo\.md: not a regular file/);
  });

  it("REFUSES a symbolic link, even to a well-formed fragment outside the directory", () => {
    const { dir, changelogPath } = project();
    const outside = join(root, "elsewhere.md");
    writeFileSync(outside, "- **A well-formed entry.** Detail.\n");
    symlinkSync(outside, join(dir, "fixed-a-link.md"));
    expect(() => cf.check({ dir, changelogPath })).toThrow(/fixed-a-link\.md: a symbolic link/);
  });

  it("REFUSES text other than the managed note under [Unreleased], naming its line", () => {
    const { dir, changelogPath } = project();
    writeFileSync(
      changelogPath,
      `# Changelog\n\n## [Unreleased]\n\n${NOTE}\n\nA hand-written paragraph.\n\n## [0.0.1] - 2020-01-01\n`,
    );
    // Lines 1-4 are the title, a blank, the header and a blank; the note follows,
    // then a blank, then the paragraph.
    const line = 4 + NOTE.split("\n").length + 2;
    expect(() => cf.check({ dir, changelogPath })).toThrow(
      `holds text other than the managed note (line ${line}: A hand-written paragraph.)`,
    );
  });

  it("REFUSES an [Unreleased] heading that is not exactly '## [Unreleased]', in check and in promote", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    for (const heading of [
      "## [Unreleased] - next",
      "## [unreleased]",
      "## [Unreleased] ",
      "## [Unreleased]\t",
      "##  [Unreleased]",
      " ## [Unreleased]",
      "   ## [Unreleased]",
      "## [Unreleased",
      "##[Unreleased]",
    ]) {
      const text = `# Changelog\n\n${heading}\n\n${NOTE}\n\n## [0.0.1] - 2020-01-01\n`;
      writeFileSync(changelogPath, text);
      const shown = JSON.stringify(heading);
      expect(() => cf.check({ dir, changelogPath }), shown).toThrow(
        `line 3 is ${shown}, not exactly '## [Unreleased]'`,
      );
      expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath }), shown).toThrow(
        `line 3 is ${shown}, not exactly '## [Unreleased]'`,
      );
      expect(readFileSync(changelogPath, "utf8")).toBe(text);
      expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    }
  });

  // A second candidate can hide the entry under it from the note check: before
  // the exact heading its section is never read, and after it a candidate at
  // column one ends the section being read (an indented one leaves the entry
  // inside that section, where the note check would refuse it). Either way the
  // duplicate is refused first.
  it("REFUSES a second [Unreleased] heading hiding an entry, before or after the exact one, in check and in promote", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const noteLines = NOTE.split("\n").length;
    for (const second of [
      "## [Unreleased]",
      " ## [Unreleased]",
      "   ## [unreleased]",
      "## [Unreleased] - more",
      "## [Unreleased",
    ]) {
      const hidden = `${second}\n\n- a hidden entry\n\n`;
      const exact = `## [Unreleased]\n\n${NOTE}\n\n`;
      for (const [where, body, lines] of [
        ["before", hidden + exact, "3, 7"],
        ["after", exact + hidden, `3, ${4 + noteLines + 2}`],
      ] as const) {
        const text = `# Changelog\n\n${body}## [0.0.1] - 2020-01-01\n`;
        writeFileSync(changelogPath, text);
        const label = `${JSON.stringify(second)} ${where}`;
        const msg = `2 [Unreleased] headings (lines ${lines})`;
        expect(() => cf.check({ dir, changelogPath }), label).toThrow(msg);
        expect(
          () => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath }),
          label,
        ).toThrow(msg);
        expect(readFileSync(changelogPath, "utf8")).toBe(text);
        expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
      }
    }
  });

  it("REFUSES when CHANGELOG.md has no [Unreleased] header (cannot skip the stray check)", () => {
    const { dir, changelogPath } = project();
    writeFileSync(changelogPath, `# Changelog\n\n## [0.0.1] - 2020-01-01\n`);
    expect(() => cf.check({ dir, changelogPath })).toThrow(/no '## \[Unreleased\]' heading/);
  });
});

describe("changelog fragments — render + promote (bob#236)", () => {
  it("render groups by Keep a Changelog category order and by filename within a category", () => {
    const { dir } = project();
    fragment(dir, "fixed-b.md", "- **b.** \n");
    fragment(dir, "fixed-a.md", "- **a.** \n");
    fragment(dir, "added-z.md", "- **z.** \n");
    const section = cf.assemble(cf.readFragments(dir));
    expect(section).toBe(
      ["### Added", "", "- **z.**", "", "### Fixed", "", "- **a.**", "", "- **b.**"].join("\n"),
    );
  });

  it("promote writes a dated section in category order and deletes the fragments", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    fragment(dir, "added-b.md", "- **an addition.** \n");
    stageAll();
    const res = cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath });
    expect(res.version).toBe("1.2.3");
    expect(res.date).toBe("2022-01-02");
    expect(res.removed.sort()).toEqual(["added-b.md", "fixed-a.md"]);
    const text = readFileSync(changelogPath, "utf8");
    expect(text).toContain("## [1.2.3] - 2022-01-02");
    expect(text).toContain("### Added\n\n- **an addition.**");
    expect(text).toContain("### Fixed\n\n- **a fix.**");
    // The fragments are gone, and [Unreleased] carries the note again: the
    // result passes `check`.
    expect(cf.readFragments(dir)).toEqual([]);
    expect(text).toContain("Entries for the next release live as **fragment files**");
    expect(cf.check({ dir, changelogPath })).toEqual({ fragments: 0, entries: 0 });
  });

  it("promote REFUSES text other than the managed note under [Unreleased], and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = `# Changelog\n\n## [Unreleased]\n\n${NOTE}\n\nA hand-written paragraph.\n\n## [0.0.1] - 2020-01-01\n`;
    writeFileSync(changelogPath, before);
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
      /promote: '## \[Unreleased\]' holds text other than the managed note/,
    );
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("promote REFUSES a --date that is not a real YYYY-MM-DD, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = readFileSync(changelogPath, "utf8");
    for (const date of ["2022-1-2", "2022-02-30", "", "tomorrow"]) {
      expect(() => cf.promote("1.2.3", { date, dir, changelogPath })).toThrow(/invalid --date/);
    }
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("promote REFUSES a version outside MAJOR.MINOR.PATCH[-pre-release] or with a leading zero, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = readFileSync(changelogPath, "utf8");
    for (const v of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-rc.01",
      "1.2.3+build",
      "1.2.3-",
      "1.2.3-rc..1",
      "v1.2.3",
    ]) {
      expect(() => cf.promote(v, { date: "2022-01-02", dir, changelogPath }), v).toThrow(
        /invalid version/,
      );
    }
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("the version format accepts plain and pre-release versions", () => {
    for (const v of [
      "0.0.0",
      "0.31.0",
      "10.20.30",
      "1.0.0-rc.1",
      "1.2.3-alpha",
      "1.2.3-0",
      "1.2.3-x.7.z.92",
    ]) {
      expect(cf.isReleaseVersion(v), v).toBe(true);
    }
  });

  it("promote REFUSES a version that already has a section, and writes nothing", () => {
    const { dir, changelogPath } = project(); // carries '## [0.0.1] - 2020-01-01'
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = readFileSync(changelogPath, "utf8");
    expect(() => cf.promote("0.0.1", { date: "2022-01-02", dir, changelogPath })).toThrow(
      /already has a '## \[0\.0\.1\]' section \(line \d+\)/,
    );
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("promote REFUSES outside a git work tree, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = readFileSync(changelogPath, "utf8");
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
      /is not in a git work tree/,
    );
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  // git checkout restores from the index: a file that is not there, or differs
  // from it, could not be restored as it was, so promote touches nothing.
  it("promote REFUSES what git could not restore (untracked, or differing from the index), naming each, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    fragment(dir, "fixed-b.md", "- **b fix.** \n");
    stageAll();
    fragment(dir, "fixed-new.md", "- **a new fragment, never staged.** \n");
    fragment(dir, "fixed-b.md", "- **b fix, edited after staging.** \n");
    const before = readFileSync(changelogPath, "utf8");
    const names = () =>
      cf
        .readFragments(dir)
        .map((f) => f.name)
        .sort();
    const tryPromote = () => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath });
    expect(tryPromote).toThrow(
      "untracked (not in the index): fixed-new.md; changed since staged (differs from the index): fixed-b.md",
    );
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(names()).toEqual(["fixed-a.md", "fixed-b.md", "fixed-new.md"]);

    // CHANGELOG.md edited after staging, then CHANGELOG.md not in the index.
    stageAll();
    const edited = `${before}\na local edit in an old section\n`;
    writeFileSync(changelogPath, edited);
    expect(tryPromote).toThrow("changed since staged (differs from the index): CHANGELOG.md");
    expect(readFileSync(changelogPath, "utf8")).toBe(edited);
    stageAll();
    const rm = spawnSync("git", ["rm", "-q", "--cached", "CHANGELOG.md"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(rm.status, rm.stderr).toBe(0);
    expect(tryPromote).toThrow("untracked (not in the index): CHANGELOG.md");
    expect(readFileSync(changelogPath, "utf8")).toBe(edited);
    expect(names()).toEqual(["fixed-a.md", "fixed-b.md", "fixed-new.md"]);
  });

  // Every file is decoded as fatal UTF-8: bytes that are not valid UTF-8 are
  // refused by name, never read as U+FFFD and passed or written back.
  it("REFUSES a fragment that is not valid UTF-8, naming it, in check and in promote, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    writeFileSync(
      join(dir, "fixed-bad-utf8.md"),
      Buffer.concat([Buffer.from("- **OK.** "), Buffer.from([0xff]), Buffer.from("\n")]),
    );
    stageAll();
    const before = readFileSync(changelogPath);
    const msg = ".changelog/unreleased/fixed-bad-utf8.md: not valid UTF-8";
    expect(() => cf.check({ dir, changelogPath })).toThrow(msg);
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(msg);
    expect(readFileSync(changelogPath).equals(before)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["fixed-a.md", "fixed-bad-utf8.md"]);
  });

  it("REFUSES a CHANGELOG.md that is not valid UTF-8, in check and in promote, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const bad = Buffer.concat([readFileSync(changelogPath), Buffer.from([0xff, 0x0a])]);
    writeFileSync(changelogPath, bad);
    stageAll();
    expect(() => cf.check({ dir, changelogPath })).toThrow("CHANGELOG.md: not valid UTF-8");
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
      "CHANGELOG.md: not valid UTF-8",
    );
    expect(readFileSync(changelogPath).equals(bad)).toBe(true);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  // git checkout restores a tracked LINK, not the file it points at, so a
  // CHANGELOG.md that is a symbolic link is refused before any read or write.
  it("REFUSES a CHANGELOG.md that is a tracked symbolic link, in check and in promote, and changes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const external = mkdtempSync(join(tmpdir(), "bob-fragments-ext-"));
    try {
      const target = join(external, "CHANGELOG.md");
      writeFileSync(target, readFileSync(changelogPath));
      rmSync(changelogPath);
      symlinkSync(target, changelogPath);
      stageAll();
      const commit = spawnSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t.dev",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-q",
          "-m",
          "base",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(commit.status, commit.stderr).toBe(0);
      const targetBefore = readFileSync(target);
      const msg = "CHANGELOG.md is a symbolic link";
      expect(() => cf.check({ dir, changelogPath })).toThrow(msg);
      expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(msg);
      expect(readFileSync(target).equals(targetBefore)).toBe(true);
      expect(lstatSync(changelogPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(changelogPath)).toBe(target);
      expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  // A truncating write would change every hard link of CHANGELOG.md, and git
  // checkout restores only this path, so a second link is refused.
  it("REFUSES a CHANGELOG.md with another hard link, in check and in promote, and changes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const other = join(root, "other-link-to-CHANGELOG.md");
    linkSync(changelogPath, other);
    stageAll();
    const before = readFileSync(other);
    const msg = "CHANGELOG.md has 2 hard links";
    expect(() => cf.check({ dir, changelogPath })).toThrow(msg);
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(msg);
    expect(readFileSync(other).equals(before)).toBe(true);
    expect(readFileSync(changelogPath).equals(before)).toBe(true);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("REFUSES a CHANGELOG.md that is not a regular file (a directory), in check and in promote", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    rmSync(changelogPath);
    mkdirSync(changelogPath);
    const msg = "CHANGELOG.md is not a regular file";
    expect(() => cf.check({ dir, changelogPath })).toThrow(msg);
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(msg);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  // The write reopens CHANGELOG.md without following a link and writes only if
  // the file it opened has the same device and inode as the file that was read,
  // so a link or a file with another device or inode swapped in fails.
  it("writeChangelog REFUSES a link swapped in after the read, and writes nothing through it", () => {
    const { changelogPath } = project();
    const read = cf.readChangelog(changelogPath);
    const moved = join(root, "moved-CHANGELOG.md");
    renameSync(changelogPath, moved);
    symlinkSync(moved, changelogPath);
    const before = readFileSync(moved);
    expect(() => cf.writeChangelog(changelogPath, "replaced\n", read)).toThrow(
      "CHANGELOG.md is a symbolic link",
    );
    expect(readFileSync(moved).equals(before)).toBe(true);
  });

  it("writeChangelog REFUSES a different regular file swapped in after the read, and writes nothing", () => {
    const { changelogPath } = project();
    const read = cf.readChangelog(changelogPath);
    renameSync(changelogPath, join(root, "moved-CHANGELOG.md"));
    writeFileSync(changelogPath, "another file\n");
    expect(() => cf.writeChangelog(changelogPath, "replaced\n", read)).toThrow(
      "CHANGELOG.md was replaced after it was read",
    );
    expect(readFileSync(changelogPath, "utf8")).toBe("another file\n");
  });

  // Device and inode are compared as BigInt: as numbers, 2^53 and 2^53+1 are
  // equal, so a different file with an adjacent high inode would pass. Driven
  // through promote's stat seam, the write must refuse before truncating
  // CHANGELOG.md or deleting a fragment.
  it("promote REFUSES a CHANGELOG.md whose inode differs only above 2^53 (2^53 read, 2^53+1 at write), and changes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    stageAll();
    const before = readFileSync(changelogPath);
    let calls = 0;
    const fstat = (fd: number) => {
      const real = fstatSync(fd, { bigint: true });
      calls += 1;
      return {
        isFile: () => real.isFile(),
        nlink: 1n,
        dev: 7n,
        ino: calls === 1 ? 2n ** 53n : 2n ** 53n + 1n,
      };
    };
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath, fstat })).toThrow(
      "CHANGELOG.md was replaced after it was read",
    );
    expect(calls).toBe(2);
    expect(readFileSync(changelogPath).equals(before)).toBe(true);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  // An index flag hides an edit from `git ls-files -m`, so promote also compares
  // each file it would change or delete with its index blob, as git hashes it.
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    it(`promote REFUSES an edit hidden by ${flag}, in a fragment and in CHANGELOG.md, and changes nothing`, () => {
      const { dir, changelogPath } = project();
      const original = "- **a fix.** \n";
      fragment(dir, "fixed-a.md", original);
      stageAll();
      const gitIn = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
      const tryPromote = () => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath });

      // A hidden edit to a fragment.
      expect(gitIn("update-index", flag, ".changelog/unreleased/fixed-a.md").status).toBe(0);
      fragment(dir, "fixed-a.md", "- **a fix, edited behind the index flag.** \n");
      expect(gitIn("ls-files", "-m").stdout).toBe(""); // the flag hides it from ls-files -m
      const changelogBefore = readFileSync(changelogPath);
      const edited = readFileSync(join(dir, "fixed-a.md"));
      expect(tryPromote).toThrow("changed since staged (differs from the index): fixed-a.md");
      expect(readFileSync(changelogPath).equals(changelogBefore)).toBe(true);
      expect(readFileSync(join(dir, "fixed-a.md")).equals(edited)).toBe(true);

      // A hidden edit to CHANGELOG.md, with the fragment back to its staged bytes.
      fragment(dir, "fixed-a.md", original);
      expect(gitIn("update-index", flag, "CHANGELOG.md").status).toBe(0);
      const changelogEdited = Buffer.concat([
        changelogBefore,
        Buffer.from("\na local edit in an old section\n"),
      ]);
      writeFileSync(changelogPath, changelogEdited);
      expect(gitIn("ls-files", "-m").stdout).toBe("");
      expect(tryPromote).toThrow("changed since staged (differs from the index): CHANGELOG.md");
      expect(readFileSync(changelogPath).equals(changelogEdited)).toBe(true);
      expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    });
  }

  // Permission bits do not bind root, so these two cannot fail a write as root.
  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)(
    "promote that cannot write CHANGELOG.md deletes no fragment and says how to recover",
    () => {
      const { dir, changelogPath } = project();
      fragment(dir, "fixed-a.md", "- **a fix.** \n");
      stageAll();
      chmodSync(changelogPath, 0o444);
      try {
        expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
          /could not write CHANGELOG\.md \(EACCES\); no fragment was deleted/,
        );
      } finally {
        chmodSync(changelogPath, 0o644);
      }
      expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    },
  );

  it.skipIf(asRoot)(
    "promote that cannot delete a fragment names it and says how to recover",
    () => {
      const { dir, changelogPath } = project();
      fragment(dir, "fixed-a.md", "- **a fix.** \n");
      stageAll();
      chmodSync(dir, 0o555);
      try {
        expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
          /is written to CHANGELOG\.md, but 1 fragment\(s\) could not be deleted: fixed-a\.md \(EACCES\)/,
        );
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(readFileSync(changelogPath, "utf8")).toContain("## [1.2.3] - 2022-01-02");
    },
  );
});

describe("changelog fragments — the migration (bob#236)", () => {
  // Pinned to fixtures, never the live directory: `promote` empties
  // .changelog/unreleased/ at every release, so a migration test that read it
  // would go red on the release PR. `unreleased-main-fff78d6a.md` is the body
  // of main's [Unreleased] block (its heading excluded) at fff78d6a, the main
  // commit whose entries were migrated, before they moved into fragments;
  // `migrated-bob-236/` is the fragment set made from it, every list entry of
  // that body included.
  const FIXTURES = join(import.meta.dir, "fixtures", "changelog");
  const before = ENTRIES(readFileSync(join(FIXTURES, "unreleased-main-fff78d6a.md"), "utf8"));
  const migrated = cf.readFragments(join(FIXTURES, "migrated-bob-236"));

  // The eleven entries the migration changed, each as EXACT edits of main's text
  // (applied in order, each `from` found exactly once) plus every word that
  // disappears from the entry (`dropped`). Five were changed to pass `check`
  // (fixed-17, fixed-19, added-09, fixed-bob225, fixed-bob228; fixed-19 was also corrected), and six more were
  // corrected because they no longer matched bob's code or the rendered order.
  // Every other entry is main's text unchanged (whitespace at its end aside). A
  // new difference, or a word that vanishes without being listed, fails. That
  // detects unlisted vanished words; it does not prove every fact is preserved (a
  // rewrite that removes no word, such as swapping two names, would pass).
  type Repair = {
    fragment: string;
    was: string;
    why: string;
    edits: [string, string][];
    dropped: string[];
  };
  const REPAIRED: Repair[] = [
    {
      fragment: "fixed-17-bob-loads-the-raw-32-byte.md",
      was: "- **bob loads the raw 32-byte seed key",
      why: "An over-long lede, reshaped; every fact kept.",
      edits: [
        [
          "- **bob loads the raw 32-byte seed key Flair writes (and base64 of it), as well as base64 PKCS8 and PEM, and a malformed key fails with the file, its size and the accepted formats.**",
          "- **bob loads every key shape Flair writes, and a malformed key fails naming the file, its size and the accepted formats.** It accepts the raw 32-byte seed key Flair writes (and base64 of it), as well as base64 PKCS8 and PEM.",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "fixed-19-a-boolean-flag-bob-onboard-s.md",
      was: "- **A boolean flag — ",
      why: "A lede with no closing `**`, reshaped; and parsing `bob run --interactive` is not support for it.",
      edits: [
        [
          "- **A boolean flag — `bob onboard`'s",
          "- **A boolean flag is validated while the command line is parsed, before any command runs.** `bob onboard`'s",
        ],
        [
          "and `bob run`'s `--interactive` — is validated as the command line is parsed, before any command runs: it is on when written bare or as `=true`, off as `=false`, and every other spelling",
          "and `bob run`'s `--interactive`, parse as on when written bare or as `=true` and off as `=false`, and every other spelling",
        ],
        [
          "is a usage error with exit code 2, so a bad spelling never runs the real command and a boolean flag",
          "is a usage error with exit code 2; a bad spelling never runs the real command, and a boolean flag",
        ],
        [
          "keeps `testbot` as the name). (`test/shell/argv.test.ts`",
          "keeps `testbot` as the name). Parsing is not support: `bob run` refuses `--interactive` when it is on, with exit code 2, because its interactive mode does not exist on the embedded-SDK path yet. (`test/shell/argv.test.ts`",
        ],
      ],
      dropped: ["so"],
    },
    {
      fragment: "added-09-the-reachy-capability-jarvis-s3-memory.md",
      was: "- **The `reachy` capability",
      why: "A continuation line indented 3 spaces, re-indented to 2.",
      edits: [["\n   OrgEvent record id is", "\n  OrgEvent record id is"]],
      dropped: [],
    },
    {
      fragment: "fixed-bob225-mid-run-checkpoint-latch-and-doctor-context-window.md",
      was: "- **After a mid-run compaction checkpoint",
      why: "An over-long lede (36 words), reshaped; the text it moved opens the body, and no word is dropped.",
      edits: [
        [
          "- **After a mid-run compaction checkpoint, over-threshold tool turns do not checkpoint again for the same threshold until a valid reading at or below the threshold re-arms the check, and `bob doctor` reports a missing `provider.context_window` (bob#225).**",
          "- **After a mid-run compaction checkpoint, the check does not checkpoint again for that threshold until it re-arms, and `bob doctor` reports a missing `provider.context_window` (bob#225).** Over-threshold tool turns do not checkpoint again for the same threshold until a valid reading at or below the threshold re-arms the check.",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "fixed-bob228-install-service-writes-a-stable-node-path.md",
      was: "- **`bob install-service` run from an interpreter named `node` writes",
      why: 'An over-long lede (33 words, two sentences by the check\'s count: "e.g. " is a break), reshaped; the text it moved opens the body, and no word is dropped.',
      edits: [
        [
          "- **`bob install-service` run from an interpreter named `node` writes that interpreter's own path unless a trusted PATH symlink resolves to the same file, e.g. `/opt/homebrew/bin/node` instead of a versioned Homebrew Cellar path (bob#228).**",
          "- **`bob install-service` run from an interpreter named `node` writes that interpreter's own path unless a trusted PATH symlink resolves to the same file (bob#228).** It writes, e.g., `/opt/homebrew/bin/node` instead of a versioned Homebrew Cellar path.",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "added-07-the-anchored-edit-capability-and-the.md",
      was: "- **The `anchored-edit` capability and the `builder-local` role",
      why: "builder-local holds the `work` run tools, not `bash` (roles/builder-local/role.json).",
      edits: [
        [
          "plus `bash`, `grep`, `find`, `ls` and the flair tools,",
          "plus the `work` capability's `run`, `run_status` and `run_cancel` (it holds no `bash`), `grep`, `find`, `ls` and the flair tools,",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "fixed-04-a-resident-agent-keeps-a-tool.md",
      was: "- **A resident agent keeps a tool only when",
      why: "The resident rule's exception: a role that opts in keeps its writers.",
      edits: [
        [
          "- **A resident agent keeps a tool only when a reviewed classification says it writes no file and runs no command (bob#213).**",
          "- **Unless its role opts in, a resident agent keeps only the tools a reviewed classification says write no file and run no command (bob#213).**",
        ],
        [
          "no longer keeps them; builder-local, the one shipped role that lists them, opts in.",
          "no longer keeps them. A role that sets `tools.allowResidentShell: true` keeps its writers for a resident agent (the agent's `bob.yaml` can turn that off, not on); builder-local, the one shipped role that lists the anchored-edit writers, opts in, and so does coder.",
        ],
      ],
      dropped: ["when"],
    },
    {
      fragment: "changed-09-onboarding-and-alignment-ran-under-a.md",
      was: "- **Onboarding and alignment ran under a FIXED setup policy",
      why: 'render puts Changed before Fixed, so "above" pointed the wrong way.',
      edits: [["(Fixed, above)", "(under Fixed)"]],
      dropped: ["above"],
    },
    {
      fragment: "changed-11-stated-limits-of-the-contract-above.md",
      was: "- **Stated limits of the contract above.**",
      why: '"the contract above" meant the task contract, which renders under Added.',
      edits: [
        [
          "- **Stated limits of the contract above.**",
          "- **Stated limits of the system-prompt task contract (under Added).**",
        ],
      ],
      dropped: ["above"],
    },
    {
      fragment: "changed-06-role-json-is-the-ceiling-on.md",
      was: "- **`role.json` is the ceiling on the tool allowlist",
      why: "`bash`/`write`/`edit` are the coder role's set; builder-local holds `run` and the anchored-edit writers.",
      edits: [
        [
          "the coder role sets it `true`, so a persistent builder keeps `bash`/`write`/`edit` while no `bob.yaml` can grant itself a shell its role does not allow.",
          "the `coder` role sets it `true`, so a persistent agent of the `coder` role keeps `bash`/`write`/`edit` (builder-local sets it too, and keeps `run` and the anchored-edit writers instead), while no `bob.yaml` can grant itself a shell its role does not allow.",
        ],
      ],
      dropped: ["builder"],
    },
    {
      fragment: "changed-10-readme-usage-section-matches-the-cli.md",
      was: "- **README usage section matches the CLI.**",
      why: "The README stopped advertising an interactive `bob run` mode; the CLI parses `--interactive` and refuses it only when it is on.",
      edits: [
        [
          "The usage section no longer names commands or flags the CLI does not have: `bob serve`",
          "The usage section no longer advertises what the CLI does not support: `bob serve`",
        ],
        [
          "`--interactive` (the CLI rejects it),",
          "an interactive `bob run` mode (`bob run` parses `--interactive` but refuses it when it is on),",
        ],
        [
          "and fails if the retired `--interactive` flag appears as a word in a code span or code fence;",
          "and fails if a README code span or code fence holds `--interactive`, bare or as `--interactive=<value>`, as a token split on whitespace and commas, since the interactive `bob run` mode is unsupported;",
        ],
      ],
      dropped: ["appears", "flag", "flags", "have", "retired", "word"],
    },
  ];

  it("render carries every pre-migration list entry unchanged (trailing whitespace aside), except the named repairs, each once", () => {
    const rendered = ENTRIES(cf.assemble(migrated));
    expect(rendered.length).toBe(before.length);
    expect(new Set(rendered).size).toBe(rendered.length);
    const differing = before.filter((e) => !rendered.includes(e));
    // An unnamed difference maps to a string naming the entry, so a failure says
    // which entry it is.
    const named = differing.map(
      (e) => REPAIRED.find((r) => e.startsWith(r.was))?.fragment ?? `differs: ${e.slice(0, 80)}`,
    );
    expect(named.sort()).toEqual(REPAIRED.map((r) => r.fragment).sort());
  });

  it("each repair is exactly its listed edits, and every word it removes is listed", () => {
    const words = (s: string) =>
      new Set(s.toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) ?? []);
    for (const r of REPAIRED) {
      const matches = before.filter((e) => e.startsWith(r.was));
      expect(matches, r.fragment).toHaveLength(1);
      const was = matches[0] ?? "";
      const now = migrated.find((f) => f.name === r.fragment)?.body;
      if (now === undefined) throw new Error(`no fixture copy: ${r.fragment}`);
      let text = was;
      for (const [from, to] of r.edits) {
        expect(text.split(from).length - 1, `${r.fragment}: ${from}`).toBe(1);
        text = text.replace(from, () => to);
      }
      expect(now, r.fragment).toBe(text);
      const kept = words(now);
      const vanished = [...words(was)].filter((w) => !kept.has(w)).sort();
      expect(vanished, r.fragment).toEqual([...r.dropped].sort());
    }
  });

  it("render emits ONE heading per category, in Keep a Changelog order", () => {
    const rendered = cf.assemble(migrated);
    const headings = rendered.split("\n").filter((l) => l.startsWith("### "));
    expect(headings).toEqual([...new Set(headings)]); // no duplicates
    const order = headings.map((h) => h.slice(4).toLowerCase());
    const idx = order.map((c) => cf.CATEGORIES.indexOf(c));
    expect(idx).toEqual([...idx].sort((a, b) => a - b)); // KAC order
  });
});

describe("changelog fragments — the live directory (release-safe)", () => {
  // No count is asserted here: every change adds a fragment and every release
  // empties the directory, and an empty directory passes both assertions.
  it("the live fragment directory passes `check`, and no entry renders twice", () => {
    const res = cf.check();
    expect(res.fragments).toBe(res.entries);
    // Resolving a CHANGELOG.md conflict as a union re-adds entries that already
    // live in fragments; converting those again would print them twice.
    const rendered = ENTRIES(cf.assemble(cf.readFragments()));
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  // A migrated fragment corrected in place must be corrected in its fixture copy
  // too, where the repair is named; after a release none is left to compare.
  it("each live fragment the migration made matches its fixture copy", () => {
    const fixture = new Map(
      cf
        .readFragments(join(import.meta.dir, "fixtures", "changelog", "migrated-bob-236"))
        .map((f) => [f.name, f.body]),
    );
    for (const f of cf.readFragments()) {
      const copy = fixture.get(f.name);
      if (copy !== undefined) expect(f.body, f.name).toBe(copy);
    }
  });
});

describe("changelog fragments — the CLI (bob#236)", () => {
  // The script copied into a temp project: its ROOT is the copy's grandparent,
  // so every command, promote included, acts on the temp project only.
  const SCRIPT = join(import.meta.dir, "..", "scripts", "changelog-fragments.mjs");

  function cli(): {
    run: (...args: string[]) => { code: number; out: string };
    dir: string;
    changelogPath: string;
  } {
    const { dir, changelogPath } = project();
    mkdirSync(join(root, "scripts"));
    const copy = join(root, "scripts", "changelog-fragments.mjs");
    copyFileSync(SCRIPT, copy);
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const run = (...args: string[]) => {
      const r = spawnSync("node", [copy, ...args], { encoding: "utf8" });
      return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    };
    return { run, dir, changelogPath };
  }

  for (const cmd of ["render", "list", "check"]) {
    it(`${cmd} exits 0, and 2 with an argument it does not take`, () => {
      const { run } = cli();
      const good = run(cmd);
      expect(good.code, good.out).toBe(0);
      const bad = run(cmd, "--bogus");
      expect(bad.code, bad.out).toBe(2);
      expect(bad.out).toContain(`${cmd}: unexpected argument(s): --bogus`);
    });
  }

  it("promote exits 2 on an argument it does not take or a repeated --date, and writes nothing", () => {
    const { run, dir, changelogPath } = cli();
    const before = readFileSync(changelogPath, "utf8");
    for (const args of [
      ["1.2.3", "--bogus"],
      ["1.2.3", "--date", "2026-01-01"],
      ["1.2.3", "--date=2026-01-01", "--date=2026-01-02"],
    ]) {
      const r = run("promote", ...args);
      expect(r.code, `${args.join(" ")}: ${r.out}`).toBe(2);
    }
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    stageAll();
    const ok = run("promote", "1.2.3", "--date=2026-01-01");
    expect(ok.code, ok.out).toBe(0);
    expect(readFileSync(changelogPath, "utf8")).toContain("## [1.2.3] - 2026-01-01");
  });

  // The script's entry-point test compares real paths: run through a symlink, it
  // must still run (here: refuse a malformed fragment), not exit 0 doing nothing.
  it("runs through a symlinked path (a malformed fragment still fails check)", () => {
    const { dir } = cli();
    fragment(dir, "fixed-not-a-list.md", "just some prose\n");
    symlinkSync(root, join(root, "link"));
    const viaLink = join(root, "link", "scripts", "changelog-fragments.mjs");
    const r = spawnSync("node", [viaLink, "check"], { encoding: "utf8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("fixed-not-a-list.md: fragment must start with '- '");
  });

  it("an unknown command exits 2", () => {
    const { run } = cli();
    const r = run("publish");
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("unknown command 'publish'");
  });
});

// Acceptance: two PRs whose fragments have DISTINCT filenames merge in either
// order with no changelog conflict. Two real branches in a temp git repo: B merged into A,
// and separately A's original commit merged into B; both fragments must be
// present after each merge. (Two PRs that add the SAME filename with different
// contents can conflict on that file; the README says so.)
describe("changelog fragments — two PRs with distinct fragment filenames (bob#236)", () => {
  function git(cwd: string, ...args: string[]): { code: number; out: string } {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  // Every setup step must succeed; a silently failed step would leave the merges
  // below testing something else.
  function ok(cwd: string, ...args: string[]): void {
    const r = git(cwd, ...args);
    expect(r.code, `git ${args.join(" ")}: ${r.out}`).toBe(0);
  }

  const A = join(".changelog", "unreleased", "fixed-from-a.md");
  const B = join(".changelog", "unreleased", "added-from-b.md");

  function repo(): string {
    const d = join(root, "repo");
    mkdirSync(d, { recursive: true });
    ok(d, "init", "-q", "-b", "main");
    ok(d, "config", "user.email", "t@t.dev");
    ok(d, "config", "user.name", "t");
    ok(d, "config", "commit.gpgsign", "false");
    writeFileSync(join(d, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n${NOTE}\n`);
    mkdirSync(join(d, ".changelog", "unreleased"), { recursive: true });
    writeFileSync(join(d, ".changelog", "unreleased", "README.md"), "# fragments\n");
    ok(d, "add", "-A");
    ok(d, "commit", "-q", "-m", "base");
    return d;
  }

  function bothFragments(d: string): void {
    expect(readFileSync(join(d, A), "utf8")).toBe("- **a.** \n");
    expect(readFileSync(join(d, B), "utf8")).toBe("- **b.** \n");
  }

  it("B merged into A, and A's original commit merged into B: both clean, both fragments present", () => {
    const d = repo();
    ok(d, "checkout", "-q", "-b", "a", "main");
    writeFileSync(join(d, A), "- **a.** \n");
    ok(d, "add", "--", A);
    ok(d, "commit", "-q", "-m", "a");
    ok(d, "checkout", "-q", "-b", "b", "main");
    writeFileSync(join(d, B), "- **b.** \n");
    ok(d, "add", "--", B);
    ok(d, "commit", "-q", "-m", "b");

    // Order 1: B into A, on a branch of its own so `a` keeps its original commit.
    ok(d, "checkout", "-q", "-b", "a-then-b", "a");
    const m1 = git(d, "merge", "--no-edit", "b");
    expect(m1.code, m1.out).toBe(0);
    bothFragments(d);

    // Order 2: A's original commit into B.
    ok(d, "checkout", "-q", "-b", "b-then-a", "b");
    const parents = git(d, "rev-list", "--parents", "-n", "1", "a");
    expect(parents.code, parents.out).toBe(0);
    expect(parents.out.trim().split(" ")).toHaveLength(2); // `a` is still A's one-parent commit
    const m2 = git(d, "merge", "--no-edit", "a");
    expect(m2.code, m2.out).toBe(0);
    bothFragments(d);
  });
});
